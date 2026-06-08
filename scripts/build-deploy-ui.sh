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
gcloud run deploy cortex-ui \
    --image "${REGISTRY}/cortex-ui:latest" \
    --region "${REGION}" \
    --project "${PROJECT_ID}" \
    --allow-unauthenticated \
    --port 3000 \
    --memory 1Gi \
    --min-instances 0 \
    --max-instances 3 \
    --set-env-vars "NEXT_PUBLIC_GATEWAY_URL=${API_DOMAIN},NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${CLERK_PK}" \
    --set-secrets "CLERK_SECRET_KEY=CLERK_SECRET_KEY:latest"

echo ""
echo "✓ cortex-ui deployed"
echo "  Custom domain: ${APP_DOMAIN}"
echo "  Raw URL: $(gcloud run services describe cortex-ui --region="${REGION}" --project="${PROJECT_ID}" --format='value(status.url)')"
