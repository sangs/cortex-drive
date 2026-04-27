#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "=== CortexDrive Cleanup: Killing all components ==="

$DIR/kill_frontend.sh
$DIR/kill_gateway.sh
$DIR/kill_mcp.sh
$DIR/kill_bento.sh

echo "=== Cleanup Complete ==="
