"""In-band tool errors (S2-90): a Neo4j outage is marked graph_unavailable; every other error is unchanged.

Run: .venv/bin/python -m unittest tests.mcp_server.test_tool_errors
"""
import json
import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

from neo4j.exceptions import ServiceUnavailable, SessionExpired  # noqa: E402

import tool_errors  # noqa: E402


class ToolErrorTest(unittest.TestCase):
    def test_outage_is_marked(self):
        for exc in (ServiceUnavailable("Unable to retrieve routing information"), SessionExpired("gone")):
            out = json.loads(tool_errors.tool_error_json(exc))
            self.assertEqual(out["error_code"], tool_errors.GRAPH_UNAVAILABLE)
            self.assertNotIn("routing", out["error"])   # the driver's text stays in the log, not the result

    def test_other_errors_unchanged(self):
        out = json.loads(tool_errors.tool_error_json(ValueError("bad keyword")))
        self.assertEqual(out, {"error": "bad keyword"})

    def test_code_matches_gateway(self):
        js = open(os.path.join(ROOT, "cortex-gateway", "utils", "user_errors.js")).read()
        self.assertIn(f"const GRAPH_UNAVAILABLE = '{tool_errors.GRAPH_UNAVAILABLE}'", js)
        cfg = json.load(open(os.path.join(ROOT, "cortex-gateway", "config", "user_errors.json")))
        self.assertIn(tool_errors.GRAPH_UNAVAILABLE, cfg["classes"])

    def test_every_tool_wrapper_uses_the_helper(self):
        for name in ("cortex_os_mentalmodel_server_sse.py", "expert_tools.py"):
            src = open(os.path.join(ROOT, "src", "mcp_server", name)).read()
            self.assertNotIn('json.dumps({"error": str(e)})', src, name)
            self.assertIn("from tool_errors import tool_error_json", src, name)


if __name__ == "__main__":
    unittest.main()
