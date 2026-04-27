#!/bin/bash

# --- CONFIGURATION ---
PORT=8000
LOG_FILE="./logs/bento_server.log"
SERVER_SCRIPT="src/mcp_server/cortex_os_mentalmodel_http_server.py"

# Ensure logs directory exists
mkdir -p ./logs

# Load environment variables
if [ -f .env ]; then
  echo "Loading environment variables from .env..."
  set -a; source .env; set +a
fi

echo "--- 🛠️  RESTARTING BENTO DETAIL SERVER ---"

# 1. Identify and Kill existing process on port
PID=$(lsof -t -i:$PORT)
if [ -n "$PID" ]; then
  echo "Stopping existing process on port $PORT (PID: $PID)..."
  kill -9 $PID
  sleep 1
fi

# 2. Start core process in background
echo "Starting Bento Server: $SERVER_SCRIPT..."
export PYTHONPATH=$PYTHONPATH:.
.venv/bin/python $SERVER_SCRIPT > "$LOG_FILE" 2>&1 &
NEW_PID=$!

echo "✅ Started (PID: $NEW_PID). Logs redirected to $LOG_FILE"
echo "--- 🔭  TAILING LOGS (Ctrl+C to stop tailing) ---"
echo ""

# 3. Tail the logs
tail -f "$LOG_FILE"
