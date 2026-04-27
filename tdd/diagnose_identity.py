
import os
from neo4j import GraphDatabase
from dotenv import load_dotenv

load_dotenv()

def diagnose():
    driver = GraphDatabase.driver(
        os.getenv("NEO4J_URI"), 
        auth=(os.getenv("NEO4J_USERNAME"), os.getenv("NEO4J_PASSWORD"))
    )
    uid = os.getenv("OWNER_USER_ID")
    tid = os.getenv("TENANT_ID")
    
    print(f"Checking for User: {uid}")
    print(f"Checking for Tenant: {tid}")
    
    with driver.session() as session:
        # Check User node
        res = session.run("MATCH (u:User {id: $uid}) RETURN u", uid=uid)
        user = res.single()
        if user:
            print(f"✓ Found User node: {user['u']['id']}")
        else:
            print(f"✗ User node {uid} NOT FOUND in Neo4j.")
            
        # Check Access Edges
        res = session.run("MATCH (u:User {id: $uid})-[r:HAS_ACCESS]->(n) RETURN labels(n)[0] as label, count(*) as count", uid=uid)
        edges = [record for record in res]
        if edges:
            print(f"✓ Found {sum(e['count'] for e in edges)} Access Edges:")
            for e in edges:
                print(f"  - {e['label']}: {e['count']}")
        else:
            print("✗ ZERO Access Edges found for this user.")
            
        # Check Node alignment
        res = session.run("MATCH (n) WHERE n.tenant_id = $tid RETURN labels(n)[0] as label, count(*) as count", tid=tid)
        nodes = [record for record in res]
        print(f"Nodes with tenant_id {tid}:")
        for n in nodes:
            print(f"  - {n['label']}: {n['count']}")
            
    driver.close()

if __name__ == "__main__":
    diagnose()
