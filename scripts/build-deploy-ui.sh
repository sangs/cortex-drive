#!/bin/bash
# Build and deploy cortex-ui (Next.js frontend) to Cloud Run.
# Usage: source scripts/cloud-env.sh && bash scripts/build-deploy-ui.sh
set -euo pipefail

if [ -z "${REGISTRY:-}" ] || [ -z "${REPO:-}" ] || [ -z "${CLERK_PK:-}" ]; then
    echo "ERROR: REGISTRY, REPO, or CLERK_PK is not set."
    echo "  Run: source scripts/cloud-env.sh  (from project root)"
    echo "  CLERK_PK is read from cortex-chat-ui/.env.local.clerk-prod"
    exit 1
fi

API_DOMAIN="${API_DOMAIN:-https://api.cortex-drive.com}"
APP_DOMAIN="${APP_DOMAIN:-https://app.cortex-drive.com}"

echo "=== cortex-ui: build + deploy ==="
echo "  NEXT_PUBLIC_GATEWAY_URL = ${API_DOMAIN}"

# Build minimal context — public/videos/ is hundreds of MB and must be excluded.
# Next.js Dockerfile uses ARG (not ENV) so build-time vars need --build-arg via cloudbuild.yaml.
BCTX="/tmp/cortex-ui-ctx"
echo "Preparing build context at ${BCTX}..."
rm -rf "$BCTX" && mkdir -p "$BCTX"

rsync -a \
    --exclude='node_modules' \
    --exclude='.next' \
    --exclude='.env*' \
    --exclude='public/videos' \
    "${REPO}/cortex-chat-ui/" "$BCTX/"

echo "Context size: $(du -sh "$BCTX" | cut -f1)"

# Write cloudbuild.yaml with build args (required for ARG-based Dockerfiles)
cat > "$BCTX/cloudbuild.yaml" << EOF
steps:
- name: 'gcr.io/cloud-builders/docker'
  args:
    - 'build'
    - '--build-arg'
    - 'NEXT_PUBLIC_GATEWAY_URL=${API_DOMAIN}'
    - '--build-arg'
    - 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${CLERK_PK}'
    - '-t'
    - '${REGISTRY}/cortex-ui:latest'
    - '.'
images:
- '${REGISTRY}/cortex-ui:latest'
timeout: '1200s'
EOF

# Build (~5 min for Next.js compile)
gcloud builds submit \
    --config "$BCTX/cloudbuild.yaml" \
    --project="${PROJECT_ID}" \
    "$BCTX"

# Deploy
# This string is the full, authoritative plain-env-var set for cortex-ui —
# gcloud run deploy --set-env-vars REPLACES the live set rather than merging with
# it, so anything live but missing from this string is silently dropped on deploy.
NEW_ENV_VARS="NEXT_PUBLIC_GATEWAY_URL=${API_DOMAIN},NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${CLERK_PK}"

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
CURRENT_ENV_JSON=$(gcloud run services describe cortex-ui \
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
    echo "   currently live on cortex-ui, but missing from this script's"
    echo "   NEW_ENV_VARS list (gcloud run deploy --set-env-vars replaces the full"
    echo "   set, it does not merge):"
    echo "$DROPPED_VARS" | sed 's/^/     - /'
    echo ""
    echo "   Add the missing var(s) to NEW_ENV_VARS above, or if dropping them is"
    echo "   intentional, remove them from the live service directly so this"
    echo "   check stops flagging them. To deploy anyway (not recommended):"
    echo "   ALLOW_ENV_VAR_DROP=true bash scripts/build-deploy-ui.sh"
    if [ "${ALLOW_ENV_VAR_DROP:-false}" != "true" ]; then
        exit 1
    fi
    echo "   ALLOW_ENV_VAR_DROP=true set — proceeding despite the drop above."
else
    echo "✓ No env var drift — every live plain env var is accounted for."
fi

gcloud run deploy cortex-ui \
    --image "${REGISTRY}/cortex-ui:latest" \
    --region "${REGION}" \
    --project "${PROJECT_ID}" \
    --allow-unauthenticated \
    --port 3000 \
    --memory 1Gi \
    --min-instances 0 \
    --max-instances 3 \
    --set-env-vars "${NEW_ENV_VARS}" \
    --set-secrets "CLERK_SECRET_KEY=CLERK_SECRET_KEY:latest"

echo ""
echo "✓ cortex-ui deployed"
echo "  Custom domain: ${APP_DOMAIN}"
echo "  Raw URL: $(gcloud run services describe cortex-ui --region="${REGION}" --project="${PROJECT_ID}" --format='value(status.url)')"
