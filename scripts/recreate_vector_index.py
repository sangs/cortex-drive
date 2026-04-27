from neo4j import GraphDatabase
import os
from dotenv import load_dotenv

load_dotenv()

driver = GraphDatabase.driver(
    os.environ.get("NEO4J_URI"), 
    auth=(os.environ.get("NEO4J_USERNAME"), os.environ.get("NEO4J_PASSWORD"))
)

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
