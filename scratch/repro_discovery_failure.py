import os
import json
from neo4j import GraphDatabase
from dotenv import load_dotenv

load_dotenv()

uri = os.environ.get("NEO4J_URI")
user = os.environ.get("NEO4J_USERNAME")
password = os.environ.get("NEO4J_PASSWORD")
tenant_id = os.environ.get("TENANT_ID")
user_id = os.environ.get("OWNER_USER_ID")

driver = GraphDatabase.driver(uri, auth=(user, password))

QUERY = """
OPTIONAL MATCH (u:User {id: $requesting_user_id})
MATCH (n)
WHERE toLower(n.name) CONTAINS toLower($node_name)
  AND (
    coalesce(n.tenant_id, '') = $tenant_id
    OR (u)-[:HAS_ACCESS|OWNS|REPRESENTS|OWNS_IDENTITY|IDENTITY_OF*0..3]->(n) 
    OR any(l IN labels(n) WHERE l IN $public_labels)
  )
OPTIONAL MATCH path = (n)-[*1..1]-(m)
WHERE (coalesce(m.tenant_id, '') = $tenant_id OR (u)-[:HAS_ACCESS|OWNS]->(m) OR any(label IN labels(m) WHERE label IN $public_labels))
AND ALL(node IN nodes(path) WHERE coalesce(node.tenant_id, '') = $tenant_id OR (u)-[:HAS_ACCESS|OWNS]->(node) OR any(label IN labels(node) WHERE label IN $public_labels))
RETURN n.name as seed, m.name as neighbor, labels(m) as labels
"""

def repro():
    public_labels = ["Category", "Technology", "Company", "Institution", "Skill", "Degree", "ProfessionalEducation", "Year", "Community"]
    
    with driver.session() as session:
        print(f"--- Running Repro for {tenant_id} ---")
        result = session.run(QUERY, {
            "node_name": "Sangeetha",
            "tenant_id": tenant_id,
            "requesting_user_id": user_id,
            "public_labels": public_labels
        })
        
        found = False
        for record in result:
            found = True
            print(f"Seed: {record['seed']} -> Neighbor: {record['neighbor']} ({record['labels']})")
        
        if not found:
            print("!!! NO RESULTS RETURNED !!!")

if __name__ == "__main__":
    repro()
    driver.close()
