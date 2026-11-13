"""
MCP stateless HTTP transport (2026-11-12).
The SSE transport kept each session in one instance's memory; on Cloud Run with two MCP instances the gateway's
POST /messages could land on the other instance (404 "Could not find session") and wait 60 s. Tool calls now go to
MCP_HTTP_PATH as one self-contained POST. These tests prove:
- a tools/call needs no session and no initialize handshake, and answers plain JSON;
- each request's identity headers reach the tool (contextvars), also with concurrent callers of different identities —
  access control depends on it;
- the SSE routes still exist (fallback, MCP_TRANSPORT=sse);
- the gateway calls the same path (MCP_HTTP_PATH mirrored in cortex-gateway/index.js).

    .venv/bin/python -m unittest tests.mcp_server.test_mcp_stateless_http -v
"""
import json
import os
import re
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))
from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(ROOT, ".env"))

import cortex_os_mentalmodel_server_sse as server  # noqa: E402
from domain_registry import MCP_HTTP_PATH  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402

PROBE_TOOL = "identity_probe_for_test"
ACCEPT = "application/json, text/event-stream"


async def _no_permify(user_id, tenant_id):
    # Allowlist resolution is not under test here; keep the test offline and deterministic.
    return [f"allowed-{user_id}"], "0"


@server.mcp.tool(name=PROBE_TOOL)
async def identity_probe_for_test() -> str:
    import asyncio
    await asyncio.sleep(0.2)  # overlap concurrent calls
    return json.dumps({
        "tenant": server.tenant_id_var.get(),
        "user": server.user_id_var.get(),
        "user_type": server.user_type_var.get(),
        "allowed": server.allowed_ids_var.get(),
    })


def _call(client, tenant, user, user_type, call_id):
    res = client.post(MCP_HTTP_PATH, headers={
        "Content-Type": "application/json", "Accept": ACCEPT,
        "x-tenant-id": tenant, "x-user-id": user, "x-user-type": user_type,
    }, json={"jsonrpc": "2.0", "id": call_id, "method": "tools/call", "params": {"name": PROBE_TOOL, "arguments": {}}})
    assert res.status_code == 200, res.text
    msg = res.json()
    assert msg["id"] == call_id
    return json.loads(msg["result"]["content"][0]["text"])


class StatelessHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._orig = server._resolve_allowed_ids
        server._resolve_allowed_ids = _no_permify
        # One client for the class: the session manager's lifespan may run only once per process (as in production).
        cls.client = TestClient(server.app)
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)
        server._resolve_allowed_ids = cls._orig

    def test_tool_call_without_session_or_handshake(self):
        got = _call(self.client, "tenant-a", "user-a", "org_member", 1)
        self.assertEqual(got, {"tenant": "tenant-a", "user": "user-a", "user_type": "org_member",
                               "allowed": ["allowed-user-a"]})

    def test_concurrent_callers_keep_their_own_identity(self):
        callers = [(f"tenant-{i % 3}", f"user-{i}", "owner" if i == 0 else "org_member") for i in range(12)]
        with ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(lambda a: _call(self.client, *a[1], a[0] + 100), enumerate(callers)))
        for (tenant, user, user_type), got in zip(callers, results):
            self.assertEqual((got["tenant"], got["user"], got["user_type"], got["allowed"]),
                             (tenant, user, user_type, [f"allowed-{user}"]))

    def test_sse_fallback_routes_still_mounted(self):
        paths = {getattr(r, "path", None) for r in server.app.routes}
        self.assertIn("/sse", paths)
        self.assertIn("/messages", paths)
        self.assertIn(MCP_HTTP_PATH, paths)
        self.assertIn("/health", paths)

    def test_gateway_uses_the_same_path_and_defaults_to_http(self):
        src = open(os.path.join(ROOT, "cortex-gateway", "index.js")).read()
        m = re.search(r"const MCP_HTTP_PATH = '([^']+)'", src)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), MCP_HTTP_PATH)
        self.assertIn("(process.env.MCP_TRANSPORT || 'http')", src)


if __name__ == "__main__":
    unittest.main()
