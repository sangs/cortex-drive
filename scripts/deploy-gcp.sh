#!/bin/bash
# =============================================================================
# CortexDrive — Google Cloud Run Deployment Script
# =============================================================================
# Phases 6–9 of cloud-move-implementation-plan-2026-05-14.md
#
# MANUAL GATES (script pauses and waits):
#   GATE 1 — Link billing account in GCP Console
#   GATE 2 — Fill secret values in Google Secret Manager
#   GATE 3 — Add Cloud Run UI URL to Clerk Dashboard allowed origins
#
# Prerequisites:
#   gcloud auth login && gcloud auth configure-docker us-central1-docker.pkg.dev
#   Docker running
#   cortex-gateway/.env present with all secret values
#
# Usage:
#   bash scripts/deploy-gcp.sh
# =============================================================================

set -euo pipefail

# --- CONFIG (non-sensitive) --------------------------------------------------
PROJECT_ID="cortex-drive-496915"
REGION="us-central1"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/cortex-images"
TENANT_ID="org_3E0FtIXiFM6DHwXg05sEVvq2mi0"
OWNER_USER_ID="user_3E07ZZZL4kDTo2vzAgpC1erDxjF"
NEO4J_URI="neo4j+s://2236ba22.databases.neo4j.io"
NEO4J_USERNAME="neo4j"
OPENFGA_DB_INSTANCE="cortex-openfga-db"
OPENFGA_DB_NAME="openfga"
OPENFGA_DB_USER="openfga-user"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_ROOT}/cortex-gateway/.env"

# --- HELPERS -----------------------------------------------------------------
section() { echo ""; echo "=== $1 ==="; }
pause() {
    echo ""
    echo ">>> MANUAL GATE: $1"
    echo "    Press ENTER when done..."
    read -r
}
check_env_var() {
    local val
    val=$(grep -m1 "^${1}=" "${ENV_FILE}" 2>/dev/null | cut -d= -f2-)
    if [ -z "$val" ]; then
        echo "ERROR: ${1} not found in ${ENV_FILE}" >&2
        exit 1
    fi
    echo "$val"
}

# --- PREFLIGHT ---------------------------------------------------------------
section "Preflight checks"

if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: ${ENV_FILE} not found — needed to read secrets for Secret Manager"
    exit 1
fi

command -v gcloud >/dev/null 2>&1 || { echo "ERROR: gcloud not installed"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "ERROR: Docker not running"; exit 1; }

echo "Reading secrets from ${ENV_FILE} ..."
NEO4J_PASSWORD=$(check_env_var "NEO4J_PASSWORD")
OPENAI_API_KEY=$(check_env_var "OPENAI_API_KEY")
CLERK_SECRET_KEY=$(check_env_var "CLERK_SECRET_KEY")
GATEWAY_SHARE_SECRET=$(check_env_var "GATEWAY_SHARE_SECRET")
echo "All required secrets found."

echo "Authenticating with gcloud ..."
gcloud auth print-identity-token > /dev/null 2>&1 || gcloud auth login
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# =============================================================================
# PHASE 6 — GCP Project Setup
# =============================================================================
section "Phase 6.1 — Create GCP project"
if gcloud projects describe "$PROJECT_ID" > /dev/null 2>&1; then
    echo "Project ${PROJECT_ID} already exists — skipping creation."
else
    gcloud projects create "$PROJECT_ID" --name="CortexDrive Production"
    echo "Project created: ${PROJECT_ID}"
fi
gcloud config set project "$PROJECT_ID"

section "Phase 6 — GATE: Link billing account"
echo "  1. Go to https://console.cloud.google.com/billing"
echo "  2. Link billing account to project: ${PROJECT_ID}"
echo "  (Or run: gcloud billing projects link ${PROJECT_ID} --billing-account=YOUR_ACCOUNT_ID)"
pause "Billing account linked to ${PROJECT_ID}"

section "Phase 6.2 — Enable required APIs"
gcloud services enable \
    run.googleapis.com \
    cloudbuild.googleapis.com \
    secretmanager.googleapis.com \
    artifactregistry.googleapis.com \
    sqladmin.googleapis.com \
    --project="$PROJECT_ID"
echo "APIs enabled."

