# CortexModel Local Test Setup Guide

This guide describes how to set up and test the CortexModel backend and the CortexDrive frontend in a local environment.

## 1. Prerequisites

### Backend (Python)
- **Python 3.11+**
- **Neo4j Database**: A running instance (local or Aura).
- **OpenAI API Key**: Required for embeddings and chat reasoning.
- **Dependencies**: `mcp[server]`, `uvicorn`, `starlette`, `sse-starlette`, `openai`, `neo4j`, `numpy`.

### Frontend (Next.js)
- **Node.js 18+** & **npm**
- **Clerk Account**: For authentication and multi-tenancy (`org_id`).

---

## 2. Backend Setup

1. **Activate Virtual Environment**:
   ```bash
   source .venv/bin/activate
   ```

2. **Configure Environment Variables**:
   Create or update your `.env` file in the root directory:
   ```bash
   NEO4J_URI="bolt://localhost:7687"
   NEO4J_USERNAME="neo4j"
   NEO4J_PASSWORD="your_password"
   OPENAI_API_KEY="sk-..."
   PORT=8080
   DEFAULT_TENANT_ID="test_org_123" 
   ```

3. **Start the SSE Server**:
   ```bash
   python cortex_os_mentalmodel_server_sse.py
   ```
   *The server will run on `http://localhost:8080`.*

---

## 3. Frontend Setup

1. **Navigate to Frontend Directory**:
   ```bash
   cd cortex-drive-frontend
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Configure Clerk**:
   Create a `.env.local` inside `cortex-drive-frontend/` with your Clerk keys:
   ```bash
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
   CLERK_SECRET_KEY=sk_test_...
   ```

4. **Start the Dev Server**:
   ```bash
   npm run dev
   ```
   *The UI will be available at `http://localhost:3000`.*

---

## 4. Testing Procedures

### A. Backend-Only Test (Sanity Check)
Run the provided test script to verify that the SSE server is correctly extracting tenant IDs and communicating with Neo4j:
```bash
python test_sse_server.py
```

### B. End-to-End Test (Scenario 1)
1. Open `http://localhost:3000` in your browser.
2. Sign in via Clerk.
3. Once logged in, the `useSSE` hook will automatically pick up your `org_id`.
4. Type a message in the chat box (e.g., "Show me relevant episodes").
5. **Observe**:
   - The chat should stream the bot's response.
   - The Knowledge Graph should update its neon nodes based on the data returned.

---

## 5. Troubleshooting

- **CORS Errors**: If the browser blocks requests, ensure the backend is allowing `localhost:3000`. FastMCP handles basic SSE headers, but complex setups might need a proxy.
- **Middleware Assertion Error**: Ensure you are using the `TenantASGIMiddleware` version of the server (fixed for SSE streaming compatability).
- **Tenant ID Missing**: If queries return no data, ensure your Clerk user is part of an Organization and that the Neo4j data has been migrated to that same `org_id` using `migrate_to_clerk_org.py`.
