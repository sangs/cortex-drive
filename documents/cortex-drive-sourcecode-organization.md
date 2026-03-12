# CortexDrive: Source Code Organization

This document provides an overview of the organized project structure for the CortexDrive platform. The codebase is divided into clear functional layers: intelligent orchestration, knowledge graph management, and specialized frontends.

## 1. Project Directory Structure

```text
cortex-model-project/
├── cortex-model/
│   ├── src/
│   │   └── mcp_server/          # Core Python logic and MCP Server
│   ├── cortex-gateway/          # Express-based Intelligent Orchestrator
│   ├── cortex-chat-ui/          # Main Chat UI (Next.js)
│   ├── cortex-graphviz/         # Graph Visualization UI (Next.js)
│   ├── tests/
│   │   ├── gateway/             # Gateway and E2E tests
│   │   └── mcp_server/          # MCP server and tool tests
│   ├── notebooks/               # Research & Data Science notebooks
│   ├── scripts/                 # Utility, ingestion, and deployment scripts
│   ├── logs/                    # Centralized component logs
│   ├── documents/               # Architectural & user documentation
│   └── documents/mockups/       # UX/UI design mockups
```

## 2. Component Overviews

### A. Intelligent Orchestration ([cortex-gateway](file:///Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/cortex-gateway))
The `cortex-gateway` is the secure entry point and brains of the system.
- **Technology**: Node.js + Express.
- **Role**: Intelligent agent that translates natural language into tool calls.
- **Key Files**: 
    - `index.js`: Orchestration logic using OpenAI GPT-4.
    - `package.json`: Manages dependencies like `openai`, `express`, and `@clerk/backend`.

### B. Knowledge Graph & MCP Server ([src/mcp_server](file:///Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/src/mcp_server))
The core data layer and Model Context Protocol (MCP) implementation.
- **Technology**: Python, Starlette, FastMCP.
- **Role**: Exposes tools for querying the Neo4j knowledge graph.
- **Key Files**:
    - `cortex_os_mentalmodel_server_sse.py`: The SSE-based MCP server.
    - `expert_tools.py`: Underlying logic for graph queries and semantic search.
    - `podcast-episode-tools.yaml`: Tool definitions for LLM exposure.

### C. Frontend Interfaces
The platform provides two specialized web interfaces:
- **[cortex-chat-ui](file:///Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/cortex-chat-ui)**: The primary user interface for chatting with the knowledge graph. Built with Next.js and Framer Motion.
- **[cortex-graphviz](file:///Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/cortex-graphviz)**: A specialized data exploration tool using `react-force-graph-2d` to visualize the Neo4j graph structure.

## 3. Maintenance & Testing
- **Sanity Tests**: Located in `tests/gateway/test_gateway_query.js`. This script verifies the end-to-end flow from natural language input to tool execution.
- **Logs**: Always check `logs/gateway/gateway.log` and `logs/mcp_server/mcp_server.log` for runtime diagnostics.

---
**Organization Status**: Finalized & Verified.
