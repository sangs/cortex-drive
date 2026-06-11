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

gcloud run deploy cortex-gateway \
    --image "${REGISTRY}/cortex-gateway:latest" \
    --region "${REGION}" \
    --project "${PROJECT_ID}" \
    --allow-unauthenticated \
    --network default \
    --subnet default \
    --vpc-egress all-traffic \
    --port 8080 \
    --memory 512Mi \
    --timeout 600 \
    --min-instances 0 \
    --max-instances 5 \
    --set-env-vars "MCP_SERVER_URL=${MCP_URL},BENTO_SERVER_URL=${BENTO_URL},NODE_ENV=production,ALLOWED_ORIGIN=${APP_DOMAIN}" \
    --set-secrets "OPENAI_API_KEY=OPENAI_API_KEY:latest,CLERK_SECRET_KEY=CLERK_SECRET_KEY:latest,\
TENANT_ID=TENANT_ID:latest,OWNER_USER_ID=OWNER_USER_ID:latest,\
GATEWAY_SHARE_SECRET=GATEWAY_SHARE_SECRET:latest,\
OPENFGA_API_URL=OPENFGA_API_URL:latest,\
OPENFGA_STORE_ID=OPENFGA_STORE_ID:latest,\
OPENFGA_MODEL_ID=OPENFGA_MODEL_ID:latest"

echo ""
echo "✓ cortex-gateway deployed"
echo "  Custom domain: https://api.cortex-drive.com"
echo "  Raw URL: $(gcloud run services describe cortex-gateway --region="${REGION}" --project="${PROJECT_ID}" --format='value(status.url)')"
