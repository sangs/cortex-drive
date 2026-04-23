#!/bin/bash
echo "Stopping BentoML Server..."
PID=$(lsof -ti:5000)
if [ -n "$PID" ]; then
    kill -9 $PID
    echo "BentoML Server (PID $PID) stopped on port 5000."
else
    PID=$(pgrep -f "bentoml")
    if [ -n "$PID" ]; then
        kill -9 $PID
        echo "BentoML Server (PID $PID) stopped."
    else
        echo "No BentoML process found."
    fi
fi
