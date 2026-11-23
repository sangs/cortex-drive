#!/bin/bash
# Daily maintenance job (S2-50 build 2c, 2026-11-23; design documents/security/offboarding-and-retention-design-2026-11-20.md
# §5 steps 3-4): retention purge (scripts/retention_purge.js), then the orphan sweep (scripts/reconcile_offboarding.js),
# so a missed Clerk webhook is caught within a day instead of at the next deploy.
#
#   source scripts/cloud-env.sh && bash scripts/deploy-maintenance-job.sh
#
# 1. Creates/updates Cloud Run job `cortex-maintenance` from the gateway image (same code, service account, Cloud SQL
#    socket and secrets as the gateway; no new secret).
# 2. Runs it once as a DRY RUN and prints its log (counts only) — nothing is deleted by this step.
# 3. Creates/updates Cloud Scheduler `cortex-maintenance-daily` (default 03:30 UTC) calling the job with --apply.
#    MAINTENANCE_SCHEDULE overrides the cron; SKIP_SCHEDULE=1 stops after step 2.
# The job's service account may run only this job (roles/run.invoker on the job, not the project).
set -euo pipefail
: "${PROJECT_ID:?run: source scripts/cloud-env.sh}" "${REGION:?}" "${REGISTRY:?}" "${GATEWAY_SA:?}" "${CLOUD_SQL_CONN:?}" "${BENTO_URL:?}"
JOB=cortex-maintenance
SCHEDULER_JOB=cortex-maintenance-daily
SCHEDULE="${MAINTENANCE_SCHEDULE:-30 3 * * *}"
IMAGE="${REGISTRY}/cortex-gateway:latest"

echo "=== ${JOB}: deploy from ${IMAGE} ==="
gcloud run jobs deploy "${JOB}" \
    --image "${IMAGE}" \
    --region "${REGION}" \
    --project "${PROJECT_ID}" \
    --service-account "${GATEWAY_SA}" \
    --set-cloudsql-instances "${CLOUD_SQL_CONN}" \
    --command sh \
    --args='-c,node scripts/retention_purge.js $MAINTENANCE_FLAG && node scripts/reconcile_offboarding.js $MAINTENANCE_FLAG' \
    --set-env-vars "NODE_ENV=production,MAINTENANCE_FLAG=--apply,CLOUD_SQL_INSTANCE=${CLOUD_SQL_CONN},DB_NAME=cortexdrive_app,DB_USER=cortex-app-user,BENTO_SERVER_URL=${BENTO_URL},PERMIFY_TENANT_ID=cortex-drive,OWNER_CLERK_SUBS=${OWNER_CLERK_SUBS:-user_3LFIHAyUMoFU4p7J321fqf5mDzo}" \
    --set-secrets "CLERK_SECRET_KEY=CLERK_SECRET_KEY:latest,TENANT_ID=TENANT_ID:latest,OWNER_USER_ID=OWNER_USER_ID:latest,REDIS_URL=REDIS_URL:latest,PERMIFY_API_URL=PERMIFY_API_URL:latest,DB_PASSWORD=CORTEX_APP_DB_PASSWORD:latest" \
    --max-retries 1 \
    --task-timeout 900

echo "=== ${JOB}: dry run (nothing deleted) ==="
EXEC=$(gcloud run jobs execute "${JOB}" --region "${REGION}" --project "${PROJECT_ID}" \
    --update-env-vars MAINTENANCE_FLAG= --wait --format='value(metadata.name)')
echo "execution ${EXEC}"
gcloud logging read "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"${JOB}\" AND labels.\"run.googleapis.com/execution_name\"=\"${EXEC}\"" \
    --project "${PROJECT_ID}" --limit 50 --order asc --format='value(textPayload)' | grep -E '^\[(RETENTION|OFFBOARD-SWEEP)\]' || true

if [ "${SKIP_SCHEDULE:-0}" = "1" ]; then echo "SKIP_SCHEDULE=1 — not scheduling."; exit 0; fi

echo "=== ${SCHEDULER_JOB}: daily at '${SCHEDULE}' UTC ==="
gcloud run jobs add-iam-policy-binding "${JOB}" --region "${REGION}" --project "${PROJECT_ID}" \
    --member "serviceAccount:${GATEWAY_SA}" --role roles/run.invoker >/dev/null
URI="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${JOB}:run"
if gcloud scheduler jobs describe "${SCHEDULER_JOB}" --location "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "${SCHEDULER_JOB}" --location "${REGION}" --project "${PROJECT_ID}" \
        --schedule "${SCHEDULE}" --time-zone UTC --uri "${URI}" --http-method POST \
        --oauth-service-account-email "${GATEWAY_SA}" >/dev/null
else
    gcloud scheduler jobs create http "${SCHEDULER_JOB}" --location "${REGION}" --project "${PROJECT_ID}" \
        --schedule "${SCHEDULE}" --time-zone UTC --uri "${URI}" --http-method POST \
        --oauth-service-account-email "${GATEWAY_SA}" >/dev/null
fi
echo "✓ ${JOB} runs daily at '${SCHEDULE}' UTC (purge, then sweep, with --apply)."
