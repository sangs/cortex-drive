# CortexDrive: Invalid Schema Analysis (Pre-Cleanup)

This document identifies the labels and relationships that are outside the approved schema as of March 10, 2026. These items are targeted for removal or migration during the cleanup phase.

---

## ⚠️ 1. Invalid Node Labels
These labels were primarily created by unconstrained LLM extraction during earlier iterations of the ingestion pipeline or imported from external project-based scripts.

### Infrastructure & Technology (Leaked by LLM)
These labels represent specific types of technologies that should have been generalized under the `Technology` label.
- **Labels**: `Programming language`, `Library`, `Engine`, `Framework`, `Database`, `Storage`, `Protocol`, `File format`, `Ecosystem`, `Ide extension`.
- **Reason for Invalidity**: The schema requires these to be classified as `Technology`. Keeping them separate creates a fragmented graph and complicates search tool logic.

### Organizational & Contextual
Nodes that represent external entities not central to the Podcast or Person Intro core domains.
- **Labels**: `Company`, `Organization`, `University`, `Platform`.
- **Reason for Invalidity**: These are "out-of-bounds" entities. Relevant professional history should be captured via properties on `Person` or specific `Project` nodes rather than dedicated labels.

### Specific Objects & Miscellaneous
- **Labels**: `Product`, `Application`, `Document`, `Book`, `Field`, `Model`.
- **Reason for Invalidity**: These were extracted as standalone nodes but lack a designated "home" in the current schema logic. Many are overlaps with `Technology` or `Concept`.

---

## 🔗 2. Invalid Relationships
These relationships connect nodes in ways that are not supported by our current `ExpertTools` or `IngestionEngine` logic.

### Technical Integration (Over-specified)
- **Relationships**: `INTEGRATES_WITH`, `USES`, `USED_IN`, `INTERACTS_WITH`, `REPLACES`, `SUPPORTS`.
- **Source**: Primarily from project-based extractions (e.g., "BAML integrates with VS Code").
- **Clean-up Action**: These items should be simplified to `[:COVERS_TECHNOLOGY]` or dropped if they relate to non-schema nodes.

### Professional & Biography (Legacy)
- **Relationships**: `WORKED_AT`, `WORKED_ON`, `WORKS_AT`, `MEMBER_OF`, `EDUCATED_AT`, `STARTED_CAREER_AS`, `CEO_OF`, `AUTHORED`.
- **Source**: Inferred by LLMs when reading guest biographies.
- **Clean-up Action**: Biography data will be stored as property metadata on `Person` nodes rather than standalone relationships to ensure graph traversals stay focused on content.

### Meta & Relational
- **Relationships**: `RELATED_TO`, `SIMILAR_TO`, `COMPETITOR`, `INFLUENCED_BY`, `CREATOR`, `CREATED_BY`, `DEVELOPS`.
- **Reason for Invalidity**: These are generic and lack the "semantic weight" required for our kNN and GraphRAG algorithms.

---

## 🛠 Cleanup Strategy
The **[`audit_model.py`](file:///Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/audit_model.py)** script handles these as follows:
1.  **Nodes**: Any node with a label not in `CORTEX_MODEL_NODES`, `PROJECT_GRAPH_NODES`, or `SYSTEM_NODES` is detached and deleted.
2.  **Relationships**: Any relationship type not in the approved lists is deleted, even if the source and target nodes are valid.

> [!IMPORTANT]
> This "pruning" ensures that the `search_episodes_gds_by_question` tool returns high-signal data without being distracted by noisy, unconstrained LLM extractions.
