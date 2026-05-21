#!/bin/bash
# Create OpenFGA store and upload authorization model.
# Run after starting OpenFGA (docker run or Cloud Run).
#
# Usage: bash scripts/openfga/setup_openfga_store.sh [OPENFGA_URL]
# Default URL: http://localhost:8082

set -e

OPENFGA_URL="${1:-http://localhost:8082}"
MODEL_FILE="$(dirname "$0")/authorization_model.json"

echo "--- OpenFGA Store Setup ---"
echo "URL: $OPENFGA_URL"

# 1. Create store
echo ""
echo "Creating store 'cortex-drive' ..."
STORE_RESPONSE=$(curl -s -X POST "${OPENFGA_URL}/stores" \
  -H "Content-Type: application/json" \
  -d '{"name": "cortex-drive"}')

STORE_ID=$(echo "$STORE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "Store ID: $STORE_ID"

# 2. Upload authorization model
echo ""
echo "Uploading authorization model ..."
MODEL_RESPONSE=$(curl -s -X POST "${OPENFGA_URL}/stores/${STORE_ID}/authorization-models" \
  -H "Content-Type: application/json" \
  -d @"$MODEL_FILE")

MODEL_ID=$(echo "$MODEL_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['authorization_model_id'])")
echo "Model ID: $MODEL_ID"

# 3. Print env vars to add
echo ""
echo "--- Add these to your .env files ---"
echo "OPENFGA_API_URL=${OPENFGA_URL}"
echo "OPENFGA_STORE_ID=${STORE_ID}"
echo "OPENFGA_MODEL_ID=${MODEL_ID}"
echo ""
echo "Done."