section "Phase 6.3 — Create Artifact Registry"
if gcloud artifacts repositories describe cortex-images \
        --location="$REGION" --project="$PROJECT_ID" > /dev/null 2>&1; then
    echo "Artifact Registry 'cortex-images' already exists — skipping."
else
    gcloud artifacts repositories create cortex-images \
        --repository-format=docker \
        --location="$REGION" \
        --project="$PROJECT_ID"
    echo "Artifact Registry created."
fi

section "Phase 6.4 — Get Compute Service Account"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
echo "Service account: ${SA}"

section "Phase 6.5 — Create Cloud SQL Postgres for OpenFGA"
OPENFGA_DB_PASSWORD=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32)
echo "Generated OpenFGA DB password (save this): ${OPENFGA_DB_PASSWORD}"

if gcloud sql instances describe "$OPENFGA_DB_INSTANCE" \
        --project="$PROJECT_ID" > /dev/null 2>&1; then
    echo "Cloud SQL instance '${OPENFGA_DB_INSTANCE}' already exists — skipping."
else
    gcloud sql instances create "$OPENFGA_DB_INSTANCE" \
        --database-version=POSTGRES_15 \
        --tier=db-f1-micro \
        --region="$REGION" \
        --project="$PROJECT_ID"
    gcloud sql databases create "$OPENFGA_DB_NAME" \
        --instance="$OPENFGA_DB_INSTANCE" \
        --project="$PROJECT_ID"
    gcloud sql users create "$OPENFGA_DB_USER" \
        --instance="$OPENFGA_DB_INSTANCE" \
        --password="$OPENFGA_DB_PASSWORD" \
        --project="$PROJECT_ID"
    echo "Cloud SQL instance created."
fi

CLOUD_SQL_CONN="${PROJECT_ID}:${REGION}:${OPENFGA_DB_INSTANCE}"
OPENFGA_DB_URI="postgresql://${OPENFGA_DB_USER}:${OPENFGA_DB_PASSWORD}@/${OPENFGA_DB_NAME}?host=/cloudsql/${CLOUD_SQL_CONN}"

# =============================================================================
# PHASE 7 — Google Secret Manager
# =============================================================================
section "Phase 7 — Create Secret Manager slots"

store_secret() {
    local name="$1" value="$2"
    if gcloud secrets describe "$name" --project="$PROJECT_ID" > /dev/null 2>&1; then
        echo "  [exists] ${name} — adding new version"
        echo -n "$value" | gcloud secrets versions add "$name" \
            --data-file=- --project="$PROJECT_ID"
    else
        echo "  [create] ${name}"
        echo -n "$value" | gcloud secrets create "$name" \
            --data-file=- --replication-policy="automatic" --project="$PROJECT_ID"
    fi
}

store_secret "OPENAI_API_KEY"       "$OPENAI_API_KEY"
store_secret "CLERK_SECRET_KEY"     "$CLERK_SECRET_KEY"
store_secret "NEO4J_URI"            "$NEO4J_URI"
store_secret "NEO4J_USERNAME"       "$NEO4J_USERNAME"
store_secret "NEO4J_PASSWORD"       "$NEO4J_PASSWORD"
store_secret "TENANT_ID"            "$TENANT_ID"
store_secret "OWNER_USER_ID"        "$OWNER_USER_ID"
store_secret "GATEWAY_SHARE_SECRET" "$GATEWAY_SHARE_SECRET"
store_secret "OPENFGA_DB_PASSWORD"  "$OPENFGA_DB_PASSWORD"
echo "All secrets stored."

section "Phase 7 — Grant Cloud Run SA access to secrets"
for SECRET in OPENAI_API_KEY CLERK_SECRET_KEY NEO4J_URI NEO4J_USERNAME \
              NEO4J_PASSWORD TENANT_ID OWNER_USER_ID GATEWAY_SHARE_SECRET; do
    gcloud secrets add-iam-policy-binding "$SECRET" \
        --member="serviceAccount:${SA}" \
        --role="roles/secretmanager.secretAccessor" \
        --project="$PROJECT_ID" \
        > /dev/null
    echo "  granted: ${SECRET}"
done
echo "IAM bindings set."

# =============================================================================
# PHASE 8 — Cloud Run Deployments (backend-first order)
# =============================================================================

