"""
Create the ContentBlock fulltext (keyword) index for Phase B M5 document search (decision M5-2).

Idempotent: CREATE ... IF NOT EXISTS, never drops anything. Covers ContentBlock.text and
ContentBlock.description (figure descriptions from M4'), so exact terms — product names, codes, figure
content — are found even when the vector search misses them. search_document_blocks fuses this with
contentBlockIndex (vector) by reciprocal rank fusion. chunkTextIndex is the podcast precedent.

    .venv/bin/python scripts/create_content_block_text_index.py
"""
import os
import sys

from dotenv import load_dotenv
from neo4j import GraphDatabase

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "mcp_server"))
from schema_guard import DOCUMENT_BLOCK_TEXT_INDEX  # noqa: E402

INDEX_LABEL = "ContentBlock"
INDEX_PROPERTIES = ["text", "description"]


def main() -> None:
    load_dotenv()
    driver = GraphDatabase.driver(os.environ["NEO4J_URI"],
                                  auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"]))
    props = ", ".join(f"n.{p}" for p in INDEX_PROPERTIES)
    try:
        with driver.session() as session:
            session.run(f"CREATE FULLTEXT INDEX {DOCUMENT_BLOCK_TEXT_INDEX} IF NOT EXISTS "
                        f"FOR (n:{INDEX_LABEL}) ON EACH [{props}]")
            rec = session.run("SHOW FULLTEXT INDEXES YIELD name, labelsOrTypes, properties, state "
                              "WHERE name = $name RETURN name, labelsOrTypes, properties, state",
                              name=DOCUMENT_BLOCK_TEXT_INDEX).single()
            print(f"{rec['name']}: {rec['labelsOrTypes']} {rec['properties']} state={rec['state']}")
    finally:
        driver.close()


if __name__ == "__main__":
    main()
