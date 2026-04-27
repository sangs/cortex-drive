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

def run_query(query):
    with driver.session() as session:
        try:
            print(f"\n--- Running Debug Query ---")
            res = session.run(query, tenant_id=env_vars.get("TENANT_ID"), keywords=["jpmc", "recent"])
            for record in res:
                print(json.dumps(record.data(), indent=2))
        except Exception as e:
            print(f"ERROR: {str(e)}")

# Test the core logic of search_resume_graph
debug_query = """
MATCH (node)
WHERE node:Project OR node:Role
OPTIONAL MATCH (node)-[:AT|GRADUATED_FROM|HELD_ROLE|PARTICIPATED_IN|CONTRIBUTED_TO*1..2]-(comp:Company)
WITH node, comp
WHERE (any(word IN $keywords WHERE toLower(node.name) CONTAINS word)
       OR (any(word IN $keywords WHERE toLower(word) IN ['jpmc', 'jpmorgan', 'chase']) AND toLower(comp.name) CONTAINS "jpmorgan"))

OPTIONAL MATCH (p:Person {tenant_id: $tenant_id})-[directRel:CONTRIBUTED_TO|HELD_ROLE]-(node)
OPTIONAL MATCH (p:Person {tenant_id: $tenant_id})-[:HELD_ROLE|AT]-(role:Role)-[multiRel:CONTRIBUTED_TO]-(node)
WHERE node:Project

WITH node, coalesce(directRel, multiRel) AS roleRel, role
RETURN node.name, roleRel.start, roleRel.end, role.name, role.start, role.end
LIMIT 5
"""

run_query(debug_query)
driver.close()
