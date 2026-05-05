#!/bin/bash
# Health check: Frontend UI (port 3000)
# Next.js dev server has no /health route — checks port + HTTP response from /.

PORT=3000
LOG_FILE="./logs/ui.log"

echo "--- 🔍 FRONTEND UI (port $PORT) ---"

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
echo "   URL     : http://localhost:$PORT"

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:$PORT/" 2>/dev/null)
if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "307" ]; then
    echo "   /       : ✅ HTTP $HTTP_STATUS"
else
    echo "   /       : ⚠️  HTTP $HTTP_STATUS (process up but not yet serving)"
fi

if [ -f "$LOG_FILE" ]; then
    echo ""
    echo "Last 5 log lines:"
    tail -5 "$LOG_FILE"
fi
