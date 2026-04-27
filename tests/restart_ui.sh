#!/bin/bash

# --- CONFIGURATION ---
PORT=3000
UI_DIR="./cortex-chat-ui"
LOG_FILE="./logs/ui.log"

# Ensure logs directory exists
mkdir -p ./logs

echo "--- 🛠️  RESTARTING CORTEX CHAT UI (Next.js) ---"

# 1. Identify and Kill existing process on port
PID=$(lsof -t -i:$PORT)
if [ -n "$PID" ]; then
  echo "Stopping existing UI on port $PORT (PID: $PID)..."
  kill -9 $PID
  sleep 1
fi

# 2. Clear Next.js cache and start process in background
echo "Starting UI: $UI_DIR on port $PORT..."
cd "$UI_DIR" && rm -rf .next && npx next dev > "../$LOG_FILE" 2>&1 &
NEW_PID=$!

echo "✅ Started (PID: $NEW_PID). Logs redirected to $LOG_FILE"
echo "--- 🔭  TAILING LOGS (Ctrl+C to stop tailing) ---"
echo ""

# 3. Tail the logs (using tail from project root)
cd - > /dev/null
tail -f "$LOG_FILE"
