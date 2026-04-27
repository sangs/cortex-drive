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
                parts = line.strip().split("=", 1)
                if len(parts) == 2:
                    env_vars[parts[0]] = parts[1]

driver = GraphDatabase.driver(
    env_vars.get("NEO4J_URI"),
    auth=(env_vars.get("NEO4J_USERNAME"), env_vars.get("NEO4J_PASSWORD"))
)

def test_full_query():
    # This matches the structure in expert_tools.py
    query = """
    WITH split(toLower(coalesce($keyword, "")), ' ') AS keywords
    MATCH (node)
    WHERE node.tenant_id = $tenant_id
      AND any(label IN labels(node) WHERE label IN ['Project', 'Role', 'Company', 'Technology', 'Category'])
    
    OPTIONAL MATCH (parentCat:Category)-[:CONTAINS]->(node)
    WHERE parentCat.tenant_id = $tenant_id

    OPTIONAL MATCH (node)-[:AT|GRADUATED_FROM|HELD_ROLE|PARTICIPATED_IN|CONTRIBUTED_TO*1..2]-(comp:Company)
    WHERE comp.tenant_id IS NULL OR comp.tenant_id = $tenant_id
    
    WITH node, keywords, parentCat, comp
    WHERE (
            any(word IN keywords WHERE toLower(node.name) CONTAINS word)
            OR (any(word IN keywords WHERE word IN ['jpmc']) AND (node:Project OR node:Role))
    )
    
    OPTIONAL MATCH (p:Person {tenant_id: $tenant_id})-[directRel:CURRENTLY_BUILDING|HELD_ROLE|CONTRIBUTED_TO]-(node)
    OPTIONAL MATCH (p:Person {tenant_id: $tenant_id})-[:HELD_ROLE|AT]-(role:Role)-[multiRel:CONTRIBUTED_TO]-(node)
    WHERE node:Project
    
    WITH node, keywords, parentCat, comp, coalesce(directRel, multiRel) AS roleRel, coalesce(role, {}) AS role
    
    RETURN node.name as name, roleRel.start as start, roleRel.end as end, 
           (CASE WHEN roleRel.end = 'Present' THEN '2026' WHEN roleRel.end IS NOT NULL THEN right(roleRel.end, 4) ELSE null END) as year
    LIMIT 5
    """
    
    with driver.session() as session:
        try:
            print("Running full query test...")
            res = session.run(query, tenant_id=env_vars.get("TENANT_ID"), keyword="jpmc projects")
            for record in res:
                print(record.data())
        except Exception as e:
            print(f"CYPHER ERROR: {str(e)}")

test_full_query()
driver.close()
