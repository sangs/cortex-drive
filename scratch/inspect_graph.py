import os
import sys
import json
from dotenv import load_dotenv
from neo4j import GraphDatabase

load_dotenv('.env', override=True)
uri = os.environ.get("NEO4J_URI")
user = os.environ.get("NEO4J_USERNAME")
password = os.environ.get("NEO4J_PASSWORD")
tenant_id = os.environ.get("TENANT_ID")

driver = GraphDatabase.driver(uri, auth=(user, password))

def inspect_node(name):
    query = """
    MATCH (n)
    WHERE n.name CONTAINS $name
    RETURN labels(n) as labels, n.name as name, n.tenant_id as tenant_id
    """
    with driver.session() as session:
        result = session.run(query, name=name)
        nodes = []
        for record in result:
            nodes.append({
                "name": record["name"],
                "labels": record["labels"],
                "tenant_id": record["tenant_id"]
            })
        return nodes

def inspect_neighbors(name):
    query = """
    MATCH (n)-[r]-(m)
    WHERE n.name CONTAINS $name
    RETURN labels(m) as labels, m.name as name, type(r) as rel
    """
    with driver.session() as session:
        result = session.run(query, name=name)
        neighbors = []
        for record in result:
            neighbors.append({
                "name": record["name"],
                "labels": record["labels"],
                "rel": record["rel"]
            })
        return neighbors

print("--- Anchor Nodes (Sangeetha) ---")
print(json.dumps(inspect_node("Sangeetha"), indent=2))

print("\n--- Neighbors (Sangeetha) ---")
print(json.dumps(inspect_neighbors("Sangeetha")[:10], indent=2))

driver.close()
