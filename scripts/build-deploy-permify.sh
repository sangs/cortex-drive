#!/bin/bash
# Deploy cortex-permify (authorization service) to Cloud Run. S2-35, 2026-10-21.
# Usage: source scripts/cloud-env.sh && bash scripts/build-deploy-permify.sh [--check | --migrate-job]
#   --check         run every guard and compare with the live service, but don't deploy.
#   --migrate-job   point job permify-migrate at the same image digest and account (does not run it).
#   CANDIDATE_TAG=<tag>  deploy with no traffic, tag URL only (scripts/deploy-candidate.sh).
#
# Runtime identity: cortex-permify@ (RV-15 part 2, ui-permify-service-accounts-design-2026-11-17.md §4): only the
# PERMIFY_DATABASE_URI secret and the Cloud SQL client. The service and permify-migrate share it.
#
# No build step: the image is the official Permify image copied into the project registry. It is pinned
# by DIGEST (the version running since 2026-10-21), not `latest`, so a redeploy can't silently change the
# Permify version (same reason as the Python version lock, S2-29). To upgrade, change PERMIFY_IMAGE
# deliberately and test.
#
# Replaces the outdated command in documents/how-to-google-cloud-operations.md "Step 6" (which put the
# database URI, password included, in a plain env var and had no connection cap).
set -euo pipefail

if [ -z "${PROJECT_ID:-}" ] || [ -z "${REGION:-}" ]; then
    echo "ERROR: PROJECT_ID and REGION are not set. Run: source scripts/cloud-env.sh  (from project root)"
    exit 1
fi
CHECK_ONLY=false
[ "${1:-}" = "--check" ] && CHECK_ONLY=true
MIGRATE_JOB_ONLY=false
[ "${1:-}" = "--migrate-job" ] && MIGRATE_JOB_ONLY=true

SERVICE="cortex-permify"
PERMIFY_IMAGE="${PERMIFY_IMAGE:-us-central1-docker.pkg.dev/cortex-drive-496915/cortex-images/cortex-permify@sha256:594cc43e7c3d2f3ac6539aeeefa0b964c4036197572e6df9d93cc2993d5e5b27}"
MIGRATE_JOB="permify-migrate"
SERVICE_ACCOUNT="${PERMIFY_SA:?run: source scripts/cloud-env.sh}"
CLOUD_SQL_CONN="${PROJECT_ID}:${REGION}:cortex-openfga-db"

# Connection budget on cortex-openfga-db (S2-32): db-f1-micro allows 25, 3 reserved, 2 admin → 20 for apps.
# Gateway 2 × 5 instances = 10, Permify 4 × 2 = 8 (total 18; OpenFGA decommissioned 2026-10-21, S2-37).
PERMIFY_DB_MAX_CONNECTIONS=4
PERMIFY_MAX_INSTANCES=2
PERMIFY_DB_CONNECTION_BUDGET=8
ARGS="serve,--database-max-connections=${PERMIFY_DB_MAX_CONNECTIONS}"

# Plain env vars (full authoritative set; --set-env-vars replaces the live set) and secrets.
NEW_ENV_VARS="PERMIFY_DATABASE_ENGINE=postgres"
NEW_SECRETS="PERMIFY_DATABASE_URI=PERMIFY_DATABASE_URI:latest"

# --- permify-migrate: same image digest and account as the service (one PERMIFY_IMAGE, two readers) ---------
if [ "$MIGRATE_JOB_ONLY" = true ]; then
    gcloud run jobs update "$MIGRATE_JOB" --image "$PERMIFY_IMAGE" --service-account "$SERVICE_ACCOUNT" \
        --region "$REGION" --project "$PROJECT_ID"
    echo "✓ ${MIGRATE_JOB} now uses ${PERMIFY_IMAGE} as ${SERVICE_ACCOUNT} (not executed)."
    exit 0
fi

# --- Guard 1: connection budget ------------------------------------------------------------------
if [ $((PERMIFY_DB_MAX_CONNECTIONS * PERMIFY_MAX_INSTANCES)) -gt "$PERMIFY_DB_CONNECTION_BUDGET" ]; then
    echo "❌ ABORTING: ${PERMIFY_DB_MAX_CONNECTIONS} connections × ${PERMIFY_MAX_INSTANCES} instances exceeds Permify's budget of ${PERMIFY_DB_CONNECTION_BUDGET} (S2-32)."
    exit 1
