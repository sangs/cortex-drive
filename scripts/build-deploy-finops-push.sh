#!/bin/bash
# Deploy the FinOps daily push (Cloud Run JOB cortex-finops-push; design finops-cost-tracking-design-2026-11-16 §4,
# tracker S2-83 release 2).
#
#   source scripts/cloud-env.sh && bash scripts/build-deploy-finops-push.sh                  # job only
#   source scripts/cloud-env.sh && bash scripts/build-deploy-finops-push.sh --with-schedule  # job + daily schedule
#
# - Image: the image cortex-mcp runs now (it contains src/mcp_server/finops_push.py), so deploy cortex-mcp first.
#   No new image, no new dependency. The job runs `python finops_push.py`; cortex-mcp itself is not changed.
# - Identity: cortex-finops-push (no project roles; reader on dataset cortex_usage here, writer on its landing table and
#   jobUser in finops-admin, granted from finops-admin).
# - --with-schedule: Cloud Scheduler runs the job at SCHEDULE (UTC) as cortex-finops-push. Add it only after
#   `gcloud run jobs execute cortex-finops-push --args=finops_push.py,--dry-run` succeeds (finops-admin grants in place).
set -euo pipefail

: "${PROJECT_ID:?run: source scripts/cloud-env.sh}"
: "${REGION:?run: source scripts/cloud-env.sh}"
: "${FINOPS_PROJECT:?run: source scripts/cloud-env.sh}"

JOB_NAME="cortex-finops-push"
PUSH_SA="cortex-finops-push@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_JOB="cortex-finops-push-daily"
SCHEDULE="15 2,14 * * *"     # 02:15 UTC (yesterday complete) + 14:15 UTC catch-up; finops-admin collects every 4 h
TIME_ZONE="Etc/UTC"

IMAGE=$(gcloud run services describe cortex-mcp --region "${REGION}" --project "${PROJECT_ID}" \
    --format='value(spec.template.spec.containers[0].image)')
echo "=== ${JOB_NAME}: image ${IMAGE}"

gcloud run jobs deploy "${JOB_NAME}" \
    --image "${IMAGE}" \
    --command python \
    --args finops_push.py \
    --service-account "${PUSH_SA}" \
    --set-env-vars "USAGE_PROJECT=${PROJECT_ID},FINOPS_PROJECT=${FINOPS_PROJECT}" \
    --tasks 1 \
    --max-retries 1 \
    --task-timeout 300 \
    --memory 512Mi \
    --region "${REGION}" \
    --project "${PROJECT_ID}"

if [[ " $* " == *" --with-schedule "* ]]; then
    gcloud services enable cloudscheduler.googleapis.com --project "${PROJECT_ID}"
    # The push account may start only this job (resource-level grant, nothing project-wide).
    gcloud run jobs add-iam-policy-binding "${JOB_NAME}" --member "serviceAccount:${PUSH_SA}" \
        --role roles/run.invoker --region "${REGION}" --project "${PROJECT_ID}" >/dev/null
    RUN_URI="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${JOB_NAME}:run"
    if gcloud scheduler jobs describe "${SCHEDULER_JOB}" --location "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
        VERB=update
    else
        VERB=create
    fi
    gcloud scheduler jobs "${VERB}" http "${SCHEDULER_JOB}" \
        --schedule "${SCHEDULE}" \
        --time-zone "${TIME_ZONE}" \
        --uri "${RUN_URI}" \
        --http-method POST \
        --oauth-service-account-email "${PUSH_SA}" \
        --location "${REGION}" \
        --project "${PROJECT_ID}"
    echo "=== schedule ${SCHEDULER_JOB}: '${SCHEDULE}' ${TIME_ZONE}"
fi
echo "=== done. Dry run: gcloud run jobs execute ${JOB_NAME} --args=finops_push.py,--dry-run --region ${REGION} --project ${PROJECT_ID} --wait"
