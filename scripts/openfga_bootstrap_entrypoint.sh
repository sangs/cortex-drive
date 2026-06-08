#!/bin/bash
# Entrypoint for the openfga-bootstrap Cloud Run Job.
# Runs inside GCP so it can reach the internal cortex-openfga service.
# 1. Creates OpenFGA store + uploads authorization model
# 2. Runs bootstrap_openfga.py to write all tenant tuples
# 3. Prints STORE_ID and MODEL_ID to stdout (read from logs to store in Secret Manager)
set -euo pipefail

OPENFGA_URL="${OPENFGA_API_URL:-http://localhost:8082}"
TENANT_ID="${TENANT_ID:-}"
OWNER_SUB="${OWNER_USER_ID:-}"
VISIBILITY="${BOOTSTRAP_VISIBILITY:-tenant-wide}"

echo "=== OpenFGA Bootstrap Job ==="
echo "URL: ${OPENFGA_URL}"

# Get OIDC token from GCP metadata server for authenticating to internal Cloud Run service
echo "Fetching OIDC token..."
OIDC_TOKEN=$(curl -sf \
  -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${OPENFGA_URL}" 2>/dev/null || echo "")

if [ -z "$OIDC_TOKEN" ]; then
    echo "WARNING: Could not fetch OIDC token — proceeding without auth (local/dev mode)"
    AUTH_HEADER=""
else
    echo "OIDC token obtained."
    AUTH_HEADER="Authorization: Bearer ${OIDC_TOKEN}"
fi

openfga_curl() {
    if [ -n "$AUTH_HEADER" ]; then
        curl -s -H "$AUTH_HEADER" "$@"
    else
        curl -s "$@"
    fi
}

# --- Step 1: Create store ---
echo ""
echo "Creating OpenFGA store..."
HTTP_STATUS=$(openfga_curl -o /tmp/store_resp.json -w "%{http_code}" \
  -X POST "${OPENFGA_URL}/stores" \
  -H "Content-Type: application/json" \
  -d '{"name": "cortex-drive"}')
echo "HTTP status: ${HTTP_STATUS}"
echo "Response: $(cat /tmp/store_resp.json)"

if [ "$HTTP_STATUS" != "201" ] && [ "$HTTP_STATUS" != "200" ]; then
    echo "ERROR: Failed to create store (HTTP ${HTTP_STATUS})"
    exit 1
fi

STORE_RESP=$(cat /tmp/store_resp.json)
STORE_ID=$(echo "$STORE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "Store ID: ${STORE_ID}"

# --- Step 2: Upload authorization model ---
echo ""
echo "Uploading authorization model..."
MODEL_FILE="/app/scripts/openfga/authorization_model.json"
MODEL_RESP=$(openfga_curl -X POST "${OPENFGA_URL}/stores/${STORE_ID}/authorization-models" \
  -H "Content-Type: application/json" \
  -d @"$MODEL_FILE")
MODEL_ID=$(echo "$MODEL_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['authorization_model_id'])")
echo "Model ID: ${MODEL_ID}"

# --- Step 3: Run bootstrap ---
echo ""
echo "Running bootstrap_openfga.py..."
export OPENFGA_STORE_ID="$STORE_ID"
export OPENFGA_MODEL_ID="$MODEL_ID"
# Pass OIDC token so openfga_utils._get_client() can auth against Cloud Run service
export OPENFGA_API_TOKEN="$OIDC_TOKEN"

python3 /app/scripts/bootstrap_openfga.py \
    --tenant-id "$TENANT_ID" \
    --visibility "$VISIBILITY" \
    --owner-sub "$OWNER_SUB" \
    --openfga-url "$OPENFGA_URL"

# Print IDs clearly at end so they can be read from logs and stored in Secret Manager
echo ""
echo "=== Bootstrap complete — copy these to Secret Manager ==="
echo "OPENFGA_STORE_ID=${STORE_ID}"
echo "OPENFGA_MODEL_ID=${MODEL_ID}"
echo "OPENFGA_API_URL=${OPENFGA_URL}"
