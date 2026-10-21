#!/bin/bash
# Build and deploy the Phase B ingestion worker (Cloud Run JOB cortex-ingest-worker, M3').
# Usage: source scripts/cloud-env.sh && bash scripts/build-deploy-worker.sh
#
# Design: documents/architecture/phase-b-document-ingestion-build-plan-2026-10-01.md (M3', P1/P4/P5).
# Runs as cortex-mcp-worker (P1). cortex-mcp is NOT changed by this script.
# One-time IAM / infrastructure steps are NOT run here (IAM grants are run by the user): see the
# build plan's M3' runbook.
set -euo pipefail

if [ -z "${REGISTRY:-}" ] || [ -z "${REPO:-}" ]; then
    echo "ERROR: REGISTRY and REPO are not set."
    echo "  Run: source scripts/cloud-env.sh  (from project root)"
    exit 1
fi

JOB_NAME="cortex-ingest-worker"
WORKER_SA="cortex-mcp-worker@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE="${REGISTRY}/${JOB_NAME}:latest"

# Full, authoritative plain-env-var set for the job (gcloud --set-env-vars REPLACES the live set).
# WIF identifiers are non-secret (WIF doc task 7): env vars, never secrets.
NEW_ENV_VARS="PERMIFY_TENANT_ID=cortex-drive,PERMIFY_MAX_DEPTH=5,PERMIFY_SCHEMA_VERSION=${PERMIFY_SCHEMA_VERSION},\
ANTHROPIC_FEDERATION_RULE_ID=fdrl_01N1X4hshN918sM4c612aiys,\
ANTHROPIC_ORGANIZATION_ID=dadbadf4-d114-46f7-aeda-7df9ffe82a40,\
ANTHROPIC_SERVICE_ACCOUNT_ID=svac_01CZuaCMKodSs6C83o8R5MUX,\
ANTHROPIC_WORKSPACE_ID=wrkspc_01BWWNZfUikYXfLwu3uCec43,\
DOCLING_ARTIFACTS_PATH=/opt/docling-models"
# Exactly the secrets cortex-mcp-worker was granted (WIF doc task 3), minus OPENFGA_* (OpenFGA decommissioned 2026-10-21).
NEW_SECRETS="NEO4J_URI=NEO4J_URI:latest,NEO4J_USERNAME=NEO4J_USERNAME:latest,NEO4J_PASSWORD=NEO4J_PASSWORD:latest,\
OPENAI_API_KEY=OPENAI_API_KEY:latest,OWNER_USER_ID=OWNER_USER_ID:latest,REDIS_URL=REDIS_URL:latest,\
PERMIFY_API_URL=PERMIFY_API_URL:latest"

