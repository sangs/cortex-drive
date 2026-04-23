#!/bin/bash
echo "Stopping Frontend on port 3000..."
PID=$(lsof -ti:3000)
if [ -n "$PID" ]; then
    kill -9 $PID
    echo "Frontend (PID $PID) stopped."
else
    echo "No process found on port 3000."
fi
