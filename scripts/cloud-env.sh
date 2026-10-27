#!/bin/bash
# CortexDrive — Cloud environment variables for local CLI use.
#
# Usage (from project root):
#   source scripts/cloud-env.sh
#
# After sourcing, all gcloud / docker build / deploy commands in the
# cloud-run-build-deploy-runbook.md work without substituting values manually.
#
# Safe to commit — no secrets. Sensitive values are read from existing
# gitignored .env files already on this machine.

# ── GCP project config ────────────────────────────────────────────────────────
export PROJECT_ID="cortex-drive-496915"
export REGION="us-central1"
export REGISTRY="us-central1-docker.pkg.dev/${PROJECT_ID}/cortex-images"

# Project root — derived from the location of this script so it works
# regardless of which directory you source it from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export REPO="$(dirname "$SCRIPT_DIR")"

# ── Live Cloud Run service URLs ────────────────────────────────────────────────
export MCP_URL="https://cortex-mcp-isabiovosq-uc.a.run.app"
export BENTO_URL="https://cortex-bento-isabiovosq-uc.a.run.app"
export GATEWAY_URL="https://cortex-gateway-isabiovosq-uc.a.run.app"
export UI_URL="https://cortex-ui-isabiovosq-uc.a.run.app"

# ── Custom domains (use in build args and CORS config) ────────────────────────
export APP_DOMAIN="https://app.cortex-drive.com"
export API_DOMAIN="https://api.cortex-drive.com"

# ── Cloud SQL (shared: Permify + app databases; instance name is historical) ──
export CLOUD_SQL_CONN="${PROJECT_ID}:${REGION}:cortex-openfga-db"

# ── Permify ────────────────────────────────────────────────────────────────────
# Schema version is returned by /schemas/write and required on all /data/write calls.
# Update this value whenever scripts/permify/authorization_schema.perm is reloaded.
# Current version loaded: 2026-06-30
export PERMIFY_SCHEMA_VERSION="d922hd29io6g008ivglg"

# --- Document sources (S2-19; documents/architecture/document-sources-capability-and-operations.md) ---
# One switch for the whole capability. "true" = Add Source → Document, the ingest queue, and document
# questions (search, citations, graph). Switched on 2026-10-27 (user-approved). To switch off, set
# "false" and redeploy cortex-mcp, the worker, cortex-gateway and cortex-ui.
export DOCUMENTS_ENABLED="${DOCUMENTS_ENABLED:-true}"
# Queue settings the MCP server and the worker use to start ingest jobs (worker/enqueue.py).
export DOCUMENT_INGEST_QUEUE="cortex-document-ingest"
export DOCUMENT_INGEST_JOB="cortex-ingest-worker"
export DOCUMENT_INGEST_INVOKER_SA="377406326936-compute@developer.gserviceaccount.com"
if [ "$DOCUMENTS_ENABLED" = "true" ]; then
    export DOCUMENT_INGEST_MODE="cloud_tasks"
    export ENABLE_DOCUMENT_DOMAIN="true"
else
    export DOCUMENT_INGEST_MODE=""
    export ENABLE_DOCUMENT_DOMAIN="false"
fi
# Plain env vars shared by cortex-mcp and the worker (appended to their NEW_ENV_VARS).
export DOCUMENT_ENV_VARS="DOCUMENT_INGEST_MODE=${DOCUMENT_INGEST_MODE},DOCUMENT_INGEST_PROJECT=${PROJECT_ID},DOCUMENT_INGEST_REGION=${REGION},DOCUMENT_INGEST_QUEUE=${DOCUMENT_INGEST_QUEUE},DOCUMENT_INGEST_JOB=${DOCUMENT_INGEST_JOB},DOCUMENT_INGEST_INVOKER_SA=${DOCUMENT_INGEST_INVOKER_SA},ENABLE_DOCUMENT_DOMAIN=${ENABLE_DOCUMENT_DOMAIN}"

# ── Clerk publishable key (read from gitignored clerk-prod env file) ──────────
# Never hardcoded here — sourced from the existing file on this machine.
CLERK_ENV_FILE="${REPO}/cortex-chat-ui/.env.local.clerk-prod"
if [ -f "$CLERK_ENV_FILE" ]; then
    export CLERK_PK
    CLERK_PK=$(grep "^NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=" "$CLERK_ENV_FILE" | cut -d= -f2-)
else
    echo "⚠️  Warning: ${CLERK_ENV_FILE} not found — CLERK_PK not set"
fi

# ── Confirmation ──────────────────────────────────────────────────────────────
echo "✓ CortexDrive cloud env loaded"
echo "  PROJECT_ID  = ${PROJECT_ID}"
echo "  REGISTRY    = ${REGISTRY}"
echo "  REPO        = ${REPO}"
echo "  APP_DOMAIN  = ${APP_DOMAIN}"
echo "  API_DOMAIN  = ${API_DOMAIN}"
echo "  CLERK_PK    = ${CLERK_PK:0:20}..."