# --- 8.1 OpenFGA (internal) --------------------------------------------------
section "Phase 8.1 — Deploy cortex-openfga (internal)"
gcloud run deploy cortex-openfga \
    --image "openfga/openfga:latest" \
    --region "$REGION" \
    --project "$PROJECT_ID" \
    --no-allow-unauthenticated \
    --ingress internal \
    --port 8080 \
    --memory 512Mi \
    --min-instances 0 \
    --max-instances 2 \
    --add-cloudsql-instances "$CLOUD_SQL_CONN" \
    --set-env-vars "OPENFGA_DATASTORE_ENGINE=postgres,OPENFGA_DATASTORE_URI=${OPENFGA_DB_URI}"

OPENFGA_URL=$(gcloud run services describe cortex-openfga \
    --region "$REGION" --project "$PROJECT_ID" --format='value(status.url)')
echo "OpenFGA URL: ${OPENFGA_URL}"

section "Phase 8.1b — Bootstrap OpenFGA with Neo4j nodes"
(
    cd "$REPO_ROOT"
    .venv/bin/python scripts/bootstrap_openfga.py \
        --tenant-id "$TENANT_ID" \
        --visibility tenant-wide \
        --owner-sub "$OWNER_USER_ID" \
        --openfga-url "$OPENFGA_URL"
)
echo "OpenFGA bootstrap complete."

# --- 8.2 MCP SSE Server (internal) ------------------------------------------
section "Phase 8.2 — Build + deploy cortex-mcp (internal)"
(
    cd "${REPO_ROOT}/src/mcp_server"
    gcloud builds submit \
        --tag "${REGISTRY}/cortex-mcp:latest" \
        --project "$PROJECT_ID" \
        .
)
gcloud run deploy cortex-mcp \
    --image "${REGISTRY}/cortex-mcp:latest" \
    --region "$REGION" \
    --project "$PROJECT_ID" \
    --no-allow-unauthenticated \
    --ingress internal \
    --port 8080 \
    --memory 1Gi \
    --timeout 600 \
    --min-instances 0 \
    --max-instances 3 \
    --set-secrets "NEO4J_URI=NEO4J_URI:latest,NEO4J_USERNAME=NEO4J_USERNAME:latest,\
NEO4J_PASSWORD=NEO4J_PASSWORD:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest,\
TENANT_ID=TENANT_ID:latest,OWNER_USER_ID=OWNER_USER_ID:latest"

MCP_URL=$(gcloud run services describe cortex-mcp \
    --region "$REGION" --project "$PROJECT_ID" --format='value(status.url)')
echo "MCP URL: ${MCP_URL}"

# --- 8.3 Bento Server (internal) ---------------------------------------------
section "Phase 8.3 — Build + deploy cortex-bento (internal)"
(
    cd "$REPO_ROOT"
    gcloud builds submit \
        --tag "${REGISTRY}/cortex-bento:latest" \
        --project "$PROJECT_ID" \
        -f src/mcp_server/Dockerfile.bento \
        src/mcp_server/
)
gcloud run deploy cortex-bento \
    --image "${REGISTRY}/cortex-bento:latest" \
    --region "$REGION" \
    --project "$PROJECT_ID" \
    --no-allow-unauthenticated \
    --ingress internal \
    --port 8080 \
    --memory 512Mi \
    --timeout 600 \
    --min-instances 0 \
    --max-instances 3 \
    --set-secrets "NEO4J_URI=NEO4J_URI:latest,NEO4J_USERNAME=NEO4J_USERNAME:latest,\
NEO4J_PASSWORD=NEO4J_PASSWORD:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest,\
TENANT_ID=TENANT_ID:latest,OWNER_USER_ID=OWNER_USER_ID:latest"

BENTO_URL=$(gcloud run services describe cortex-bento \
    --region "$REGION" --project "$PROJECT_ID" --format='value(status.url)')
echo "Bento URL: ${BENTO_URL}"

# --- 8.4 Grant gateway SA invoker rights on internal services ----------------
section "Phase 8.4 — Grant gateway SA roles/run.invoker on internal services"
for SERVICE in cortex-mcp cortex-bento cortex-openfga; do
    gcloud run services add-iam-policy-binding "$SERVICE" \
        --region "$REGION" \
        --project "$PROJECT_ID" \
        --member "serviceAccount:${SA}" \
        --role "roles/run.invoker" \
        > /dev/null
    echo "  granted invoker: ${SERVICE}"
done

