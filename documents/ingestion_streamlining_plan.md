# CortexDrive: Streamlined Ingestion Implementation Plan

This document outlines how to bridge the current 10-step manual process into a unified, multi-scenario **Ingestion Engine**.

## 1. The Strategy: Functional Consolidation

We will consolidate the disparate Jupyter Notebook logic into a single **Modular Ingestion Pipeline** consisting of four distinct stages.

### Phase A: Source Adapters (The "Intake")
Handles the four scenarios mentioned:
1. **LocalFileAdapter (Phase 1 Priority)**: Monitors a `TRANSCRIPT_DIR` and picks up new text files.
2. **UploadAdapter**: REST endpoint for direct multipart/file uploads.
3. **UrlAdapter**: Web scraper that extracts clean text from a provided URL.
4. **MediaAdapter**: Uses `yt-dlp` + **Whisper** to convert audio/video into transcripts.

---

### Phase B: Decomposition & Transformation
*Consolidates legacy Steps 1 & 2.*
- **LLM Graph Transformer**: Extracts entities (Person, Technology, Topic) and relationships.
- **Semantic Chunking**: Breaks text into overlapping segments with metadata (Episode #, Tenant ID).

---

### Phase C: The "Atomic" Upsert
*Consolidates legacy Steps 3, 5, & 6.*
- Uses the **Schema Guard** to ensure every node has a `tenant_id`.
- Performs a single multi-stage transaction in Neo4j (MERGE).
- Automatically cleans up artifacts (like the legacy "Node 0" issue).

---

### Phase D: Enrichment & Projection
*Consolidates legacy Steps 7, 8, 9, & 10.*
- **Batch Embedding**: Triggers vector creation for all nodes (Episode, Chunk, Topic).
- **Knowledge Mesh Links**: Runs the GDS KNN projected graph to link semantically similar episodes.

---

## 2. Technical Architecture: The "Worker" Model

To support future scalability, we will implement this as an **Asynchronous Task Queue**.

| Component | Responsibility |
| :--- | :--- |
| **Ingestion API** | Entry point for URLs/Files; validates `tenant_id`. |
| **Worker Queue** | Manages high-latency tasks (Whisper transcription, LLM extraction). |
| **Ingestion Worker** | Python script executing Phases B, C, and D. |
| **Status SSE** | Pumps status updates back to the UI (e.g., "Chunking complete"). |

---

## 3. Phase 1 Priority: `LocalFileIngestor`

For the immediate implementation, we will build a simplified version of this engine that focuses on Scenario 1.

**Configuration**:
```bash
# .env
TRANSCRIPT_DRIVE_PATH="/Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/episode_data"
ENABLE_AUTO_INGESTION=true
```

**Execution Flow**:
1. Script `ingest_local.py` watches the directory.
2. When a file like `episode_205.txt` appears, it triggers the pipeline.
3. Automatically applies the `DEFAULT_TENANT_ID` if not specified.
4. Runs the consolidated Transformation (Phase B) and Enrichment (Phase D).

---

## 4. Verification Plan

### Manual Verification
1. Drop a new transcript into the `episode_data` folder.
2. Monitor log: `Processing Episode 205... [Labels Extracted] [Embeddings Generated].`
3. Verify in Neo4j Browser: `MATCH (n {tenant_id: 'org_test'}) RETURN n`.
4. Verify in UI: The New Episode should appear in the Graph View automatically after refresh.
