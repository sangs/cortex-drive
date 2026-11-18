#!/bin/bash
# Shared by every script that runs `gcloud builds submit` (gateway, MCP, Bento, UI, worker, freeze-image-deps).
# Source it, then put ${BUILD_FLAGS} on the `gcloud builds submit` line.
#
# Builds run as cortex-build@ (RV-15 part 3, documents/architecture/default-account-editor-removal-design-2026-11-17.md):
# push/pull in the cortex-images repository, read sources and write logs in the build bucket, write log entries.
# Never the default Compute account. A build that names its account must say where its log goes; the build bucket keeps
# the log streaming to the terminal.
BUILD_FLAGS="--service-account projects/${PROJECT_ID:?run: source scripts/cloud-env.sh}/serviceAccounts/${BUILD_SA:?run: source scripts/cloud-env.sh} --gcs-log-dir gs://${PROJECT_ID}_cloudbuild/logs"
