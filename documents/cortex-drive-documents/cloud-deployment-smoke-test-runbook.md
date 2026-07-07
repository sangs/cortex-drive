# CortexDrive — Cloud Deployment Smoke Test Runbook

**Status:** Active  
**Last updated:** 2026-07-06 — Section 6 endpoint names corrected; Sections 7–8 added (public link + pending grant flows)  
**When to use:** After any service redeploy, data wipe, schema reload, or Permify tuple re-run.
Run the full checklist top to bottom. Any failed check is a blocker before marking the deploy done.

Related: `documents/cortex-drive-documents/cloud-run-build-deploy-runbook.md` (how to deploy),
`documents/how-to-google-cloud-operations.md` (proxy setup, logs, Secret Manager).

---

## Frontend Access — Quick Reference

| Mode | URL | Auth | Start command |
|---|---|---|---|
| **Local** | `http://localhost:3000` | Clerk sign-in required | `cd cortex-chat-ui && rm -rf .next && npx next dev` |
| **Production** | `https://app.cortex-drive.com` | Clerk sign-in required | — (Cloud Run, always running) |

Gateway (local): `http://localhost:4000` — the frontend calls this in local mode.  
Gateway (production): `https://api.cortex-drive.com` — baked into the production build at deploy time.

> **AP-8 reminder:** Always `rm -rf .next` before starting the local frontend. Skipping this
> causes stale build artifacts to serve outdated code silently.

---

## Prerequisites

```bash
# 1. Source environment
source scripts/cloud-env.sh

# 2. Obtain a JWT — log in at https://app.cortex-drive.com, open browser DevTools →
#    Application → Cookies or Network tab → find a /query request → copy the
#    Authorization: Bearer <token> value (valid for ~1 hour)
JWT="<paste-token>"

# 3. Start the Permify proxy (needed for auth checks in Section 5)
gcloud run services proxy cortex-permify \
  --region=us-central1 --project=cortex-drive-496915 --port=3476 &
```

---

## 1. Service Health — All 6 Services Ready

```bash
for svc in cortex-ui cortex-gateway cortex-mcp cortex-bento cortex-openfga cortex-permify; do
    STATUS=$(gcloud run services describe "$svc" \
        --region=us-central1 --project=cortex-drive-496915 \
        --format='value(status.conditions[0].status)' 2>&1)
    echo "$svc: $STATUS"
done
```

**Expected:** `True` for all six services. `False` or `Unknown` = cold-start or deploy error —
check logs: `gcloud run services logs read <svc> --region=us-central1 --project=cortex-drive-496915 --limit=30`

---

## 2. Gateway Health and Auth Gate

```bash
GATEWAY="https://api.cortex-drive.com"

# Health check
curl -s "${GATEWAY}/health"
# Expected: {"status":"ok"}

# Auth gate — no token must return 401
curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${GATEWAY}/query" -H "Content-Type: application/json" -d '{"question":"test"}'
# Expected: 401

# CORS header — must be locked to app subdomain
curl -si -X OPTIONS "${GATEWAY}/query" \
  -H "Origin: https://app.cortex-drive.com" \
  -H "Access-Control-Request-Method: POST" | grep access-control-allow-origin
# Expected: access-control-allow-origin: https://app.cortex-drive.com
```

---

## 3. Three Query Patterns (Query Correctness Contract)

These are the three patterns defined in CLAUDE.md that must work correctly at all times.
Run each with a valid JWT.

### Pattern 1 — Single-domain retrieval (podcast)

```bash
curl -s -X POST "${GATEWAY}/query" \
  -H "Authorization: Bearer ${JWT}" \
  -H "Content-Type: application/json" \
  -d '{"question":"Find episodes discussing graph databases","history":[]}' \
  | python3 -m json.tool | grep -E '"domain_signal"|"nodes"|"message"' | head -10
```

**Expected:**
- `"domain_signal": "podcast"`
- `raw_data.nodes` contains `Episode` nodes only — zero `Role`, `Company`, `Project` nodes
- LLM message synthesizes episode titles and guests; no hallucinated URLs
- Gateway log: `[FGA]` line showing node count; no `[GROUNDING]` log lines

### Pattern 2 — Identity map (career)

```bash
curl -s -X POST "${GATEWAY}/query" \
  -H "Authorization: Bearer ${JWT}" \
  -H "Content-Type: application/json" \
  -d '{"question":"Show career map of Sangeetha Ramadurai","history":[]}' \
  | python3 -m json.tool | grep -E '"domain_signal"|"nodes"' | head -5
```

**Expected:**
- `"domain_signal": "career"`
- `raw_data.nodes` contains `Person`, `Company`, `Role`, `Project`, `ThoughtLeadership` nodes
- Zero `Episode`, `Source`, `Chunk` podcast nodes
- Graph has Person anchor at center

