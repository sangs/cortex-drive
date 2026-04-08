#!/bin/bash

# --- CONFIGURATION ---
PORT=3000
GATEWAY_DIR="./cortex-gateway"
LOG_FILE="./logs/gateway.log"

# Ensure logs directory exists
mkdir -p ./logs

echo "--- 🛠️  RESTARTING CORTEX GATEWAY ---"

# 1. Identify and Kill existing process on port
PID=$(lsof -t -i:$PORT)
if [ -n "$PID" ]; then
  echo "Stopping existing gateway on port $PORT (PID: $PID)..."
  kill -9 $PID
  sleep 1
fi

# 2. Start node process in background
echo "Starting Gateway: $GATEWAY_DIR/index.js..."
cd "$GATEWAY_DIR" && node index.js > "../$LOG_FILE" 2>&1 &
NEW_PID=$!

echo "✅ Started (PID: $NEW_PID). Logs redirected to $LOG_FILE"
echo "--- 🔭  TAILING LOGS (Ctrl+C to stop tailing) ---"
echo ""

# 3. Tail the logs (using tail from project root)
cd - > /dev/null
tail -f "$LOG_FILE"
