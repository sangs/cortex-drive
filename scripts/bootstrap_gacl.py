import os
from neo4j import GraphDatabase
from dotenv import load_dotenv

load_dotenv()

def bootstrap_gacl():
    uri = os.getenv("NEO4J_URI", "bolt://localhost:7687")
    user = os.getenv("NEO4J_USER", "neo4j")
    password = os.getenv("NEO4J_PASSWORD", "password")
    
    # IDENTITY BRIDGE: We bridge the individual Clerk 'sub' with the organizational context
    primary_user_id = os.getenv("OWNER_USER_ID") or os.getenv("PRIMARY_USER_ID")
    legacy_org_id = os.getenv("TENANT_ID")
    
    if not primary_user_id or not legacy_org_id:
        print("❌ ERROR: OWNER_USER_ID or TENANT_ID environment variable is missing.")
        return

    driver = GraphDatabase.driver(uri, auth=(user, password))
    
    with driver.session() as session:
        print(f"🚀 Initializing G-ACL Identity Backbone for User: {primary_user_id}...")
        
        # 1. Ensure Uniqueness Constraint for User(id)
        session.run("CREATE CONSTRAINT user_id_unique IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE")
        
        # 2. Create the Primary User Node
        session.run("""
            MERGE (u:User {id: $uid})
            SET u.clerk_id = $uid, u.role = 'ADMIN', u.createdAt = timestamp()
        """, uid=primary_user_id)
        
        # 3. Link User to the Professional Person Hub (The 'Knowledge Twin')
        # We assume the resume seeder created 'Sangeetha Ramadurai'
        session.run("""
            MATCH (u:User {id: $uid})
            MATCH (p:Person {name: 'Sangeetha Ramadurai'})
            MERGE (u)-[:REPRESENTS]->(p)
            MERGE (u)-[:OWNS]->(p)
            MERGE (u)-[:HAS_ACCESS {level: 'OWNER'}]->(p)
        """, uid=primary_user_id)
        
        # 4. Propagate recursive ownership to all existing professional nodes (Initial Migration)
        # We bridge the legacy Organizational data to the new User ownership
        print(f"🛠️  Migrating legacy Org data ({legacy_org_id}) to User ownership ({primary_user_id})...")
        session.run("""
            MATCH (u:User {id: $uid})
            MATCH (n) WHERE n.tenant_id = $org_id AND NOT n:User
            MERGE (u)-[:OWNS]->(n)
            MERGE (u)-[:HAS_ACCESS {level: 'OWNER'}]->(n)
        """, uid=primary_user_id, org_id=legacy_org_id)

    driver.close()
    print("✅ G-ACL Bootstrap Complete. Identity and Ownership established.")

if __name__ == "__main__":
    bootstrap_gacl()
