#!/bin/bash
# Shared by the Cloud Run deploy scripts (gateway, MCP, Bento). Source it, then put ${CANDIDATE_FLAGS} on the
# `gcloud run deploy` line.
#
# CANDIDATE_TAG=<tag> deploys a revision with NO traffic, reachable only at https://<tag>---<service url host>,
# so it can be checked before users see it (2026-10-29; MCP and Bento since RV-15 part 1, 2026-11-17).
# Promote: gcloud run services update-traffic <service> --to-latest --region "$REGION" --project "$PROJECT_ID"
# Remove the tag afterwards: ... update-traffic <service> --remove-tags <tag>
# Runbook: documents/cloud-run-traffic-runbook.md
CANDIDATE_FLAGS=""
if [ -n "${CANDIDATE_TAG:-}" ]; then
    CANDIDATE_FLAGS="--no-traffic --tag ${CANDIDATE_TAG}"
    echo "Candidate deploy: no traffic, tag ${CANDIDATE_TAG}"
fi
