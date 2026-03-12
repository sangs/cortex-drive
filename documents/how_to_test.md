# How to Test CortexDrive Platform

This document outlines how to test and verify the components of the CortexDrive platform locally, following the recent architectural reorganization.

---

## 1. Prerequisites
Ensure your `.env` file in the root or `cortex-gateway/` directory contains:
- `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`
- `OPENAI_API_KEY`
- `PUBLIC_TRIAL_API_KEY` (e.g., `cortex_trial_key_2024`)

---

## 2. Testing the MCP Server (Data Layer)

### Stdio Transport (Logic Check)
Run this from the project root to test tool logic in isolation:
```bash
npx @modelcontextprotocol/inspector uv run -q src/mcp_server/cortex_os_mentalmodel_server_mcp.py
```

### SSE Transport (Integration Check)
1. **Start Server**:
   ```bash
   python3 src/mcp_server/cortex_os_mentalmodel_server_sse.py
   ```
2. **Verify with Inspector**:
   ```bash
   npx @modelcontextprotocol/inspector http://localhost:8080/sse
   ```
3. **Internal Debug Script**:
   Run the manual POST test to verify the SSE handshake:
   ```bash
   python3 tests/mcp_server/debug_mcp_post.py
   ```

---

## 3. Testing the Intelligent Gateway (Orchestration)

The gateway orchestrates LLM calls to select and execute MCP tools based on natural language.

### 1. Start Services
Ensure both the MCP Server (port 8080) and Neo4j are running. Then start the gateway:
```bash
cd cortex-gateway
node index.js
```

### 2. Run Comprehensive Sanity Test
We have a dedicated script to verify natural language queries:
```bash
node tests/gateway/test_gateway_query.js
```
This script tests:
- Tool selection (e.g., statistics vs. search).
- Multi-tenancy context passing.
- LLM answer synthesis.

### 3. Manual CURL Test
You can test the orchestration endpoint directly:
```bash
curl -X POST http://localhost:3000/query \
  -H "Content-Type: application/json" \
  -H "x-api-key: cortex_trial_key_2024" \
  -d '{"question": "How many episodes are in the database?"}'
```

---

## 4. Full System Startup (for UI Testing)

To test the platform through the web interface, follow this specific startup order. Open a new terminal window or run in the background as shown below:

> [!TIP]
> **What is `nohup`?**
> `nohup` (no hangup) is a command that prevents a process from being terminated when the terminal session is closed. Combined with the `&` at the end, it turns the command into a background service, allowing you to run other commands (like `tail`) in the same terminal window while the services keep running.

### Step 1: Start the Backend (MCP Server)
Run from the root directory:
```bash
# Ensure logs directory exists
mkdir -p logs

# Start in background and log to root
nohup python3 src/mcp_server/cortex_os_mentalmodel_server_sse.py > logs/mcp_server.log 2>&1 &
```
*Wait for: `Uvicorn running on http://0.0.0.0:8080` (Check via `tail -f logs/mcp_server.log`)*

### Step 2: Start the Gateway (Orchestrator)
Run from the root directory:
```bash
nohup node cortex-gateway/index.js > logs/gateway.log 2>&1 &
```
*Wait for: `Cortex Gateway listening at http://localhost:3000` (Check via `tail -f logs/gateway.log`)*

### Step 3: Start the Frontend (Cortex Chat UI)
Run from the root directory:
```bash
cd cortex-chat-ui && nohup npm run dev -- -p 3001 > ../logs/nextjs.log 2>&1 &
```
*The UI will be available at `http://localhost:3001`.*

---

## 5. Authentication & Trial Access

The CortexDrive platform uses a dual-layer authentication system:

### 1. Local Testing via the UI (Clerk Login Required)
The frontend (`cortex-chat-ui`) now completely enforces authentication. You must log in via Clerk to access the Dashboard, even in local environments.
1. Start the React app. The landing page has an "Enter Your Brain" button which will redirect you to the Clerk `sign-in` page.
2. Sign in with the appropriate active account that holds the data in Neo4j.
3. Once logged in, your requests will automatically be scoped to that account's specific Tenant/Org ID.

### 2. Manual/CURL Testing (Trial API Key)
To bypass Clerk when testing backend services manually (e.g., via `curl` or automated scripts), the Gateway accepts a **Trial API Key** (`cortex_trial_key_2024`).
- **Usage**: Provide this key in the `x-api-key` header.
- **Tenant ID**: The Gateway defaults these requests to `org_3AacpFBbt39hPmDKyZyNBQuuM6t` so they automatically query the trial data.

---

## 6. Troubleshooting & Logs

To monitor the system in real-time or troubleshoot errors, you can "tail" the logs:

```bash
# Monitor logs from the root directory
tail -f logs/mcp_server.log
tail -f logs/gateway.log
tail -f logs/nextjs.log
```

### Common Issues
- **Port Conflicts**: Ensure ports 8080 (MCP), 3000 (Gateway), and 3001 (Frontend) are free.
  - **Check if a port is in use**: `lsof -i :<port_number>` (e.g., `lsof -i :8080`)
  - **Kill process on a port**: `lsof -t -i :<port_number> | xargs kill -9`
    > [!NOTE]
    > Using `xargs` prevents "not enough arguments" errors if the port is already empty. The `-t` (terse) flag ensures only the PID is passed, avoiding header text errors.
- **Environment**: The MCP server automatically loads credentials from the `.env` file in the project root. Ensure your keys are correctly set in that file.
- **Clerk Keyless Mode**: If you see a "[Clerk]: You are running in keyless mode" message, the frontend is using a temporary development environment. To use your own keys:
  1. Copy `cortex-chat-ui/.env.local.example` to `cortex-chat-ui/.env.local`.
  2. Add your `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` from the [Clerk Dashboard](https://dashboard.clerk.com).
- **Next.js Convention**: The `middleware.ts` file has been renamed to `proxy.ts` to comply with the latest Next.js 16 requirements.
