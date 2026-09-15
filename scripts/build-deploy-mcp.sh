#!/bin/bash
# Build and deploy cortex-mcp (SSE server) to Cloud Run.
# Usage: source scripts/cloud-env.sh && bash scripts/build-deploy-mcp.sh
set -euo pipefail

if [ -z "${REGISTRY:-}" ] || [ -z "${REPO:-}" ]; then
    echo "ERROR: REGISTRY and REPO are not set."
    echo "  Run: source scripts/cloud-env.sh  (from project root)"
    exit 1
fi

echo "=== cortex-mcp: build + deploy ==="

# Build directly from src/mcp_server — Dockerfile is there, context is small enough.
cd "${REPO}/src/mcp_server"
echo "Submitting build from $(pwd)..."

gcloud builds submit \
    --tag "${REGISTRY}/cortex-mcp:latest" \
    --project="${PROJECT_ID}" \
    .

# Deploy
# This string is the full, authoritative plain-env-var set for cortex-mcp —
# gcloud run deploy --set-env-vars REPLACES the live set rather than merging with
# it, so anything live but missing from this string is silently dropped on deploy.
NEW_ENV_VARS="PERMIFY_TENANT_ID=cortex-drive,PERMIFY_MAX_DEPTH=5,PERMIFY_SCHEMA_VERSION=${PERMIFY_SCHEMA_VERSION},\
ENABLE_SEMANTIC_CANDIDATE_SEARCH=${ENABLE_SEMANTIC_CANDIDATE_SEARCH:-true},\
ENABLE_SEMANTIC_SEARCH_ENTERPRISE_GRAPH=${ENABLE_SEMANTIC_SEARCH_ENTERPRISE_GRAPH:-true}"

# --- Env-var drift guard --------------------------------------------------
# Same incident class as cortex-gateway's build-deploy-gateway.sh (2026-09-08):
# ENABLE_SEMANTIC_CANDIDATE_SEARCH was turned on live via a one-off
# `gcloud run services update --update-env-vars` and was NOT in this script's
# hardcoded --set-env-vars list — the next run of this script would have
# silently dropped it, no error, no warning. This check compares the plain
# (non-secret) env vars currently live on the service against NEW_ENV_VARS
# above, BEFORE deploying, and aborts if this deploy would drop anything the
# operator hasn't accounted for. See
# documents/architecture/phase-glossary-2026-09-08.md (Phase 2 entry) for the
# full incident writeup (found on cortex-gateway; fixed here pre-emptively
# before it happened here too).
echo "--- Checking for env var drift before deploy..."
CURRENT_ENV_JSON=$(gcloud run services describe cortex-mcp \
    --region "${REGION}" --project "${PROJECT_ID}" \
    --format="json(spec.template.spec.containers[0].env)" 2>/dev/null || echo '{}')

DROPPED_VARS=$(echo "$CURRENT_ENV_JSON" | "${REPO}/.venv/bin/python" -c '
import json, sys
current = json.loads(sys.stdin.read() or "{}")
env_list = (current.get("spec", {}).get("template", {}).get("spec", {})
            .get("containers", [{}])[0].get("env", []) or [])
live_plain_names = {e["name"] for e in env_list if "value" in e}  # excludes secrets (valueFrom)
new_names = {kv.split("=", 1)[0] for kv in sys.argv[1].split(",") if kv}
print("\n".join(sorted(live_plain_names - new_names)))
' "$NEW_ENV_VARS")

if [ -n "$DROPPED_VARS" ]; then
    echo "❌ ABORTING: this deploy would silently drop the following env var(s) —"
    echo "   currently live on cortex-mcp, but missing from this script's"
    echo "   NEW_ENV_VARS list (gcloud run deploy --set-env-vars replaces the full"
    echo "   set, it does not merge):"
    echo "$DROPPED_VARS" | sed 's/^/     - /'
    echo ""
    echo "   Add the missing var(s) to NEW_ENV_VARS above, or if dropping them is"
    echo "   intentional, remove them from the live service directly so this"
    echo "   check stops flagging them. To deploy anyway (not recommended):"
    echo "   ALLOW_ENV_VAR_DROP=true bash scripts/build-deploy-mcp.sh"
    if [ "${ALLOW_ENV_VAR_DROP:-false}" != "true" ]; then
        exit 1
    fi
    echo "   ALLOW_ENV_VAR_DROP=true set — proceeding despite the drop above."
else
    echo "✓ No env var drift — every live plain env var is accounted for."
fi

gcloud run deploy cortex-mcp \
    --image "${REGISTRY}/cortex-mcp:latest" \
    --region "${REGION}" \
    --project "${PROJECT_ID}" \
    --no-allow-unauthenticated \
    --ingress all \
    --port 8080 \
    --memory 1Gi \
    --timeout 600 \
    --min-instances 0 \
    --max-instances 3 \
    --set-env-vars "${NEW_ENV_VARS}" \
    --set-secrets "NEO4J_URI=NEO4J_URI:latest,NEO4J_USERNAME=NEO4J_USERNAME:latest,\
NEO4J_PASSWORD=NEO4J_PASSWORD:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest,\
TENANT_ID=TENANT_ID:latest,OWNER_USER_ID=OWNER_USER_ID:latest,\
OPENFGA_API_URL=OPENFGA_API_URL:latest,\
OPENFGA_STORE_ID=OPENFGA_STORE_ID:latest,\
OPENFGA_MODEL_ID=OPENFGA_MODEL_ID:latest,\
REDIS_URL=REDIS_URL:latest,\
PERMIFY_API_URL=PERMIFY_API_URL:latest"

echo ""
echo "✓ cortex-mcp deployed (internal ingress)"
echo "  URL: $(gcloud run services describe cortex-mcp --region="${REGION}" --project="${PROJECT_ID}" --format='value(status.url)')"
