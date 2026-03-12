# Cortex Model MCP Tools Documentation

This document describes the tools exposed via the Model Context Protocol (MCP) in the `cortex-model` project.

## Overview

The `cortex-model` project provides advanced search and management capabilities for podcast episode data stored in Neo4j. These capabilities are exposed as MCP tools, allowing AI models to interact with the mental model graph.

## Tool Definitions

The primary tool definitions are managed in [podcast-episode-tools.yaml](../podcast-episode-tools.yaml). This file is used by the "Toolbox" bridge to expose tools via MCP Stdio.

| Tool Name | Type | Description |
|-----------|------|-------------|
| `get_context` | Cypher | Gets the context for using & accessing podcast episode data. Always run this first. |
| `get_tool_statistics` | Cypher | Returns counts of episodes, topics, reference links, and transcript chunks. |
| `find_episodes_by_people` | Cypher | Search for episodes featuring specific people (hosts, guests, listeners). |
| `find_episodes_by_concept` | Cypher | Search for episodes discussing specific concepts or ideas. |
| `find_episodes_by_topic` | Cypher | Search for episodes containing specific topics or keywords. |
| `find_episodes_by_technology` | Cypher | Search for episodes discussing specific technologies or tools. |
| `find_episodes_by_reference` | Cypher | Find episodes with reference links containing a specific string. |
| `find_episodes_by_mentions` | Cypher | Find episodes mentioning a search term in their reference links. |
| `search_episodes_gds_by_question_tool` | MCP Tool | Extended search combining vector search with Graph Data Science (GDS) KNN. |

## Implementation Architecture

The project supports multiple ways to access these tools:

1.  **Toolbox (MCP Stdio Bridge)**:
    - Bridged via [podcast-episode-tools.yaml](../podcast-episode-tools.yaml).
    - Acts as a proxy for both Cypher queries and HTTP-based tools.
2.  **Standalone SSE Server**:
    - File: [cortex_os_mentalmodel_server_sse.py](../cortex_os_mentalmodel_server_sse.py)
    - Protocol: Server-Sent Events (SSE).
    - Features tenant-aware context management via Starlette middleware.
3.  **Standalone MCP Stdio Server**:
    - File: [cortex_os_mentalmodel_server_mcp.py](../cortex_os_mentalmodel_server_mcp.py)
    - Direct implementation using the `mcp.server` SDK.

## Recent Updates (2026-03-11)

- **Parity Support**: All 9 tools are now fully supported in the SSE server implementation. Previously, only the GDS search tool was available via SSE.
- **ExpertTools Enhancement**: Added `get_tool_context` to [expert_tools.py](../expert_tools.py) to programmatically retrieve metadata context from the graph.

## Verification

To verify the tools available on the SSE server:
1. Start the server: `python3 cortex_os_mentalmodel_server_sse.py`
2. Run the test script: `python3 test_sse_server.py`

This will list all registered tools and confirm connectivity.
