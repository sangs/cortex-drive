#!/bin/bash
# Build and deploy cortex-gateway to Cloud Run.
# Usage: source scripts/cloud-env.sh && bash scripts/build-deploy-gateway.sh
set -euo pipefail

if [ -z "${REGISTRY:-}" ] || [ -z "${REPO:-}" ]; then
    echo "ERROR: REGISTRY and REPO are not set."
    echo "  Run: source scripts/cloud-env.sh  (from project root)"
    exit 1
fi

echo "=== cortex-gateway: build + deploy ==="

# Regenerate entity catalog from Neo4j before building the image.
# The catalog is bundled into the Docker image and loaded at gateway startup for
# Phase E (entity name lookup) of the intent classifier. Non-blocking: if Neo4j
# is unreachable, the previous catalog is used and a warning is printed.
ENTITY_CATALOG_PATH="${REPO}/cortex-gateway/config/entity_catalog.json"
echo "--- Generating entity catalog from Neo4j..."
if "${REPO}/.venv/bin/python" "${REPO}/scripts/generate_entity_catalog.py"; then
    echo "✓ Entity catalog updated"
    # Commit the regenerated catalog locally so the repo's committed copy never
    # silently drifts from what's actually baked into the deployed image — but
    # never push automatically (this script runs manually from whatever branch is
    # checked out; auto-pushing could land on a branch the operator didn't intend).
    if ! git -C "$REPO" diff --quiet -- "$ENTITY_CATALOG_PATH"; then
        git -C "$REPO" add "$ENTITY_CATALOG_PATH"
        git -C "$REPO" commit -m "chore: auto-regenerate entity_catalog.json (pre-deploy)" -- "$ENTITY_CATALOG_PATH"
        echo "✓ entity_catalog.json changed — committed locally on branch $(git -C "$REPO" branch --show-current)."
        echo "  >>> Remember to 'git push' this commit — it was NOT pushed automatically. <<<"
    else
        echo "  (entity_catalog.json unchanged since last commit — nothing to commit)"
    fi
else
    echo "⚠ Entity catalog generation failed — using existing catalog from last deploy"
fi

# Build minimal context — gateway Dockerfile needs cortex-gateway/ + prompts/ as siblings.
# Cannot submit from repo root (full repo too large for Cloud Build upload).
BCTX="/tmp/cortex-gateway-ctx"
echo "Preparing build context at ${BCTX}..."
rm -rf "$BCTX"
mkdir -p "$BCTX/cortex-gateway/config" "$BCTX/cortex-gateway/utils" "$BCTX/prompts"

cp "$REPO/cortex-gateway/Dockerfile"        "$BCTX/"
cp "$REPO/cortex-gateway/package.json"      "$BCTX/cortex-gateway/"
cp "$REPO/cortex-gateway/package-lock.json" "$BCTX/cortex-gateway/"
cp "$REPO/cortex-gateway/index.js"          "$BCTX/cortex-gateway/"
cp "$REPO/cortex-gateway/config/"*          "$BCTX/cortex-gateway/config/"
cp "$REPO/cortex-gateway/utils/"*           "$BCTX/cortex-gateway/utils/"
cp "$REPO/prompts/"*                        "$BCTX/prompts/"

echo "Context size: $(du -sh "$BCTX" | cut -f1)"

# Build
cd "$BCTX"
gcloud builds submit \
    --tag "${REGISTRY}/cortex-gateway:latest" \
    --project="$PROJECT_ID" \
    .

# Deploy
MCP_URL="${MCP_URL:-https://cortex-mcp-isabiovosq-uc.a.run.app}"
BENTO_URL="${BENTO_URL:-https://cortex-bento-isabiovosq-uc.a.run.app}"
APP_DOMAIN="${APP_DOMAIN:-https://app.cortex-drive.com}"

CLOUD_SQL_CONN="cortex-drive-496915:us-central1:cortex-openfga-db"

