import os
from dotenv import load_dotenv

load_dotenv("/Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/.env")

from neo4j import GraphDatabase

driver = GraphDatabase.driver(
    os.environ["NEO4J_URI"],
    auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"])
)

query = """
MATCH (n)
WHERE n.name IS NULL AND n.id IS NULL
RETURN labels(n) as Labels, count(n) as Count
"""

with driver.session() as session:
    res = session.run(query)
    found = False
    for r in res:
        found = True
        print(f"Found {r['Count']} anonymous nodes with labels: {r['Labels']}")
    if not found:
        print("✅ Audit passed: All nodes have either a 'name' or an 'id'.")

driver.close()
