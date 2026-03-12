# Graph-Chat Integration: Design & Implementation Plan

How **CortexDrive** visualizes knowledge graph data in response to natural language questions.

## 1. Design Philosophy
The core design principle is **"Answers with Context"**. When a user asks a natural language question, the system provides both a textual AI response and a dynamic sub-graph visualization.

### User Flow:
1.  **Input**: User types: *"What episodes discuss Vector Databases?"*
2.  **Retrieval**: The LLM calls `search_episodes_gds_by_question_tool`.
3.  **Payload**: The tool returns a JSON structure containing "Seed Episodes" (direct search results) and "Similar Episodes" (re-calculated graph neighbors).
4.  **Visualization**: The central graph component "zooms" into the cluster of these nodes, highlighting them in neon blue, while showing their relationships to `Topics` and `Concepts`.

---

## 2. Implementation Strategy

### Backend (The Data Provider)
Current implementation in `expert_tools.py` already supports this via:
- **Vector Indexing**: Finds the specific `Chunk` node.
- **Path Traversal**: Resolves `Chunk -> Episode -> Topic` relationships.
- **GDS KNN**: Provides the "Graph Similarity" scores used to draw lines between semantic neighbors.

### Data Contract (The JSON Bridge)
The tools return structured JSON rather than plain text. This includes:
- `NodeID` and `NodeType`
- `RelationshipType` (e.g., `SEMANTICALLY_SIMILAR_KNN`)
- `Properties` (Episode name, link, match score)

### Frontend (The Visualizer)
- **Library**: Planned usage of `react-force-graph` or `d3.js` inside the Next.js app.
- **A2UI Message Processor**: A specialized component that parses tool outputs from the chat stream. If it detects graph metadata, it emits a signal to the **Global Graph State**.
- **Dynamic Centering**: The graph uses the `SeedEpisode` as the focal point, pulling in its direct neighbors from Neo4j.

---

## 3. Implementation Status 

| Layer | Status | Task Reference |
| :--- | :--- | :--- |
| **Search Tools (Graph)** | **Completed** | `expert_tools.py` / `search_episodes_gds` |
| **Search Tools (Vector)** | **Completed** | `expert_tools.py` / `vector_index` |
| **SSE Transport (Real-time)** | **Completed** | `cortex_os_mentalmodel_server_sse.py` |
| **Next.js Graph UI** | **Pending** | `Priority 2: A2UI Integration` |
| **Data-to-Graph Link** | **Pending** | `State Sync` in `task.md` |

---

## 4. Visual Evidence
As seen in **[cortex_drive_v1.png](file:///Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/documents/mockups/cortex_drive_v1.png)**, the central graph displays a focused cluster (e.g., 'Project Alpha'). When the AI assistant on the right mentions 'Project Alpha', the corresponding node in the graph glows with a thicker neon pulse, providing a direct visual link between the chat answer and the knowledge structure.
