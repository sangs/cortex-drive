#!/bin/bash
# Regenerate the Python version locks (S2-29) from the images currently deployed.
# Usage: source scripts/cloud-env.sh && bash scripts/freeze-image-deps.sh
#
# Reads `pip freeze` from cortex-mcp:latest and cortex-ingest-worker:latest by running them as Cloud
# Build steps (no local Docker configuration needed), then rewrites
#   src/mcp_server/constraints-docker.txt   (cortex-mcp, cortex-bento, bootstrap)
#   src/mcp_server/constraints-worker.txt   (cortex-ingest-worker)
# Upgrade flow: change the pin in the constraints (and requirements) file, rebuild, test, deploy, then
# run this script to confirm the lock matches what is now deployed. Review the diff before committing.
set -euo pipefail

if [ -z "${REGISTRY:-}" ] || [ -z "${REPO:-}" ]; then
    echo "ERROR: REGISTRY and REPO are not set. Run: source scripts/cloud-env.sh"
    exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/freeze.yaml" <<EOF
steps:
  - name: ${REGISTRY}/cortex-mcp:latest
    entrypoint: sh
    args: ["-c", "echo '=====MCP-BEGIN'; pip freeze --all; echo '=====MCP-END'"]
  - name: ${REGISTRY}/cortex-ingest-worker:latest
    entrypoint: sh
    args: ["-c", "echo '=====WORKER-BEGIN'; pip freeze --all; echo '=====WORKER-END'"]
EOF

BUILD_ID=$(gcloud builds submit --no-source --config "$TMP/freeze.yaml" --project "$PROJECT_ID" --format="value(id)" | tail -1)
gcloud builds log "$BUILD_ID" --project "$PROJECT_ID" > "$TMP/freeze.log"

write_lock() {  # $1 = marker, $2 = output file, $3 = images it locks
    local marker=$1 out=$2 who=$3
    {
        echo "# Version lock (S2-29) for: $who."
        echo "# Exact versions running in production on $(date +%F), read from the deployed image with pip freeze."
        echo "# Used as pip constraints (-c): builds can only install these versions. To upgrade a package, change it"
        echo "# here (and in requirements-*.txt if pinned there), rebuild, test, deploy. Regenerate: scripts/freeze-image-deps.sh"
        sed -n "/=====${marker}-BEGIN/,/=====${marker}-END/p" "$TMP/freeze.log" | sed -E 's/^Step #[0-9]+: //' \
            | grep -E '^[A-Za-z0-9_.-]+==' | grep -viE '^(pip|setuptools|wheel)==' | sort -f
    } > "$out"
    echo "✓ $out: $(grep -c '==' "$out") pins"
}
write_lock MCP "${REPO}/src/mcp_server/constraints-docker.txt" "cortex-mcp (also cortex-bento, bootstrap)"
write_lock WORKER "${REPO}/src/mcp_server/constraints-worker.txt" "cortex-ingest-worker"
echo "Review: git diff src/mcp_server/constraints-*.txt"
