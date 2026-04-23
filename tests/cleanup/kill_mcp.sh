#!/bin/bash
echo "Stopping MCP Server on port 8080..."
PID=$(lsof -ti:8080)
if [ -n "$PID" ]; then
    kill -9 $PID
    echo "MCP Server (PID $PID) stopped."
else
    # Fallback: find by process name if port is not matched
    PID=$(pgrep -f "mcp_server")
    if [ -n "$PID" ]; then
        kill -9 $PID
        echo "MCP Server (PID $PID) stopped by name."
    else
        echo "No MCP Server process found."
    fi
fi
