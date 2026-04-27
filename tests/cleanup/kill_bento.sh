#!/bin/bash
echo "Stopping Bento Detail Server on port 8000..."
PID=$(lsof -ti:8000)
if [ -n "$PID" ]; then
    kill -9 $PID
    echo "Bento Server (PID $PID) stopped."
else
    PID=$(pgrep -f "cortex_os_mentalmodel_http_server")
    if [ -n "$PID" ]; then
        kill -9 $PID
        echo "Bento Server (PID $PID) stopped by name."
    else
        echo "No Bento Server process found."
    fi
fi
