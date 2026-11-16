#!/usr/bin/env python3
"""
create_node_metadata_vector_index.py — Creates the nodeMetadataIndex vector index.

Mirrors recreate_vector_index.py's chunkIndex pattern exactly, but targets the shared
:Embeddable label (stamped by scripts/backfill_node_embeddings.py on every node whose
label is in domain_registry.EMBEDDABLE_LABELS) instead of a single node type — one index
covers every embeddable type instead of ~15 per-label indexes.

See: documents/architecture/node-metadata-embedding-hybrid-retrieval-2026-09-04.md §2.4

Run manually:
    .venv/bin/python scripts/create_node_metadata_vector_index.py
"""

import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '../src/mcp_server'))
from neo4j_connection import create_driver  # noqa: E402 — the one driver factory (S2-79)
import os
from dotenv import load_dotenv

load_dotenv()

driver = create_driver()


def create_index():
    with driver.session() as session:
        print("Checking for existing nodeMetadataIndex...")
        session.run("DROP INDEX nodeMetadataIndex IF EXISTS")

        print("Creating native vector index: nodeMetadataIndex (1536-dim, Cosine, :Embeddable)...")
        # Neo4j 5.x exact syntax for vector.dimensions
        query = """
        CREATE VECTOR INDEX nodeMetadataIndex
        FOR (n:Embeddable) ON (n.metadata_embedding)
        OPTIONS {indexConfig: {
          `vector.dimensions`: 1536,
          `vector.similarity_function`: 'cosine'
        }}
        """
        session.run(query)
        print("SUCCESS: nodeMetadataIndex created and populating.")


if __name__ == "__main__":
    try:
        create_index()
    finally:
        driver.close()
