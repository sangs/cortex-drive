import os
import sys
import json
from neo4j import GraphDatabase

# Load .env
env_vars = {}
if os.path.exists(".env"):
    with open(".env", "r") as f:
        for line in f:
            if "=" in line and not line.startswith("#"):
                key, value = line.strip().split("=", 1)
                env_vars[key] = value

driver = GraphDatabase.driver(
    env_vars.get("NEO4J_URI"),
    auth=(env_vars.get("NEO4J_USERNAME"), env_vars.get("NEO4J_PASSWORD"))
)

def check_project(name):
    with driver.session() as session:
        print(f"\n--- Checking Project: {name} ---")
        # Check node
        node_res = session.run("MATCH (n {name: $name}) RETURN n, labels(n)", name=name)
        node = node_res.single()
        if node:
            print(f"Node Info: {dict(node['n'])} {node['labels']}")
        else:
            print("Node NOT FOUND")
            return

        # Check relationships to Person
        rel_res = session.run("""
            MATCH (p:Person)-[r]-(n {name: $name})
            RETURN type(r) as type, properties(r) as props, labels(p) as labels
        """, name=name)
        for r in rel_res:
            print(f"Direct Rel: {r['type']} {r['props']}")

        # Check multi-hop relationships
        hop_res = session.run("""
            MATCH (p:Person)-[]-(role:Role)-[r]-(n {name: $name})
            RETURN type(r) as type, properties(r) as props, role.name as role_name
        """, name=name)
        for h in hop_res:
            print(f"Multi-hop Rel (via {h['role_name']}): {h['type']} {h['props']}")

check_project("Instrument Data on DataMesh")
check_project("Metadata Agent Architecture")
driver.close()