# This string is the full, authoritative plain-env-var set for cortex-gateway —
# gcloud run deploy --set-env-vars REPLACES the live set rather than merging with
# it, so anything live but missing from this string is silently dropped on deploy.
NEW_ENV_VARS="MCP_SERVER_URL=${MCP_URL},BENTO_SERVER_URL=${BENTO_URL},NODE_ENV=production,ALLOWED_ORIGIN=${APP_DOMAIN},\
CLOUD_SQL_INSTANCE=${CLOUD_SQL_CONN},DB_NAME=cortexdrive_app,DB_USER=cortex-app-user,\
PERMIFY_TENANT_ID=cortex-drive,PERMIFY_MAX_DEPTH=5,PERMIFY_SCHEMA_VERSION=${PERMIFY_SCHEMA_VERSION},\
CLERK_ORG_ID=org_3E0FtIXiFM6DHwXg05sEVvq2mi0,\
ENABLE_SEMANTIC_CANDIDATE_SEARCH=${ENABLE_SEMANTIC_CANDIDATE_SEARCH:-true}"

# --- Env-var drift guard --------------------------------------------------
# Incident 2026-09-08: ENABLE_SEMANTIC_CANDIDATE_SEARCH was turned on live via a
# one-off `gcloud run services update --update-env-vars`, then silently dropped
# by the next run of this script (--set-env-vars replaces, not merges) — no
# error, no warning, just a feature that quietly stopped working. Misdiagnosed
# for two test rounds as an LLM prompt-following bug before the real cause was
# found. This check compares the plain (non-secret) env vars currently live on
# the service against NEW_ENV_VARS above, BEFORE deploying, and aborts if this
# deploy would drop anything the operator hasn't accounted for. See
# documents/architecture/phase-glossary-2026-09-08.md (Phase 2 entry) for the
# full incident writeup.
echo "--- Checking for env var drift before deploy..."
CURRENT_ENV_JSON=$(gcloud run services describe cortex-gateway \
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
    echo "   currently live on cortex-gateway, but missing from this script's"
    echo "   NEW_ENV_VARS list (gcloud run deploy --set-env-vars replaces the full"
    echo "   set, it does not merge):"
    echo "$DROPPED_VARS" | sed 's/^/     - /'
    echo ""
    echo "   Add the missing var(s) to NEW_ENV_VARS above, or if dropping them is"
    echo "   intentional, remove them from the live service directly so this"
    echo "   check stops flagging them. To deploy anyway (not recommended):"
    echo "   ALLOW_ENV_VAR_DROP=true bash scripts/build-deploy-gateway.sh"
    if [ "${ALLOW_ENV_VAR_DROP:-false}" != "true" ]; then
        exit 1
    fi
    echo "   ALLOW_ENV_VAR_DROP=true set — proceeding despite the drop above."
else
    echo "✓ No env var drift — every live plain env var is accounted for."
fi

gcloud run deploy cortex-gateway \
    --image "${REGISTRY}/cortex-gateway:latest" \
    --region "${REGION}" \
    --project "${PROJECT_ID}" \
    --allow-unauthenticated \
    --port 8080 \
    --memory 512Mi \
    --timeout 600 \
    --min-instances 0 \
    --max-instances 5 \
    --add-cloudsql-instances "${CLOUD_SQL_CONN}" \
    --set-env-vars "${NEW_ENV_VARS}" \
    --set-secrets "OPENAI_API_KEY=OPENAI_API_KEY:latest,CLERK_SECRET_KEY=CLERK_SECRET_KEY:latest,\
TENANT_ID=TENANT_ID:latest,OWNER_USER_ID=OWNER_USER_ID:latest,\
GATEWAY_SHARE_SECRET=GATEWAY_SHARE_SECRET:latest,\
OPENFGA_API_URL=OPENFGA_API_URL:latest,\
OPENFGA_STORE_ID=OPENFGA_STORE_ID:latest,\
OPENFGA_MODEL_ID=OPENFGA_MODEL_ID:latest,\
REDIS_URL=REDIS_URL:latest,\
PERMIFY_API_URL=PERMIFY_API_URL:latest,\
DB_PASSWORD=CORTEX_APP_DB_PASSWORD:latest,\
CLERK_WEBHOOK_SECRET=CLERK_WEBHOOK_SECRET:latest,\
RESEND_API_KEY=RESEND_API_KEY:latest"

echo ""
echo "✓ cortex-gateway deployed"
echo "  Custom domain: https://api.cortex-drive.com"
echo "  Raw URL: $(gcloud run services describe cortex-gateway --region="${REGION}" --project="${PROJECT_ID}" --format='value(status.url)')"
