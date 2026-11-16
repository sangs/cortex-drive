import os
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '../src/mcp_server'))
from neo4j_connection import create_driver  # noqa: E402 — the one driver factory (S2-79)
from dotenv import load_dotenv

load_dotenv()

def check_neo4j():
    uri = os.getenv("NEO4J_URI", "bolt://localhost:7687")
    user = os.getenv("NEO4J_USER", "neo4j")
    password = os.getenv("NEO4J_PASSWORD", "password")
    
    driver = create_driver()
    
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