### Pattern 3 — Cross-domain bridge

```bash
curl -s -X POST "${GATEWAY}/query" \
  -H "Authorization: Bearer ${JWT}" \
  -H "Content-Type: application/json" \
  -d '{"question":"How did Sangeetha thought leadership influence Cortex-Drive","history":[]}' \
  | python3 -m json.tool | grep -E '"domain_signal"|"virtual_links"' | head -5
```

**Expected:**
- `"domain_signal": "cross_domain"`
- `virtual_links` array non-empty (session-only VIRTUAL_BRIDGE edges)
- LLM message names specific ThoughtLeadership nodes and bridge_summary; states virtual connections
- No `[GROUNDING]` log lines in gateway

---

## 4. Grounding Audit (no hallucinated URLs)

After running any of the three patterns above, check the gateway logs for the grounding flag:

```bash
gcloud run services logs read cortex-gateway \
    --region=us-central1 --project=cortex-drive-496915 --limit=50 \
    | grep "\[GROUNDING\]"
```

**Expected:** no output. Any `[GROUNDING]` line means a URL was stripped — the system
prompt or a tool result is generating URLs not present in the graph. Investigate immediately.

---

## 5. Permify Authorization Checks

Requires the Permify proxy running on port 3476 (started in Prerequisites).

```bash
# These node_id and user_id values are from the live graph.
# Replace with any known owner node + the OWNER_USER_ID from .env if values differ.
NODE_ID="<any-known-node-uuid>"    # e.g. from /api/nodes or a graph query result
OWNER="user_3E07ZZZL4kDTo2vzAgpC1erDxjF"
UNKNOWN_USER="unknown-user-xyz"

# Owner can_view → must return ALLOWED
curl -s -X POST http://localhost:3476/v1/tenants/cortex-drive/permissions/check \
  -H "Content-Type: application/json" \
  -d "{\"metadata\":{\"depth\":5,\"schema_version\":\"\",\"snap_token\":\"\"},
       \"entity\":{\"type\":\"node\",\"id\":\"${NODE_ID}\"},
       \"permission\":\"can_view\",
       \"subject\":{\"type\":\"user\",\"id\":\"${OWNER}\"},
       \"context\":{\"tuples\":[],\"attributes\":[],\"data\":{}}}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('can_view:', d.get('can'))"
# Expected: can_view: CHECK_RESULT_ALLOWED

# Unknown user can_view → must return DENIED
curl -s -X POST http://localhost:3476/v1/tenants/cortex-drive/permissions/check \
  -H "Content-Type: application/json" \
  -d "{\"metadata\":{\"depth\":5,\"schema_version\":\"\",\"snap_token\":\"\"},
       \"entity\":{\"type\":\"node\",\"id\":\"${NODE_ID}\"},
       \"permission\":\"can_view\",
       \"subject\":{\"type\":\"user\",\"id\":\"${UNKNOWN_USER}\"},
       \"context\":{\"tuples\":[],\"attributes\":[],\"data\":{}}}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('can_view:', d.get('can'))"
# Expected: can_view: CHECK_RESULT_DENIED

# LookupEntity — owner must see ~342 nodes
curl -s -X POST http://localhost:3476/v1/tenants/cortex-drive/permissions/lookup-entity \
  -H "Content-Type: application/json" \
  -d "{\"metadata\":{\"depth\":5,\"schema_version\":\"\",\"snap_token\":\"\"},
       \"entity_type\":\"node\",
       \"permission\":\"can_view\",
       \"subject\":{\"type\":\"user\",\"id\":\"${OWNER}\"},
       \"context\":{\"tuples\":[],\"attributes\":[],\"data\":{}}}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('visible nodes:', len(d.get('entity_ids',[])))"
# Expected: visible nodes: 342 (or close — increases as new nodes are ingested)
```

**If checks fail:**
1. Verify proxy is running: `curl -s http://localhost:3476/v1/tenants/cortex-drive/schemas/read -X POST -d '{}'`
2. Check tuple count: see `documents/how-to-google-cloud-operations.md` Step 11-12 re-run instructions
3. If 0 tuples: re-run `bootstrap_parent_tuples.py` and `migrate_openfga_to_permify.py` with proxy active

---

## 6. Named Share Flow End-to-End

Tests the full user-share lifecycle: create → verify Permify access → revoke.

