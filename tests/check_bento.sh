#!/bin/bash
# Health check: Bento HTTP Server (port 8000)
# Checks port + GET /health endpoint.

PORT=8000
LOG_FILE="./logs/bento_server.log"

echo "--- 🔍 BENTO HTTP SERVER (port $PORT) ---"

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

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://localhost:$PORT/health" 2>/dev/null)
if [ "$HTTP_STATUS" = "200" ]; then
    echo "   /health : ✅ HTTP $HTTP_STATUS"
else
    echo "   /health : ⚠️  HTTP $HTTP_STATUS (port up but endpoint not responding)"
fi

if [ -f "$LOG_FILE" ]; then
    echo ""
    echo "Last 5 log lines:"
    tail -5 "$LOG_FILE"
fi
