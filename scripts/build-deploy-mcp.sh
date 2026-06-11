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
    --set-secrets "NEO4J_URI=NEO4J_URI:latest,NEO4J_USERNAME=NEO4J_USERNAME:latest,\
NEO4J_PASSWORD=NEO4J_PASSWORD:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest,\
TENANT_ID=TENANT_ID:latest,OWNER_USER_ID=OWNER_USER_ID:latest,\
OPENFGA_API_URL=OPENFGA_API_URL:latest,\
OPENFGA_STORE_ID=OPENFGA_STORE_ID:latest,\
OPENFGA_MODEL_ID=OPENFGA_MODEL_ID:latest"

echo ""
echo "✓ cortex-mcp deployed (internal ingress)"
echo "  URL: $(gcloud run services describe cortex-mcp --region="${REGION}" --project="${PROJECT_ID}" --format='value(status.url)')"
