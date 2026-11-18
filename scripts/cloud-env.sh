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
# finops-admin's Google Cloud project (cost data; FinOps S2-83). Not a secret.
export FINOPS_PROJECT="finops-admin-130758"
# Gateway runtime identity (S2-84, documents/architecture/gateway-service-account-design-2026-11-17.md): only the
# 10 gateway secrets, Cloud SQL client and invoker on MCP/Bento/Permify. Never the default Compute account (Editor).
export GATEWAY_SA="cortex-gateway@${PROJECT_ID}.iam.gserviceaccount.com"
# RV-15 part 1 (documents/architecture/mcp-bento-service-accounts-design-2026-11-17.md §4). MCP / Bento: their 8
# secrets + invoker on Permify (MCP also: enqueue on the ingest queue, act as the invoker). The invoker may only run
# the ingest worker job; MCP and the worker queue tasks that run as it (S2-87). Never the default Compute account.
export MCP_SA="cortex-mcp@${PROJECT_ID}.iam.gserviceaccount.com"
export BENTO_SA="cortex-bento@${PROJECT_ID}.iam.gserviceaccount.com"
export INGEST_INVOKER_SA="cortex-ingest-invoker@${PROJECT_ID}.iam.gserviceaccount.com"
# RV-15 part 2 (documents/architecture/ui-permify-service-accounts-design-2026-11-17.md §4): the UI reads only the Clerk
# secret; Permify and permify-migrate read only their database URI secret and use the Cloud SQL client.
export UI_SA="cortex-ui@${PROJECT_ID}.iam.gserviceaccount.com"
export PERMIFY_SA="cortex-permify@${PROJECT_ID}.iam.gserviceaccount.com"
# RV-15 part 3 (documents/architecture/default-account-editor-removal-design-2026-11-17.md): every image build runs as
# cortex-build@ (scripts/build-flags.sh), never the default Compute account.
export BUILD_SA="cortex-build@${PROJECT_ID}.iam.gserviceaccount.com"
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
export DOCUMENT_INGEST_INVOKER_SA="${INGEST_INVOKER_SA}"
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