# Get OpenFGA store + model IDs from the deployed instance
section "Phase 8.4b — Configure OpenFGA store/model IDs in Secret Manager"
echo "Fetching OpenFGA store ID from deployed instance ..."
STORE_RESP=$(curl -s "${OPENFGA_URL}/stores")
OPENFGA_STORE_ID=$(echo "$STORE_RESP" | python3 -c \
    "import sys,json; stores=json.load(sys.stdin).get('stores',[]); print(stores[0]['id'] if stores else '')")
echo "  Store ID: ${OPENFGA_STORE_ID}"

MODEL_RESP=$(curl -s "${OPENFGA_URL}/stores/${OPENFGA_STORE_ID}/authorization-models")
OPENFGA_MODEL_ID=$(echo "$MODEL_RESP" | python3 -c \
    "import sys,json; models=json.load(sys.stdin).get('authorization_models',[]); print(models[0]['id'] if models else '')")
echo "  Model ID: ${OPENFGA_MODEL_ID}"

store_secret "OPENFGA_API_URL"   "$OPENFGA_URL"
store_secret "OPENFGA_STORE_ID"  "$OPENFGA_STORE_ID"
store_secret "OPENFGA_MODEL_ID"  "$OPENFGA_MODEL_ID"
gcloud secrets add-iam-policy-binding "OPENFGA_API_URL" \
    --member="serviceAccount:${SA}" --role="roles/secretmanager.secretAccessor" \
    --project="$PROJECT_ID" > /dev/null
gcloud secrets add-iam-policy-binding "OPENFGA_STORE_ID" \
    --member="serviceAccount:${SA}" --role="roles/secretmanager.secretAccessor" \
    --project="$PROJECT_ID" > /dev/null
gcloud secrets add-iam-policy-binding "OPENFGA_MODEL_ID" \
    --member="serviceAccount:${SA}" --role="roles/secretmanager.secretAccessor" \
    --project="$PROJECT_ID" > /dev/null

# --- 8.5 Gateway (public) ----------------------------------------------------
section "Phase 8.5 — Build + deploy cortex-gateway (public)"
(
    cd "${REPO_ROOT}/cortex-gateway"
    gcloud builds submit \
        --tag "${REGISTRY}/cortex-gateway:latest" \
        --project "$PROJECT_ID" \
        .
)
gcloud run deploy cortex-gateway \
    --image "${REGISTRY}/cortex-gateway:latest" \
    --region "$REGION" \
    --project "$PROJECT_ID" \
    --allow-unauthenticated \
    --port 8080 \
    --memory 512Mi \
    --timeout 600 \
    --min-instances 0 \
    --max-instances 5 \
    --set-env-vars "MCP_SERVER_URL=${MCP_URL},BENTO_SERVER_URL=${BENTO_URL},NODE_ENV=production,ALLOWED_ORIGIN=https://app.cortex-drive.com" \
    --set-secrets "OPENAI_API_KEY=OPENAI_API_KEY:latest,CLERK_SECRET_KEY=CLERK_SECRET_KEY:latest,\
TENANT_ID=TENANT_ID:latest,OWNER_USER_ID=OWNER_USER_ID:latest,\
GATEWAY_SHARE_SECRET=GATEWAY_SHARE_SECRET:latest,\
OPENFGA_API_URL=OPENFGA_API_URL:latest,\
OPENFGA_STORE_ID=OPENFGA_STORE_ID:latest,\
OPENFGA_MODEL_ID=OPENFGA_MODEL_ID:latest"

GATEWAY_URL=$(gcloud run services describe cortex-gateway \
    --region "$REGION" --project "$PROJECT_ID" --format='value(status.url)')
echo "Gateway URL: ${GATEWAY_URL}"

# --- 8.6 Frontend (public) ---------------------------------------------------
section "Phase 8.6 — Build + deploy cortex-ui (public)"

# Read frontend Clerk publishable key
CLERK_PK=$(grep -m1 "^NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=" \
    "${REPO_ROOT}/cortex-chat-ui/.env.local.clerk-prod" 2>/dev/null | cut -d= -f2- || true)
if [ -z "$CLERK_PK" ]; then
    echo "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY not found in cortex-chat-ui/.env.local.clerk-prod"
    echo -n "Enter your Clerk publishable key (pk_live_...): "
    read -r CLERK_PK
fi

