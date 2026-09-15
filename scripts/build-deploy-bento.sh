#!/bin/bash
# Build and deploy cortex-bento (HTTP server) to Cloud Run.
# Usage: source scripts/cloud-env.sh && bash scripts/build-deploy-bento.sh
set -euo pipefail

if [ -z "${REGISTRY:-}" ] || [ -z "${REPO:-}" ]; then
    echo "ERROR: REGISTRY and REPO are not set."
    echo "  Run: source scripts/cloud-env.sh  (from project root)"
    exit 1
fi

echo "=== cortex-bento: build + deploy ==="

# gcloud builds submit --tag only works with a file named exactly 'Dockerfile'.
# Bento uses Dockerfile.bento — copy to a temp context with the right name.
BCTX="/tmp/cortex-bento-ctx"
echo "Preparing build context at ${BCTX}..."
rm -rf "$BCTX"
rsync -a --exclude='__pycache__' --exclude='*.pyc' \
    "${REPO}/src/mcp_server/" "$BCTX/"

# Rename Dockerfile.bento → Dockerfile (only inside the tmp context)
cp "$BCTX/Dockerfile.bento" "$BCTX/Dockerfile"

echo "Context size: $(du -sh "$BCTX" | cut -f1)"

# Build
gcloud builds submit \
    --tag "${REGISTRY}/cortex-bento:latest" \
    --project="${PROJECT_ID}" \
    "$BCTX"

# Deploy
# This string is the full, authoritative plain-env-var set for cortex-bento —
# gcloud run deploy --set-env-vars REPLACES the live set rather than merging with
# it, so anything live but missing from this string is silently dropped on deploy.
NEW_ENV_VARS="PERMIFY_TENANT_ID=cortex-drive,PERMIFY_MAX_DEPTH=5,PERMIFY_SCHEMA_VERSION=${PERMIFY_SCHEMA_VERSION}"

# --- Env-var drift guard --------------------------------------------------
# Same incident class as cortex-gateway's build-deploy-gateway.sh (2026-09-08):
# a manually-set env var not in this script's hardcoded --set-env-vars list
# gets silently dropped on the next deploy, no error, no warning. This check
# compares the plain (non-secret) env vars currently live on the service
# against NEW_ENV_VARS above, BEFORE deploying, and aborts if this deploy
# would drop anything the operator hasn't accounted for. See
# documents/architecture/phase-glossary-2026-09-08.md (Phase 2 entry) for the
# full incident writeup.
echo "--- Checking for env var drift before deploy..."
CURRENT_ENV_JSON=$(gcloud run services describe cortex-bento \
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
    echo "   currently live on cortex-bento, but missing from this script's"
    echo "   NEW_ENV_VARS list (gcloud run deploy --set-env-vars replaces the full"
    echo "   set, it does not merge):"
    echo "$DROPPED_VARS" | sed 's/^/     - /'
    echo ""
    echo "   Add the missing var(s) to NEW_ENV_VARS above, or if dropping them is"
    echo "   intentional, remove them from the live service directly so this"
    echo "   check stops flagging them. To deploy anyway (not recommended):"
    echo "   ALLOW_ENV_VAR_DROP=true bash scripts/build-deploy-bento.sh"
    if [ "${ALLOW_ENV_VAR_DROP:-false}" != "true" ]; then
        exit 1
    fi
    echo "   ALLOW_ENV_VAR_DROP=true set — proceeding despite the drop above."
else
    echo "✓ No env var drift — every live plain env var is accounted for."
fi

gcloud run deploy cortex-bento \
    --image "${REGISTRY}/cortex-bento:latest" \
    --region "${REGION}" \
    --project "${PROJECT_ID}" \
    --no-allow-unauthenticated \
    --ingress all \
    --port 8080 \
    --memory 512Mi \
    --timeout 600 \
    --min-instances 0 \
    --max-instances 3 \
    --set-env-vars "${NEW_ENV_VARS}" \
    --set-secrets "NEO4J_URI=NEO4J_URI:latest,NEO4J_USERNAME=NEO4J_USERNAME:latest,\
NEO4J_PASSWORD=NEO4J_PASSWORD:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest,\
TENANT_ID=TENANT_ID:latest,OWNER_USER_ID=OWNER_USER_ID:latest,\
REDIS_URL=REDIS_URL:latest,\
PERMIFY_API_URL=PERMIFY_API_URL:latest"

echo ""
echo "✓ cortex-bento deployed (internal ingress)"
echo "  URL: $(gcloud run services describe cortex-bento --region="${REGION}" --project="${PROJECT_ID}" --format='value(status.url)')"
