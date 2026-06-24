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
    --set-secrets "NEO4J_URI=NEO4J_URI:latest,NEO4J_USERNAME=NEO4J_USERNAME:latest,\
NEO4J_PASSWORD=NEO4J_PASSWORD:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest,\
TENANT_ID=TENANT_ID:latest,OWNER_USER_ID=OWNER_USER_ID:latest,\
REDIS_URL=REDIS_URL:latest"

echo ""
echo "✓ cortex-bento deployed (internal ingress)"
echo "  URL: $(gcloud run services describe cortex-bento --region="${REGION}" --project="${PROJECT_ID}" --format='value(status.url)')"