```bash
# Replace with a real node_id from the graph and a second test user's sub
ROOT_NODE="<node-uuid-to-share>"
SHAREE_EMAIL="<email-of-an-existing-cortexdrive-user>"
SHAREE_SUB="user_<another-clerk-sub>"

# Step 1: Resolve email → sub
curl -s "${GATEWAY}/api/user/resolve?email=${SHAREE_EMAIL}" \
  -H "Authorization: Bearer ${JWT}" | python3 -m json.tool
# Expected: {"sub":"user_...","displayName":"...","email":"..."}

# Step 2: Create share grant (correct endpoint: /api/share/user)
curl -s -X POST "${GATEWAY}/api/share/user" \
  -H "Authorization: Bearer ${JWT}" \
  -H "Content-Type: application/json" \
  -d "{\"rootNodeId\":\"${ROOT_NODE}\",\"targetSub\":\"${SHAREE_SUB}\"}" \
  | python3 -m json.tool
# Expected: {"grantId":"...","childNodeIds":[...],"status":"active"}

# Step 3: Verify sharee can_view via Permify (proxy must be running on 3476)
GRANT_ID="<grantId-from-step-2>"
curl -s -X POST http://localhost:3476/v1/tenants/cortex-drive/permissions/check \
  -H "Content-Type: application/json" \
  -d "{\"metadata\":{\"depth\":5,\"schema_version\":\"\",\"snap_token\":\"\"},
       \"entity\":{\"type\":\"node\",\"id\":\"${ROOT_NODE}\"},
       \"permission\":\"can_view\",
       \"subject\":{\"type\":\"user\",\"id\":\"${SHAREE_SUB}\"},
       \"context\":{\"tuples\":[],\"attributes\":[],\"data\":{}}}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('sharee can_view:', d.get('can'))"
# Expected: sharee can_view: CHECK_RESULT_ALLOWED

# Step 4: View grant history for the shared node
curl -s "${GATEWAY}/api/share/history/${ROOT_NODE}" \
  -H "Authorization: Bearer ${JWT}" | python3 -m json.tool | grep -E '"status"|"grant_id"'
# Expected: at least one record with "status":"active"

# Step 5: Revoke
curl -s -X DELETE "${GATEWAY}/api/share/revoke" \
  -H "Authorization: Bearer ${JWT}" \
  -H "Content-Type: application/json" \
  -d "{\"grant_id\":\"${GRANT_ID}\"}" \
  | python3 -m json.tool
# Expected: {"ok":true,"revokedGrantId":"..."}

# Step 6: Verify access is gone
curl -s -X POST http://localhost:3476/v1/tenants/cortex-drive/permissions/check \
  -H "Content-Type: application/json" \
  -d "{\"metadata\":{\"depth\":5,\"schema_version\":\"\",\"snap_token\":\"\"},
       \"entity\":{\"type\":\"node\",\"id\":\"${ROOT_NODE}\"},
       \"permission\":\"can_view\",
       \"subject\":{\"type\":\"user\",\"id\":\"${SHAREE_SUB}\"},
       \"context\":{\"tuples\":[],\"attributes\":[],\"data\":{}}}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('after revoke:', d.get('can'))"
# Expected: after revoke: CHECK_RESULT_DENIED
```

---

## 7. Public Graph Link Smoke Test

Tests the Loom-style anonymous sharing flow. No Permify involvement — token IS the auth.

```bash
# Step 1: Generate a public link (authenticated owner)
# Run a query in the dashboard first to get nodes on the canvas, then click
# "Share Graph" → "Public Link" tab → "Generate Public Link"
# OR via API (requires graph snapshot JSON from a prior query result):
curl -s -X POST "${GATEWAY}/api/share/graph-link" \
  -H "Authorization: Bearer ${JWT}" \
  -H "Content-Type: application/json" \
  -d '{"nodeIds":["<uuid1>","<uuid2>"],"graphData":{"nodes":[{"id":"<uuid1>","name":"Test","type":"Person","description":""}],"links":[]},"title":"Smoke Test Link"}' \
  | python3 -m json.tool
# Expected: {"shareUrl":"https://app.cortex-drive.com/graph-view/<token>","linkId":"..."}

TOKEN="<token-from-shareUrl>"

# Step 2: Fetch the link as anonymous (no auth header)
curl -s "${GATEWAY}/api/share/graph-link/${TOKEN}" | python3 -m json.tool | grep -E '"nodeCount"|"ownerName"'
# Expected: nodeCount matches, ownerName is set, view_count incremented

# Step 3: Open in browser incognito — should show light-theme graph, node labels visible,
# click node → SnapshotPanel with description + neighbor chips + resource links
# Header: "Shared Graph · Cortex-Drive", expiry if set
# Footer: "Read-only view · Sign in · Create account →"

# Step 4: List owner's links
curl -s "${GATEWAY}/api/share/graph-links" \
  -H "Authorization: Bearer ${JWT}" | python3 -m json.tool | grep -E '"status"|"view_count"|"title"'
# Expected: at least one row with status:"active", view_count >= 1

# Step 5: Revoke
LINK_ID="<linkId-from-step-1>"
curl -s -X DELETE "${GATEWAY}/api/share/graph-link/${LINK_ID}" \
  -H "Authorization: Bearer ${JWT}" | python3 -m json.tool
# Expected: {"ok":true}

# Step 6: Confirm link is dead
curl -s -o /dev/null -w "%{http_code}" "${GATEWAY}/api/share/graph-link/${TOKEN}"
# Expected: 404
```

