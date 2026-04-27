import os
from dotenv import load_dotenv

load_dotenv("/Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/.env")

from neo4j import GraphDatabase

driver = GraphDatabase.driver(
    os.environ["NEO4J_URI"],
    auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"])
)

print("--- Inspecting 2 Podcast nodes ---")
query_podcast = "MATCH (n:Podcast) WHERE n.name IS NULL RETURN properties(n) as props"

print("--- Inspecting 16 unlabeled nodes ---")
query_unlabeled = "MATCH (n) WHERE labels(n) = [] RETURN properties(n) as props"

with driver.session() as session:
    print("Podcasts:")
    for r in session.run(query_podcast):
        print(r['props'])
    
    print("\nUnlabeled Nodes:")
    for r in session.run(query_unlabeled):
        print(r['props'])

driver.close()
