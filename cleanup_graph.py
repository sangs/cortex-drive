import os
from dotenv import load_dotenv

load_dotenv("/Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/.env")

from neo4j import GraphDatabase

driver = GraphDatabase.driver(
    os.environ["NEO4J_URI"],
    auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"])
)

with driver.session() as session:
    # 1. Delete phantom nodes (no labels, no properties)
    print("Deleting phantom nodes...")
    res_del = session.run("MATCH (n) WHERE labels(n) = [] AND properties(n) = {} DELETE n")
    print(f"Deleted {res_del.consume().counters.nodes_deleted} phantom nodes.")

    # 2. Sync Podcast title to name
    print("Syncing Podcast titles to names...")
    res_sync = session.run("MATCH (n:Podcast) WHERE n.name IS NULL AND n.title IS NOT NULL SET n.name = n.title")
    print(f"Synced {res_sync.consume().counters.properties_set} Podcast nodes.")

driver.close()