(
    cd "${REPO_ROOT}/cortex-chat-ui"
    gcloud builds submit \
        --tag "${REGISTRY}/cortex-ui:latest" \
        --project "$PROJECT_ID" \
        .
)
gcloud run deploy cortex-ui \
    --image "${REGISTRY}/cortex-ui:latest" \
    --region "$REGION" \
    --project "$PROJECT_ID" \
    --allow-unauthenticated \
    --port 3000 \
    --memory 1Gi \
    --min-instances 0 \
    --max-instances 3 \
    --set-env-vars "NEXT_PUBLIC_GATEWAY_URL=https://api.cortex-drive.com,NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${CLERK_PK}" \
    --set-secrets "CLERK_SECRET_KEY=CLERK_SECRET_KEY:latest"

UI_URL=$(gcloud run services describe cortex-ui \
    --region "$REGION" --project "$PROJECT_ID" --format='value(status.url)')
echo "UI URL: ${UI_URL}"

# --- 8.7 Clerk manual gate ---------------------------------------------------
section "Phase 8 — GATE: Custom domains + Clerk Dashboard"
echo "  1. Cloud Run → cortex-ui → Custom domains → Add: app.cortex-drive.com → copy CNAME"
echo "  2. Cloud Run → cortex-gateway → Custom domains → Add: api.cortex-drive.com → copy CNAME"
echo "  3. DNS provider: add both CNAME records → SSL auto-provisions in ~5 min"
echo "  4. Clerk Dashboard → Home URL → https://app.cortex-drive.com → Save"
echo "  (Raw Cloud Run URLs for reference: UI=${UI_URL}  GW=${GATEWAY_URL})"
pause "Clerk domains and redirect URLs updated"

# =============================================================================
# PHASE 9 — AP-12 Smoke Tests
# =============================================================================
section "Phase 9 — Smoke tests against Cloud Run"

echo ""
echo "Health check ..."
curl -sf "${GATEWAY_URL}/health" | python3 -c "import sys,json; d=json.load(sys.stdin); print('  health:', d)"

echo ""
echo "Auth gate (expect 401) ..."
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${GATEWAY_URL}/query" \
    -H "Content-Type: application/json" \
    -d '{"question":"test"}')
if [ "$STATUS" = "401" ]; then
    echo "  PASS — 401 Unauthorized (no JWT)"
else
    echo "  FAIL — expected 401, got ${STATUS}"
fi

echo ""
echo ">>> To run Q1/Q2/Q3 smoke tests, get a valid Clerk JWT:"
echo "    1. Open ${UI_URL} and log in"
echo "    2. DevTools → Network → any /query request → copy Authorization: Bearer <token>"
echo "    3. Run:"
echo ""
cat <<SMOKE
JWT="<paste-token-here>"

# Q1 — podcast
curl -X POST ${GATEWAY_URL}/query \\
  -H "Authorization: Bearer \$JWT" -H "Content-Type: application/json" \\
  -d '{"question":"Find episodes discussing graph databases","history":[]}'

# Q2 — career
curl -X POST ${GATEWAY_URL}/query \\
  -H "Authorization: Bearer \$JWT" -H "Content-Type: application/json" \\
  -d '{"question":"Show career map of Sangeetha Ramadurai","history":[]}'

# Q3 — cross-domain
curl -X POST ${GATEWAY_URL}/query \\
  -H "Authorization: Bearer \$JWT" -H "Content-Type: application/json" \\
  -d '{"question":"How did Sangeetha thought leadership influence Cortex-Drive?","history":[]}'
SMOKE

echo ""
echo "Check for grounding violations in Cloud Run logs:"
echo "  gcloud logging read \"resource.type=cloud_run_revision AND textPayload:GROUNDING\" --project=${PROJECT_ID} --limit=20"

# =============================================================================
# SUMMARY
# =============================================================================
section "Deployment Complete"
echo ""
echo "  OpenFGA:  ${OPENFGA_URL}"
echo "  MCP:      ${MCP_URL}"
echo "  Bento:    ${BENTO_URL}"
echo "  Gateway:  ${GATEWAY_URL}"
echo "  UI:       ${UI_URL}"
echo ""
echo "Local dev: no changes needed — manage_all.sh still works as before."
echo "  Set NEXT_PUBLIC_GATEWAY_URL=http://localhost:4000 for local frontend."
