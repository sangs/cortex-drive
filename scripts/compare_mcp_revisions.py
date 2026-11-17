"""Compare a tagged cortex-mcp revision with live, call by call (RV-15; runbook cloud-run-traffic-runbook.md §3.1).

A gateway revision cannot call a tag URL (its ID-token audience is the tag URL → 401), so a candidate MCP is checked
directly: the same stateless JSON-RPC `tools/call` the gateway sends (`callMcpToolHttp`, POST /mcp), with the
operator's own Google identity token and the gateway's identity headers. Prints, per case, the status, node count
and whether the node sets are identical. Values from .env (tenant, owner) are never printed.

Usage: .venv/bin/python scripts/compare_mcp_revisions.py <tag>
Cost: each search embeds its keyword once per URL (OpenAI, well under $0.001 in total).
"""
import json
import os
import subprocess
import sys
import urllib.request

from dotenv import dotenv_values

LIVE_URL = "https://cortex-mcp-isabiovosq-uc.a.run.app"
MCP_PATH = "/mcp"                     # cortex-gateway/index.js MCP_HTTP_PATH
NON_OWNER_ID = "user_rv15_nonowner_test"   # not a real user: Permify returns no grants
TIMEOUT_SECONDS = 120

# (label, user: "owner" | "non_owner", tool, arguments)
CASES = [
    ("podcast search, owner", "owner", "search_enterprise_graph", {"keyword": "graph databases", "domain_intent": "podcast"}),
    ("career search, owner", "owner", "search_enterprise_graph", {"keyword": "Sangeetha Ramadurai", "domain_intent": "career"}),
    ("podcast search, non-owner", "non_owner", "search_enterprise_graph", {"keyword": "graph databases", "domain_intent": "podcast"}),
]


def tag_url(tag: str) -> str:
    return LIVE_URL.replace("https://", f"https://{tag}---")


def call(url: str, token: str, headers: dict, tool: str, args: dict):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}})
    req = urllib.request.Request(url + MCP_PATH, data=body.encode(), method="POST", headers={
        "Content-Type": "application/json", "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {token}", **headers})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as res:
            raw = res.read().decode()
            status = res.status
    except urllib.error.HTTPError as e:
        return e.code, None, e.read().decode()[:120]
    text = json.loads(raw)["result"]["content"][0]["text"]
    payload = json.loads(text, strict=False)
    if isinstance(payload, dict) and payload.get("error"):
        return status, None, str(payload["error"])[:120]
    nodes = payload.get("nodes", []) if isinstance(payload, dict) else []
    return status, sorted(str(n.get("id") or n.get("name")) for n in nodes), None


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    env = dotenv_values(os.path.join(os.path.dirname(__file__), "..", ".env"))
    tenant, owner = env.get("TENANT_ID"), env.get("OWNER_USER_ID")
    if not tenant or not owner:
        print("TENANT_ID and OWNER_USER_ID must be in .env")
        return 2
    token = subprocess.run(["gcloud", "auth", "print-identity-token"], capture_output=True, text=True,
                           check=True).stdout.strip()
    users = {"owner": owner, "non_owner": NON_OWNER_ID}
    candidate = tag_url(sys.argv[1])
    failures = 0
    for label, user, tool, args in CASES:
        headers = {"x-tenant-id": tenant, "x-user-id": users[user]}
        live = call(LIVE_URL, token, headers, tool, args)
        cand = call(candidate, token, headers, tool, args)
        same = live[1] == cand[1] and live[0] == cand[0]
        failures += 0 if (same and cand[2] is None) else 1
        print(f"{label}: live {live[0]} {len(live[1] or [])} nodes{' ERR ' + live[2] if live[2] else ''} | "
              f"candidate {cand[0]} {len(cand[1] or [])} nodes{' ERR ' + cand[2] if cand[2] else ''} | "
              f"{'IDENTICAL' if same else 'DIFFERENT'}")
    print("PASS" if failures == 0 else f"FAIL ({failures})")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