# --- Lock/timeout guard: the per-document lock must outlive the job's task timeout ---------------
# Both come from schema_guard.py (single source), so a run can never lose its lock while alive.
read -r TASK_TIMEOUT_SECONDS LOCK_TTL_SECONDS < <(cd "${REPO}/src/mcp_server" && "${REPO}/.venv/bin/python" -c '
from schema_guard import DOCUMENT_INGEST_JOB_TIMEOUT_SECONDS as t, DOCUMENT_INGEST_LOCK_TTL_SECONDS as l; print(t, l)')
if [ "${LOCK_TTL_SECONDS}" -le "${TASK_TIMEOUT_SECONDS}" ]; then
    echo "❌ ABORTING: lock TTL (${LOCK_TTL_SECONDS}s) must exceed the job task timeout (${TASK_TIMEOUT_SECONDS}s)."
    exit 1
fi
echo "✓ Lock TTL ${LOCK_TTL_SECONDS}s > task timeout ${TASK_TIMEOUT_SECONDS}s."

# --- WIF task 9 guard: no static Anthropic key may reach the worker -------------
if echo "${NEW_ENV_VARS},${NEW_SECRETS}" | grep -q "ANTHROPIC_API_KEY"; then
    echo "❌ ABORTING: ANTHROPIC_API_KEY is in this deploy's env vars or secrets. The worker uses WIF only."
    exit 1
fi
LIVE_ENV_JSON=$(gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" --project "${PROJECT_ID}" \
    --format="json(spec.template.spec.template.spec.containers[0].env)" 2>/dev/null || echo '{}')
if echo "$LIVE_ENV_JSON" | grep -q '"ANTHROPIC_API_KEY"'; then
    echo "❌ ABORTING: ANTHROPIC_API_KEY is live on ${JOB_NAME}. Remove it (WIF only) before deploying."
    exit 1
fi
echo "✓ WIF guard: no ANTHROPIC_API_KEY in this deploy or on the live job."

# --- Env-var drift guard (same incident class as build-deploy-mcp.sh) -------------
DROPPED_VARS=$(echo "$LIVE_ENV_JSON" | "${REPO}/.venv/bin/python" -c '
import json, sys
current = json.loads(sys.stdin.read() or "{}")
env_list = (current.get("spec", {}).get("template", {}).get("spec", {}).get("template", {}).get("spec", {})
            .get("containers", [{}])[0].get("env", []) or [])
live_plain_names = {e["name"] for e in env_list if "value" in e}
new_names = {kv.split("=", 1)[0] for kv in sys.argv[1].split(",") if kv}
print("\n".join(sorted(live_plain_names - new_names)))
' "$NEW_ENV_VARS")
if [ -n "$DROPPED_VARS" ]; then
    echo "❌ ABORTING: this deploy would drop env var(s) live on ${JOB_NAME}:"
    echo "$DROPPED_VARS" | sed 's/^/     - /'
    if [ "${ALLOW_ENV_VAR_DROP:-false}" != "true" ]; then exit 1; fi
    echo "   ALLOW_ENV_VAR_DROP=true set — proceeding."
else
    echo "✓ No env var drift."
fi

# --- Build from a staged context: only src/mcp_server (no .env, caches or tests) + prompts/ ---
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/src"
rsync -a --exclude '__pycache__' --exclude '*.pyc' --exclude '.env' --exclude '.env.*' --exclude 'tests/' \
    "${REPO}/src/mcp_server" "$STAGE/src/"
rsync -a "${REPO}/prompts" "$STAGE/"
cat > "$STAGE/cloudbuild.yaml" <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    args: ["build", "-f", "src/mcp_server/Dockerfile.worker", "-t", "${IMAGE}", "."]
images: ["${IMAGE}"]
timeout: 3600s
EOF
echo "=== ${JOB_NAME}: build (staged context $(du -sh "$STAGE" | cut -f1)) ==="
gcloud builds submit "$STAGE" --config "$STAGE/cloudbuild.yaml" --project "${PROJECT_ID}"

echo "=== ${JOB_NAME}: deploy ==="
gcloud run jobs deploy "${JOB_NAME}" \
    --image "${IMAGE}" \
    --region "${REGION}" \
    --project "${PROJECT_ID}" \
    --service-account "${WORKER_SA}" \
    --tasks 1 \
    --max-retries 1 \
    --task-timeout "${TASK_TIMEOUT_SECONDS}s" \
    --cpu 4 \
    --memory 8Gi \
    --set-env-vars "${NEW_ENV_VARS}" \
    --set-secrets "${NEW_SECRETS}"

echo ""
echo "✓ ${JOB_NAME} deployed as ${WORKER_SA}"
echo "  Test-tenant run (M3' verification; never the owner tenant before M5):"
echo "  gcloud run jobs execute ${JOB_NAME} --region ${REGION} --wait \\"
echo "    --update-env-vars '^@^DOCUMENT_TASK={\"uri\":\"<public pdf url>\",\"tenant_id\":\"cortex-test-tenant\",\"owner_id\":\"test-owner\",\"l2\":\"off\"}'"
echo "  (^@^ makes @ the separator, because the JSON contains commas. \"l2\":\"off\" = no Claude calls;"
echo "   \"auto\" or \"batch\" make paid figure-description calls: only with approval.)"
echo "  Collect a figure batch manually (when no queue is configured):"
echo "    --update-env-vars '^@^DOCUMENT_TASK={\"mode\":\"collect\",\"batch_id\":\"<id>\",\"uri\":\"<uri>\",\"tenant_id\":\"cortex-test-tenant\",\"owner_id\":\"test-owner\"}'"
