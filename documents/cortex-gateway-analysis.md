# Cortex Gateway: Architecture & Integration Analysis

## 1. Current Architecture & Implementation

The `cortex-gateway` is a lightweight, specialized API gateway implemented using **Node.js** and **Express**. It serves as the secure entry point for the Cortex project, bridging the frontend applications with the backend MCP servers.

### Key Components:
- **Express.js**: The core web framework.
- **http-proxy-middleware**: Handles the redirection of traffic from the gateway to the internal MCP SSE server.
- **Clerk SDK (`@clerk/backend`)**: Manages enterprise-grade authentication and multitenancy.
- **Custom Auth Middleware**: Extracts and validates identity before any request reaches the data layer.

### Functionality:
- **Authentication**: Validates Clerk JWTs or falls back to a trial API key.
- **Multitenancy**: Extracts the `tenant_id` (from the Clerk `sub` claim or custom headers) and injects it as an `x-tenant-id` header for the downstream MCP server.
- **Reverse Proxying**: Maps `/api/*` routes to the internal MCP server URL.
- **SSE Support**: Specifically configured to handle Server-Sent Events for real-time tool responses.

## 2. End-to-End Integration Flow

The integration flow follows a standard modern web architecture:

1.  **Client (Frontend)**: User sends a natural language question (e.g., "Who are the guests in episode 1?").
2.  **Request**: Frontend adds a Clerk token to the header and sends the request to `cortex-gateway/api`.
3.  **Gateway (Auth)**: Gateway verifies the token, identifies the tenant (e.g., `org_123`), and strips the auth header.
4.  **Gateway (Proxy)**: Gateway forwards the request to `cortex-os-mentalmodel-server-sse:8080` with the added `x-tenant-id`.
5.  **MCP Server**: The Starlette/FastMCP server receives the request, uses the tenant ID to query the correct Neo4j partition, and returns the tool output.

## 3. Comparison with Industry Standards

| Feature | Cortex Gateway | Reverse Proxy (e.g., Nginx) | API Gateway (e.g., Kong, Apigee) |
|---------|----------------|-----------------------------|----------------------------------|
| **Primary Use** | Specialized Auth & Tenant Context | Traffic Routing & TLS termination | Lifecycle, Quotas & Policies |
| **Auth Logic** | Embedded (Clerk-native) | Often requires external modules | Full-featured Plugins |
| **Multitenancy** | Deep integration (Context injection) | Simple Header mapping | Complex grouping & billing |
| **Logic** | Code-driven (Middleware) | Configuration-driven | Admin UI / CLI driven |
| **Performance** | High (Node.js async) | Ultra-high (C-based engine) | High (Lua/Go/Java) |

### Why `cortex-gateway` is used over a standard Proxy:
While Nginx is faster for pure routing, `cortex-gateway` allows for **application-aware orchestration**. It can parse the body of incoming requests, interact with auth providers programmatically, and now, integrate LLMs to transform natural language into specific tool calls before proxying.

---

# Gateway LLM Integration Walkthrough

We have successfully integrated an LLM orchestration layer into the `cortex-gateway`, enabling natural language querying of the MCP tools.

## Accomplishments

### 1. LLM Orchestration Layer
We implemented a new `/query` POST endpoint in the gateway. This endpoint uses OpenAI's GPT-4 to:
- Understand user intent from natural language.
- Select the most appropriate MCP tool from a list of registered tools.
- Formulate the correct arguments for the tool call.

### 2. Asynchronous MCP-SSE Orchestration
The most complex part of the integration was handling the MCP SSE transport from a stateless gateway. We implemented a robust handshake mechanism:
- **Discovery**: Dynamically discovering the session-based message endpoint from the SSE stream.
- **Initialization**: Performing the `initialize` and `notifications/initialized` handshake for every tool session.
- **Asynchronous Results**: Listening to the SSE stream to capture the tool result associated with the specific request ID.

### 3. Tenant Context Preservation
The gateway correctly passes the `x-tenant-id` to the MCP server, ensuring that the LLM only accesses data belonging to the authenticated user.

## Verification Results

We verified the integration using a test suite that simulates several natural language queries.

### Test Case: "Who are the guests in episode 1?"
- **Tool Selected**: `find_episodes_by_reference`
- **MCP Call**: Successfully initialized session and triggered the tool.
- **Result**: Managed the conversational flow to request more specific context.

### Test Case: "How many topics are in the database?"
- **Tool Selected**: `get_tool_statistics`
- **Result**: Successfully reported tenant-specific statistics from the Neo4j graph.

### Test Case: "Tell me about Snowflake."
- **Tool Selected**: `find_episodes_by_technology`
- **Result**: Synthesized a comprehensive answer using tool output and system knowledge.

---
**Verification status: PASSED**
The system is now capable of intelligent tool orchestration via natural language.
