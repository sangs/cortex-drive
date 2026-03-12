#!/bin/bash
# Start the cortex-os-mentalmodel HTTP server

# Load environment variables from podcast-gds.env
if [ -f "podcast-gds.env" ]; then
    # Use set -a to automatically export all variables
    set -a
    source podcast-gds.env
    set +a
    echo "Loaded environment variables from podcast-gds.env"
else
    echo "Warning: podcast-gds.env not found"
fi

# Check required environment variables
missing_vars=()
if [ -z "$NEO4J_URI" ]; then
    missing_vars+=("NEO4J_URI")
fi
if [ -z "$NEO4J_USERNAME" ]; then
    missing_vars+=("NEO4J_USERNAME")
fi
if [ -z "$NEO4J_PASSWORD" ]; then
    missing_vars+=("NEO4J_PASSWORD")
fi
if [ -z "$OPENAI_API_KEY" ]; then
    missing_vars+=("OPENAI_API_KEY")
fi

if [ ${#missing_vars[@]} -gt 0 ]; then
    echo "Error: Missing required environment variables: ${missing_vars[*]}"
    exit 1
fi

# Start the server
echo "Starting cortex-os-mentalmodel HTTP server..."
cortex-os-mentalmodel-http
#python cortex_os_mentalmodel_http_server.py
