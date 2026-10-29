#!/bin/bash
# Run ONE SQL migration file from scripts/migrations/ against the production app database
# (cortexdrive_app), through a Cloud SQL Auth Proxy on 127.0.0.1:5432.
# Usage: bash scripts/run_sql_migration.sh scripts/migrations/<NNN_name>.sql
#
# Narrow on purpose (2026-10-29): Claude Code is allowed to run exactly this script, so it can apply
# reviewed migration files and nothing else. It refuses any path outside scripts/migrations/, any
# non-.sql file, and stops on the first SQL error. The password comes from Secret Manager and is never
# printed. Starts the proxy if it isn't running. Runbook: documents/how-to-google-cloud-operations.md.
set -euo pipefail

PROJECT_ID="cortex-drive-496915"
INSTANCE="${PROJECT_ID}:us-central1:cortex-openfga-db"
DB_NAME="cortexdrive_app"
DB_USER="cortex-app-user"
PSQL="${PSQL:-/opt/homebrew/opt/libpq/bin/psql}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS_DIR="${REPO}/scripts/migrations"

if [ "$#" -ne 1 ]; then echo "Usage: bash scripts/run_sql_migration.sh scripts/migrations/<file>.sql" >&2; exit 2; fi
FILE="$(cd "$(dirname "$1")" 2>/dev/null && pwd)/$(basename "$1")"
case "$FILE" in
    "${MIGRATIONS_DIR}"/*.sql) ;;
    *) echo "Refusing: only .sql files in scripts/migrations/ may be run (got: $1)" >&2; exit 2 ;;
esac
[ -f "$FILE" ] || { echo "No such file: $1" >&2; exit 2; }

if ! lsof -i :5432 >/dev/null 2>&1; then
    echo "Starting Cloud SQL Auth Proxy on 127.0.0.1:5432"
    nohup cloud-sql-proxy "${INSTANCE}" --port 5432 >/dev/null 2>&1 &
    sleep 4
fi

echo "Applying $(basename "$FILE") to ${DB_NAME}"
PGPASSWORD="$(gcloud secrets versions access latest --secret=CORTEX_APP_DB_PASSWORD --project="${PROJECT_ID}")" \
    "${PSQL}" "host=127.0.0.1 port=5432 dbname=${DB_NAME} user=${DB_USER}" -v ON_ERROR_STOP=1 -f "$FILE"
echo "✓ $(basename "$FILE") applied"
