#!/bin/bash

# --- CONFIGURATION ---
LOG_DIR="./logs"
mkdir -p "$LOG_DIR"

# Load environment variables
if [ -f .env ]; then
  echo "Loading environment variables from .env..."
  set -a; source .env; set +a
fi

echo "--- 🚀 CORTEXDRIVE SYSTEM ORCHESTRATION ---"

# 1. Start Backend (8080)
echo "Starting Backend (MCP/SSE)..."
lsof -t -i:8080 | xargs kill -9 2>/dev/null
PYTHONPATH=. .venv/bin/python src/mcp_server/cortex_os_mentalmodel_server_sse.py > "$LOG_DIR/mcp_server.log" 2>&1 &
echo "  -> Backend Started: port 8080"

# 2. Start Bento Server (8000)
echo "Starting Bento Server (REST)..."
lsof -t -i:8000 | xargs kill -9 2>/dev/null
PYTHONPATH=. .venv/bin/python src/mcp_server/cortex_os_mentalmodel_http_server.py > "$LOG_DIR/bento_server.log" 2>&1 &
echo "  -> Bento Started: port 8000"

# 3. Start Gateway (4000)
echo "Starting Gateway..."
lsof -t -i:4000 | xargs kill -9 2>/dev/null
cd cortex-gateway && node index.js > "../$LOG_DIR/gateway.log" 2>&1 &
cd - > /dev/null
echo "  -> Gateway Started: port 4000"

# 4. Start UI — clear .next cache first to prevent Turbopack crashes
echo "Starting UI (Enterprise)..."
lsof -t -i:3000 | xargs kill -9 2>/dev/null
cd cortex-chat-ui && rm -rf .next && npx next dev > "../$LOG_DIR/ui.log" 2>&1 &
cd - > /dev/null
echo "  -> UI Started: http://localhost:3000"

echo ""
echo "✅ All services initiated."
echo "Use './tests/restart_gateway.sh' to tail the Brain logs."
echo "Tailing UI logs by default... (Ctrl+C to stop)"
echo ""

tail -f "$LOG_DIR/ui.log"
