import os
from neo4j import GraphDatabase
from dotenv import load_dotenv

load_dotenv()

def check_neo4j():
    uri = os.getenv("NEO4J_URI", "bolt://localhost:7687")
    user = os.getenv("NEO4J_USER", "neo4j")
    password = os.getenv("NEO4J_PASSWORD", "password")
    
    driver = GraphDatabase.driver(uri, auth=(user, password))
    
    with driver.session() as session:
        print("\n🔍 CHECKING PUBLIC LANDMARK 'Neo4j'...")
        res = session.run("MATCH (n) WHERE toLower(n.name) CONTAINS 'neo4j' RETURN n.name as name, labels(n) as labels")
        recs = list(res)
        if recs:
            for r in recs:
                print(f"✅ Found node: '{r['name']}' with labels: {r['labels']}")
        else:
            print("❌ ERROR: No node matching 'neo4j' found.")

    driver.close()

if __name__ == "__main__":
    check_neo4j()
