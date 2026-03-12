# Ingestion Engine Test Guide

This document provides step-by-step instructions for testing the automated ingestion pipeline and schema guardrails.

## Prerequisites
- **Neo4j**: Database must be running and accessible via the credentials in `.env`.
- **OpenAI API Key**: Required for generating semantic embeddings during ingestion.
- **Python Environment**: Ensure `watchdog`, `pydantic`, `openai`, and `neo4j` are installed in your virtual environment.

---

## 1. Configuration
Ensure your `.env` file contains the following variables for the ingestion engine:

```bash
# Multi-Tenancy
DEFAULT_TENANT_ID="org_test_123"

# Ingestion Settings
TRANSCRIPT_DIR="./episode_data"
OPENAI_API_KEY="sk-..."
NEO4J_URI="bolt://localhost:7687"
NEO4J_USERNAME="neo4j"
NEO4J_PASSWORD="your_password"
```

---

## 2. Running the Local Ingestion Watcher
The watcher monitors a directory and automatically triggers the ingestion engine when a new transcript file is added.

1. **Start the watcher**:
   ```bash
   python ingest_local.py
   ```
2. **Verify output**: You should see:
   ```text
   CortexDrive Local Ingestion Watcher started.
   Watching: ./episode_data
   Tenant ID: org_test_123
   ```

---

## 3. Performing a Test Ingestion
1. **Prepare a transcript**: Create a text file named `episode_999.txt` with some sample podcast transcript content.
2. **Drop the file**: Move or save this file into the `./episode_data` folder.
3. **Monitor the terminal**: You should see logs indicating:
   - Detection of the new file.
   - Validation against `schema_guard.py`.
   - Creation of semantic chunks and embeddings.
   - Successful upsert into Neo4j.

---

## 4. Verifying Results in Neo4j
Run the following Cypher query in your Neo4j Browser to verify the data was ingested and correctly tagged:

```cypher
MATCH (e:Episode {number: 999})-[:HAS_CHUNK]->(c:Chunk)
RETURN e.name, e.tenant_id, count(c) as ChunkCount
```

**What to look for**:
- `e.tenant_id` should match your `DEFAULT_TENANT_ID`.
- All linked `Chunk` nodes should also have the same `tenant_id`.

---

## 5. Testing the Schema Guard (Negative Test)
To verify the guardrails work, you can try to manually trigger the engine with missing data:

1. Create a script `test_guard.py`:
   ```python
   from schema_guard import validate_upsert
   try:
       # Missing tenant_id
       validate_upsert('Episode', {'name': 'Broken Episode', 'number': 0})
   except Exception as e:
       print(f"Guardrail caught it: {e}")
   ```
2. Run it: `python test_guard.py`. It should raise a validation error.
