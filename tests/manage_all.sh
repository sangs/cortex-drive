#!/bin/bash

# --- CONFIGURATION ---
LOG_DIR="./logs"
mkdir -p "$LOG_DIR"

echo "--- 🚀 CORTEXDRIVE SYSTEM ORCHESTRATION ---"

# 1. Start Backend (8080)
echo "Starting Backend (SSE)..."
lsof -t -i:8080 | xargs kill -9 2>/dev/null
PYTHONPATH=. python3 src/mcp_server/cortex_os_mentalmodel_server_sse.py > "$LOG_DIR/mcp_server.log" 2>&1 &
echo "  -> Backend Started: http://localhost:8080/sse"

# 2. Start Gateway (3000)
echo "Starting Gateway..."
lsof -t -i:3000 | xargs kill -9 2>/dev/null
cd cortex-gateway && node index.js > "../$LOG_DIR/gateway.log" 2>&1 &
cd - > /dev/null
echo "  -> Gateway Started: http://localhost:3000/query"

# 3. Start UI (3001)
echo "Starting UI..."
lsof -t -i:3001 | xargs kill -9 2>/dev/null
cd cortex-chat-ui && npm run dev -- -p 3001 > "../$LOG_DIR/ui.log" 2>&1 &
cd - > /dev/null
echo "  -> UI Started: http://localhost:3001"

echo ""
echo "✅ All services initiated."
echo "Use './tests/restart_mcp.sh' to tail specific logs if needed."
echo "Tailing Gateway logs by default... (Ctrl+C to stop)"
echo ""

tail -f "$LOG_DIR/gateway.log"
