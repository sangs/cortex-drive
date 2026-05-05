#!/bin/bash
# Health check: MCP SSE Server (port 8080)
# No HTTP health endpoint — checks port + process only.

PORT=8080
LOG_FILE="./logs/mcp_server.log"

echo "--- 🔍 MCP SSE SERVER (port $PORT) ---"

PID=$(lsof -t -i:$PORT 2>/dev/null)
if [ -z "$PID" ]; then
    echo "❌ NOT RUNNING — nothing listening on port $PORT"
    if [ -f "$LOG_FILE" ]; then
        echo ""
        echo "Last 10 log lines:"
        tail -10 "$LOG_FILE"
    fi
    exit 1
fi

PROCESS=$(ps -p "$PID" -o command= 2>/dev/null | head -1)
echo "✅ RUNNING"
echo "   PID     : $PID"
echo "   Process : $PROCESS"

if [ -f "$LOG_FILE" ]; then
    echo ""
    echo "Last 5 log lines:"
    tail -5 "$LOG_FILE"
fi
