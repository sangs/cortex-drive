import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '../src/mcp_server'))
from neo4j_connection import create_driver  # noqa: E402 — the one driver factory (S2-79)
import os
from dotenv import load_dotenv

load_dotenv()

driver = create_driver()

def recreate_index():
    with driver.session() as session:
        print("Checking for existing chunkIndex...")
        session.run("DROP INDEX chunkIndex IF EXISTS")
        
        print("Creating native vector index: chunkIndex (1536-dim, Cosine)...")
        # Neo4j 5.x exact syntax for vector.dimensions
        query = """
        CREATE VECTOR INDEX chunkIndex
        FOR (n:Chunk) ON (n.embedding)
        OPTIONS {indexConfig: {
          `vector.dimensions`: 1536,
          `vector.similarity_function`: 'cosine'
        }}
        """
        session.run(query)
        print("SUCCESS: chunkIndex created and populating.")

if __name__ == "__main__":
    try:
        recreate_index()
    finally:
        driver.close()
