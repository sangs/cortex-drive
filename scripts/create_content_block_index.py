"""
Create the ContentBlock vector index for Phase B documents (M2).

Idempotent: CREATE ... IF NOT EXISTS, never drops anything (unlike recreate_vector_index.py, which
rebuilds chunkIndex). Neo4j vector indexes are single-label, so ContentBlock needs its own index
next to chunkIndex (multimodal-document-processing-pipeline-2026-08-19.md §9.2).

    .venv/bin/python scripts/create_content_block_index.py
"""
import os

from dotenv import load_dotenv
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '../src/mcp_server'))
from neo4j_connection import create_driver  # noqa: E402 — the one driver factory (S2-79)

INDEX_NAME = "contentBlockIndex"
INDEX_LABEL = "ContentBlock"
INDEX_PROPERTY = "embedding"
DIMENSIONS = 1536            # text-embedding-3-small, same as chunkIndex
SIMILARITY = "cosine"


def main() -> None:
    load_dotenv()
    driver = create_driver()
    try:
        with driver.session() as session:
            session.run(f"""
                CREATE VECTOR INDEX {INDEX_NAME} IF NOT EXISTS
                FOR (n:{INDEX_LABEL}) ON (n.{INDEX_PROPERTY})
                OPTIONS {{indexConfig: {{
                  `vector.dimensions`: {DIMENSIONS},
                  `vector.similarity_function`: '{SIMILARITY}'
                }}}}""")
            rec = session.run("SHOW VECTOR INDEXES YIELD name, labelsOrTypes, properties, state "
                              "WHERE name = $name RETURN name, labelsOrTypes, properties, state",
                              name=INDEX_NAME).single()
            print(f"{rec['name']}: {rec['labelsOrTypes']} {rec['properties']} state={rec['state']}")
    finally:
        driver.close()


if __name__ == "__main__":
    main()
