#!/bin/bash
# cortex-drive runtime alerts (RV-17): set up, inspect, switch on/off, snooze, remove. DRY RUN unless --apply.
# Design: documents/architecture/safe-errors-and-alerts-design-2026-11-18.md §3.1; on/off: documents/operations-daily-checks.md §1.1.
#
#   source scripts/cloud-env.sh
#   bash scripts/setup-alerts.sh                         # show what setup would create
#   ALERT_EMAIL=<owner address> bash scripts/setup-alerts.sh --apply
#   bash scripts/setup-alerts.sh --status
#   bash scripts/setup-alerts.sh --snooze 2h --apply     # also --disable / --enable / --remove, each with --apply
#
# What to create is data (scripts/alerts.json); the logic is scripts/setup_alerts.py. The owner's address is passed at
# run time and kept only in the Google Cloud notification channel, never in the repository.
set -euo pipefail
: "${PROJECT_ID:?run: source scripts/cloud-env.sh}"
exec "${REPO:?run: source scripts/cloud-env.sh}/.venv/bin/python" "${REPO}/scripts/setup_alerts.py" "$@"