---

## 8. Pending Grant Flow Smoke Test

Tests sharing with an email that has no Cortex-Drive account yet.

```bash
UNREGISTERED_EMAIL="test-pending-$(date +%s)@example.com"

# Step 1: Share a node with the unregistered email
curl -s -X POST "${GATEWAY}/api/share/user" \
  -H "Authorization: Bearer ${JWT}" \
  -H "Content-Type: application/json" \
  -d "{\"rootNodeId\":\"${ROOT_NODE}\",\"pendingEmail\":\"${UNREGISTERED_EMAIL}\"}" \
  | python3 -m json.tool
# Expected: {"pending":true,"grantId":"..."}

# Step 2: Verify pending row exists in DB (via Cloud SQL Auth Proxy)
# PGPASSWORD=<pw> psql -h 127.0.0.1 -p 5433 -U cortex-app-user -d cortexdrive_app \
#   -c "SELECT grant_id, pending_email, status FROM share_grants WHERE pending_email = '${UNREGISTERED_EMAIL}';"
# Expected: 1 row, status = 'pending'

# Step 3: Simulate activation (pull model)
# This is what runs on the user's first authenticated dashboard load.
# Call it manually with a real JWT to test the activation path:
curl -s -X POST "${GATEWAY}/api/auth/activate-pending" \
  -H "Authorization: Bearer ${JWT}" | python3 -m json.tool
# Expected: {"activated":0} (0 because the test email doesn't match JWT user's email)
# For a real end-to-end test: create a Clerk user with UNREGISTERED_EMAIL, get their JWT,
# then call activate-pending with that JWT → expected: {"activated":1}
```

---

## 10. UI Smoke Test (browser)

1. Open `https://app.cortex-drive.com` — landing page loads, no console errors
2. Sign in with Clerk — redirects to `/dashboard`
3. Run Pattern 2 query: *"Show career map of Sangeetha Ramadurai"*
   - Graph canvas renders with nodes (not blank)
   - Person anchor node visible at center
   - Chat message is a career narrative, not a podcast result
4. Click any node — Node Inspector panel slides out from top right
5. Run Pattern 3 query: *"How did Sangeetha's thought leadership influence Cortex-Drive"*
   - Gold dashed VIRTUAL_BRIDGE edges appear in graph
   - Chat message mentions specific ThoughtLeadership nodes

**Blank canvas with data in the chat = AP-4 violation (full graph payload pushed to LLM messages).
Check gateway logs for oversized tool content.**

---

## 11. Gateway Log Patterns Reference

| Log pattern | Meaning |
|---|---|
| `[GATEWAY] Handshake complete. Calling tool: <tool>` | Normal — tool dispatched to MCP |
| `[GATEWAY] SUCCESS: Received tool result for <tool>` | Normal — tool returned data |
| `[FGA] <user> can_view <N> nodes` | Normal — Permify returned node whitelist |
| `[GROUNDING] Stripped URL: <url>` | **Bug** — LLM hallucinated a URL; fix tool results or system prompt |
| `[GUEST-AUTH] Token revoked` | Guest share link was revoked; 403 returned correctly |
| `Failed to connect to SSE: Forbidden` | OIDC auth failure between gateway → MCP; check service account permissions |
| `Failed to connect to SSE: Not Found` | Wrong MCP URL or path; check `MCP_SERVER_URL` env var on gateway |
| `Tool call failed — <tool>: <error>` | MCP tool threw an exception; check cortex-mcp logs |

---

## 12. Known Permify Operational Notes

- Proxy OIDC tokens expire after ~1 hour during long sessions. Restart proxy if 401 errors appear.
- `list_viewable_node_ids` returns 342 nodes as of 2026-07-01. Count increases when new org-tenant nodes are ingested.
- If 0 nodes returned: proxy expired or tuples were wiped. Re-run bootstrap and migration scripts.
- `bootstrap_parent_tuples.py` and `migrate_openfga_to_permify.py` are both idempotent — safe to re-run.
- Active schema version: `d922hd29io6g008ivglg` (stored in `PERMIFY_SCHEMA_VERSION`).
  If schema is reloaded, update this in `scripts/cloud-env.sh` and `.env`.
