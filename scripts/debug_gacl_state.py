import os
from neo4j import GraphDatabase
from dotenv import load_dotenv

load_dotenv()

def debug_gacl():
    uri = os.getenv("NEO4J_URI", "bolt://localhost:7687")
    user = os.getenv("NEO4J_USER", "neo4j")
    password = os.getenv("NEO4J_PASSWORD", "password")
    
    owner_id = os.getenv("OWNER_USER_ID", "user_3AadvqIme5F12afWwde9nv92T5R")
    
    driver = GraphDatabase.driver(uri, auth=(user, password))
    
    with driver.session() as session:
        print(f"\n🔍 DEBUGGING G-ACL STATE FOR USER: {owner_id}")
        
        # 1. Inspect User Node
        print("\n--- [1] User Identity ---")
        res1 = session.run("MATCH (u:User {id: $uid}) RETURN u", uid=owner_id)
        if res1.peek():
            user_node = res1.single()['u']
            print(f"✅ Found User: {dict(user_node)}")
        else:
            print("❌ ERROR: User node not found with id:", owner_id)
            res_all = session.run("MATCH (u:User) RETURN u.id LIMIT 5")
            print("Existing User IDs:", [r['u.id'] for r in res_all])
        
        # 2. Inspect Professional Hub
        print("\n--- [2] Professional Hub ---")
        res2 = session.run("MATCH (p:Person {name: 'Sangeetha Ramadurai'}) RETURN labels(p) as labels, p.tenant_id as tid")
        if res2.peek():
            rec = res2.single()
            print(f"✅ Found Person Hub: labels={rec['labels']}, tenant_id={rec['tid']}")
        else:
            print("❌ ERROR: Person hub 'Sangeetha Ramadurai' not found.")
            res_any = session.run("MATCH (p:Person) RETURN p.name LIMIT 5")
            print("Existing Person names:", [r['p.name'] for r in res_any])

        # 3. Inspect Path
        print("\n--- [3] Identity -> Hub Path ---")
        res3 = session.run("""
            MATCH (u:User {id: $uid})-[r]-(p:Person {name: 'Sangeetha Ramadurai'})
            RETURN type(r) as type, properties(r) as props
        """, uid=owner_id)
        paths = list(res3)
        if paths:
            for p in paths:
                print(f"✅ Found Relationship: -[:{p['type']}]-> with {p['props']}")
        else:
            print("❌ ERROR: No path found between User and Person Hub.")

        # 4. Impact Migration Check
        print("\n--- [4] Ownership Sample ---")
        res4 = session.run("""
            MATCH (u:User {id: $uid})-[r:OWNS|HAS_ACCESS]-(n)
            WHERE NOT n:Person
            RETURN labels(n) as labels, n.name as name, type(r) as type LIMIT 5
        """, uid=owner_id)
        recs = list(res4)
        if recs:
            for r in recs:
                print(f"✅ Owned: {r['name']} ({r['labels']}) via {r['type']}")
        else:
            print("❌ ERROR: No ownership migration detected.")

    driver.close()

if __name__ == "__main__":
    debug_gacl()
