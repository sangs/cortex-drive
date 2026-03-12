# CortexDrive: Valid Schema Analysis (Pre-Cleanup)

This document organizes the valid schema into distinct domains as of March 10, 2026. These definitions are centralized in `schema_guard.py` and enforced across all ingestion, audit, and cleanup tools.

---

## 🎙 1. Cortex-Model Schema (Podcast Domain)
Used for processing podcast transcripts and enabling AI-powered search over audio content. Primarily utilized by the `IngestionEngine` and the `ExpertTools` search suite.

### Nodes
| Category | Node Labels |
| :--- | :--- |
| **Core** | `Podcast`, `Episode`, `Chunk` |
| **Knowledge** | `Topic`, `Concept`, `Technology`, `ReferenceLink` |
| **People** | `Person` |

### Relationships & Usage
- **Hierarchy**: `Podcast` → `[:HAS_EPISODE]` → `Episode` → `[:HAS_CHUNK]` → `Chunk`.
- **Extraction**: `Episode` → `[:HAS_TOPIC]` → `Topic` → `[:COVERS_CONCEPT/TECHNOLOGY]`.
- **References**: `Episode` → `[:HAS_REFERENCE_LINK]` → `ReferenceLink`.
- **Social**: `Person` → `[:IS_A_HOST / IS_A_GUEST / LISTENS_TO_EPISODE]` → `Episode`.
- **Discovery**: `Chunk` → `[:SIMILAR / SEMANTICALLY_SIMILAR_KNN]` → `Chunk` (used for GDS-based recommendations).

---

## 📂 2. Project Graph Schema (Personal Intro Domain)
Designed for the "Person Introduction" feature, mapping out project management structures, professional achievements, and team collaboration.

### Nodes
| Category | Node Labels |
| :--- | :--- |
| **Strategy** | `Project`, `Purpose`, `Objective`, `Value`, `Benefit`, `Metric` |
| **Delivery** | `Outcome`, `SuccessCriteria`, `MeasurableResult` |
| **Execution** | `Approach`, `Plan`, `Method`, `MethodStep`, `Tool`, `Timeline`, `Milestone` |
| **Collaboration** | `Team`, `Role`, `Responsibility`, `Task`, `Deliverable`, `TeamMember` |

### Relationships & Usage
- **Vision**: `Project` → `[:HAS_PURPOSE]` → `Purpose` → `[:HAS_OBJECTIVE]` → `Objective`.
- **Value**: `Project` → `[:DELIVERS]` → `Value` → `[:HAS_BENEFIT]` → `Benefit`.
- **Implementation**: `Project` → `[:USES_APPROACH]` → `Approach` → `[:HAS_PLAN]` → `Plan`.
- **Organization**: `Project` → `[:INVOLVES]` → `Team` → `[:HAS_ROLE]` → `Role` → `[:RESPONSIBLE_FOR]` → `Responsibility`.
- **Technical**: `Project` → `[:USES_TECH]` → `Technology` (bridges both domains).

---

## ⚙️ 3. System Infrastructure
Contains internal nodes required for the AI system to function.

- **Node Label**: `__MetaContext__`
- **Usage**: Stores the GraphRAG "System Prompt" and operational instructions. It is accessed by the `get_context` tool in the YAML configuration to guide the LLM's navigation of the graph.

---

## 🛡 Enforcement Logic
The following constants in `schema_guard.py` are the authoritative source of truth for cleanup operations:
- `CORTEX_MODEL_NODES` / `CORTEX_MODEL_RELATIONSHIPS`
- `PROJECT_GRAPH_NODES` / `PROJECT_GRAPH_RELATIONSHIPS`
- `SYSTEM_NODES`

Any node or relationship found in the database that is not part of the union of these lists is considered **illegal** and targeted for removal by `audit_model.py`.
