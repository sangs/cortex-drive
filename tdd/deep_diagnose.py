import os
from neo4j import GraphDatabase

# Load .env manually to avoid shell issues
env = {}
with open(".env", "r") as f:
    for line in f:
        if "=" in line and not line.startswith("#"):
            k, v = line.strip().split("=", 1)
            env[k] = v

tid = env.get("TENANT_ID")
driver = GraphDatabase.driver(env.get("NEO4J_URI"), auth=(env.get("NEO4J_USERNAME"), env.get("NEO4J_PASSWORD")))

with driver.session() as s:
    print(f"Dumping JPMC graph for tenant: {tid}")
    res = s.run("""
        MATCH (n) WHERE (n:Role OR n:Project OR n:Company) AND (n.name CONTAINS 'JPMC' OR n.name CONTAINS 'JPMorgan')
        MATCH (p:Person {tenant_id: $tid})
        OPTIONAL MATCH (p)-[r]-(n)
        RETURN n.name as node, labels(n) as labels, type(r) as rel_to_person, properties(r) as rel_props
    """, tid=tid)
    for rec in res:
        print(rec.data())

    print("\nChecking path P -> Role -> Project")
    res2 = s.run("""
        MATCH (p:Person {tenant_id: $tid})-[r1:HELD_ROLE]-(role:Role)-[r2:CONTRIBUTED_TO]-(pj:Project)
        RETURN p.name, role.name, pj.name, r1.start, r2.start
    """, tid=tid)
    for rec in res2:
        print(rec.data())

driver.close()
