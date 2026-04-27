#!/bin/bash
echo "Stopping Gateway on port 4000..."
PID=$(lsof -ti:4000)
if [ -n "$PID" ]; then
    kill -9 $PID
    echo "Gateway (PID $PID) stopped."
else
    echo "No process found on port 4000."
fi
