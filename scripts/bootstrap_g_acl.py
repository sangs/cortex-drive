"""
Bootstrap G-ACL: Formally link the Owner's identity to the Knowledge Graph.
This script creates the (:User) node and establishes (:HAS_ACCESS) relationships
to all primary hub nodes (Projects, Episodes, Roles, etc.) to enable path-based auth.
"""

import os
from neo4j import GraphDatabase
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

NEO4J_URI = os.getenv("NEO4J_URI")
NEO4J_USERNAME = os.getenv("NEO4J_USERNAME")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD")
OWNER_USER_ID = os.getenv("OWNER_USER_ID")
TENANT_ID = os.getenv("TENANT_ID")

if not OWNER_USER_ID:
    print("Error: OWNER_USER_ID not found in .env")
    exit(1)

def bootstrap_g_acl():
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USERNAME, NEO4J_PASSWORD))
    
    with driver.session() as session:
        # 1. Ensure the User node exists
        print(f"Upserting User node for ID: {OWNER_USER_ID}")
        session.run("""
        MERGE (u:User {id: $user_id})
        SET u.clerk_id = $user_id,
            u.role = 'Admin',
            u.last_bootstrap = datetime(),
            u.tenant_id = $tenant_id
        """, user_id=OWNER_USER_ID, tenant_id=TENANT_ID)

        # 2. Grant access to all 'Hub' nodes (structural containers)
        # We target Projects, Roles, Episodes, Companies, etc.
        print("Linking User to all primary Hub nodes...")
        hub_labels = ['Project', 'Role', 'Company', 'Episode', 'Publication', 'Hackathon', 'Certification', 'Person']
        
        result = session.run("""
        MATCH (u:User {id: $user_id})
        MATCH (h)
        WHERE any(label IN labels(h) WHERE label IN $hub_labels)
        AND h.tenant_id = $tenant_id
        MERGE (u)-[r:HAS_ACCESS]->(h)
        SET r.grantedAt = datetime(), r.level = 'OWNER'
        RETURN count(r) as link_count
        """, user_id=OWNER_USER_ID, tenant_id=TENANT_ID, hub_labels=hub_labels)
        
        link_count = result.single()["link_count"]
        print(f"Success: Created {link_count} HAS_ACCESS relationships.")

    driver.close()

if __name__ == "__main__":
    bootstrap_g_acl()
