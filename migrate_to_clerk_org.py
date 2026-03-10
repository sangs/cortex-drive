import os
import sys
from neo4j import GraphDatabase

def migrate_tenant_id(org_id: str):
    """
    Migration script to retroactively tag all nodes in Neo4j with a Clerk Org ID.
    
    Args:
        org_id (str): The Clerk Organization ID (e.g., 'org_2nb8...')
    """
    uri = os.environ.get("NEO4J_URI")
    user = os.environ.get("NEO4J_USERNAME")
    password = os.environ.get("NEO4J_PASSWORD")

    if not all([uri, user, password]):
        print("Error: Missing NEO4J environment variables.")
        sys.exit(1)

    driver = GraphDatabase.driver(uri, auth=(user, password))
    
    query = """
    MATCH (n) 
    WHERE n.tenant_id IS NULL OR n.tenant_id = 'test_tenant' OR n.tenant_id = 'test_tenant_1'
    WITH n LIMIT 5000
    SET n.tenant_id = $org_id
    RETURN count(n) as count
    """
    
    total_updated = 0
    try:
        with driver.session() as session:
            while True:
                result = session.run(query, org_id=org_id)
                count = result.single()["count"]
                if count == 0:
                    break
                total_updated += count
                print(f"Updated {total_updated} nodes...")
                
        print(f"Migration complete! Total nodes updated: {total_updated}")
    finally:
        driver.close()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python migrate_to_clerk_org.py <CLERK_ORG_ID>")
        sys.exit(1)
    
    target_org_id = sys.argv[1]
    migrate_tenant_id(target_org_id)
