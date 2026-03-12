# Ingestion Engine & Schema Guard Implementation Plan

This plan outlines the technical steps to implement data safety guardrails and an automated local file ingestion pipeline.

## Proposed Changes

### 1. Schema Guard (`schema_guard.py`)
- **[NEW] [schema_guard.py](file:///Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/schema_guard.py)**: Define Pydantic models for `Episode`, `Chunk`, `Topic`, and `Person`.
- Enforce `tenant_id` as a mandatory field in all models.
- Add validation logic for property types (e.g., embeddings as lists of floats).

### 2. Ingestion Core (`ingestion_engine.py`)
- **[NEW] [ingestion_engine.py](file:///Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/ingestion_engine.py)**: A modular pipeline that handles:
    - Text extraction/fetching.
    - LLM-based graph transformation (extracting nodes/edges).
    - Chunking and Embedding generation.
    - Neo4j Upsert (using the Schema Guard).

### 3. Local File Adapter (`ingest_local.py`)
- **[NEW] [ingest_local.py](file:///Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/ingest_local.py)**: A script that monitors the `episode_data/` directory.
- Picks up new transcripts and triggers the `IngestionEngine`.

## Verification Plan

### Automated Tests
- Unit tests for `schema_guard.py` to ensure invalid data (missing `tenant_id`) is rejected.
- Integration test for `ingestion_engine.py` using a mock Neo4j driver.

### Manual Verification
1. Drop a sample transcript into `episode_data/`.
2. Verify logs show the 4-phase pipeline executing.
3. Check Neo4j to confirm the new episode and chunks are tagged with the correct `tenant_id`.
## Future Considerations (Phase 4: Scaling)

### 1. Intermediate `File` Nodes
Instead of a direct `(Episode)-[:HAS_CHUNK]->(Chunk)` relationship with `fileName` properties on both sides, we will consider:
- `(Episode)-[:HAS_SOURCE]->(File {fileName, fileSize, uploadDate})`
- `(File)-[:CONTAINS]->(Chunk)`
**Benefit**: Enables rich metadata storage at the file level and provides a single source of truth for 2-way traversal without string redundancy.

### 2. BAML for Unstructured Sources
For high-noise inputs (web scrapes, raw media transcripts), we will implement [BAML](file:///Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/documents/baml_vs_pydantic_evaluation.md) to leverage Schema-Aligned Parsing (SAP) for greater reliability and token savings.