fi
echo "✓ Connection budget: ${PERMIFY_DB_MAX_CONNECTIONS} × ${PERMIFY_MAX_INSTANCES} = $((PERMIFY_DB_MAX_CONNECTIONS * PERMIFY_MAX_INSTANCES)) ≤ ${PERMIFY_DB_CONNECTION_BUDGET}."

# --- Guard 2: no credentials in plain env vars (S2-34 lesson) -----------------------------------
if echo "$NEW_ENV_VARS" | grep -qiE "postgres(ql)?://[^,]*:[^,@]+@|PASSWORD="; then
    echo "❌ ABORTING: a plain env var contains a credential. Database URIs and passwords go in --set-secrets."
    exit 1
fi
echo "✓ No credentials in plain env vars."

# --- Guard 3: env-var / secret drift against the live service ------------------------------------
LIVE_JSON=$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT_ID" --format=json 2>/dev/null || echo '{}')
DRIFT=$(echo "$LIVE_JSON" | python3 -c '
import json, sys
live = json.loads(sys.stdin.read() or "{}")
c = (live.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [{}]) or [{}])[0]
env = c.get("env", []) or []
live_plain = {e["name"] for e in env if "value" in e}
live_secret = {e["name"] for e in env if "valueFrom" in e}
new_plain = {kv.split("=", 1)[0] for kv in sys.argv[1].split(",") if kv}
new_secret = {kv.split("=", 1)[0] for kv in sys.argv[2].split(",") if kv}
for n in sorted(live_plain - new_plain): print(f"plain env var {n} is live but not in this script")
for n in sorted(live_secret - new_secret): print(f"secret {n} is live but not in this script")
for n in sorted(live_plain & new_secret): print(f"{n} is a PLAIN env var live; this script deploys it as a secret (good, but confirm the secret exists)")
' "$NEW_ENV_VARS" "$NEW_SECRETS")
if [ -n "$DRIFT" ]; then
    echo "⚠️  Differences from the live service:"; echo "$DRIFT" | sed 's/^/     - /'
    if echo "$DRIFT" | grep -q "is live but not in this script" && [ "${ALLOW_ENV_VAR_DROP:-false}" != "true" ]; then
        echo "❌ ABORTING: this deploy would drop live settings. Add them above, or set ALLOW_ENV_VAR_DROP=true if intended."
        exit 1
    fi
else
    echo "✓ No env-var or secret drift."
fi
LIVE_ARGS=$(echo "$LIVE_JSON" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read() or "{}"); print(",".join(((d.get("spec",{}).get("template",{}).get("spec",{}).get("containers",[{}]) or [{}])[0].get("args") or [])))')
echo "  args live:   ${LIVE_ARGS:-<none>}"
echo "  args deploy: ${ARGS}"

if [ "$CHECK_ONLY" = true ]; then
    echo "✓ --check: all guards passed; nothing deployed."
    exit 0
fi

# Candidate deploy: CANDIDATE_TAG=<tag> → no traffic, tag URL only (shared with the other services).
source "${REPO:?run: source scripts/cloud-env.sh}/scripts/deploy-candidate.sh"

echo "=== ${SERVICE}: deploy ${PERMIFY_IMAGE} ==="
# shellcheck disable=SC2086  # CANDIDATE_FLAGS is intentionally word-split
gcloud run deploy "$SERVICE" ${CANDIDATE_FLAGS} \
    --image "$PERMIFY_IMAGE" \
    --region "$REGION" \
    --project "$PROJECT_ID" \
    --no-allow-unauthenticated \
    --ingress all \
    --service-account "$SERVICE_ACCOUNT" \
    --port 3476 \
    --cpu 1 \
    --memory 512Mi \
    --concurrency 80 \
    --timeout 300 \
    --min-instances 0 \
    --max-instances "$PERMIFY_MAX_INSTANCES" \
    --add-cloudsql-instances "$CLOUD_SQL_CONN" \
    --args "$ARGS" \
    --set-env-vars "$NEW_ENV_VARS" \
    --set-secrets "$NEW_SECRETS"

echo "✓ ${SERVICE} deployed: $(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT_ID" --format='value(status.latestReadyRevisionName)')"
