# 🖼️ Identity Transition Matrix (Visual Strategy)

## 📌 Context
This diagram illustrates the architectural transition from the legacy "NULL-permissive" state to the high-fidelity **Zero-Trust Enterprise Tiers** required for Cortex-Drive scale.

![Identity Transition Matrix](file:///Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/documents/architecture/identity_transition_matrix-2026-04-23.png)

### 📊 Strategic Tiers Defined:

1. **SYSTEM (Blue)**
   - *Nodes*: Landmarks, Technology, Backbone, Structural Schema.
   - *Logic*: Strictly controlled at ingestion, but globally navigable. Prevents "orphaned" ontology nodes.

2. **PUBLIC (Green)**
   - *Nodes*: InfoQ Articles, Hackathon Projects, Community Contributions.
   - *Logic*: Controlled external access with clear lineage. used for "Contextual Fusion" bridges.

3. **PRIVATE (Purple)**
   - *Nodes*: Personal Projects, STAR Notes, Proprietary Research.
   - *Logic*: Strong multifactor context-aware access. strictly gated by `owner_id`. 

---

## 🏛️ Zero-Trust Bridge Discovery: Technical Rationale

The core problem is **"Discovery Starvation"**. When we strictly filter nodes like `Chunk` or `Source` during the **Expansion Phase** (Step 0), we lose the bridges that connect disparate concepts (e.g., "Thought Leadership" -> "Design Decision").

### The Solution: "Relaxed Expansion, Strict Hydration"

1. **Relaxed Expansion**: During the initial Cypher traversal (Step 0), we allow the search to hop through **any** node type (including `Chunk`) to find connections.
2. **Strict Hydration**: Once the target nodes are identified, we only return **Backbone Nodes** (Roles, Companies, Episodes) to the graph UI, while keeping the "Bridge Context" inside the Bento panel.

---
*Date: 2026-04-23 | Architecture: Hardened | Security: Zero-Trust | Discovery: Bridge-Aware*
