import os
from neo4j import GraphDatabase

def cleanup():
    uri = os.environ.get("NEO4J_URI", "neo4j+s://2236ba22.databases.neo4j.io")
    user = os.environ.get("NEO4J_USERNAME", "neo4j")
    password = os.environ.get("NEO4J_PASSWORD")
    tenant_id = "org_3AacpFBbt39hPmDKyZyNBQuuM6t"

    if not password:
        print("Error: NEO4J_PASSWORD not set")
        return

    driver = GraphDatabase.driver(uri, auth=(user, password))
    with driver.session() as session:
        # Delete duplicate hackathons, thought leadership and achievements
        query = """
        MATCH (n) 
        WHERE (n:Hackathon OR n:ThoughtLeadership OR n:Achievement OR n:Outcome) 
          AND n.tenant_id = $tenant_id
        DETACH DELETE n
        """
        print(f"Cleaning up legacy nodes for tenant {tenant_id}...")
        result = session.run(query, tenant_id=tenant_id)
        summary = result.consume()
        print(f"Deleted {summary.counters.nodes_deleted} nodes and {summary.counters.relationships_deleted} relationships.")

    driver.close()

if __name__ == "__main__":
    cleanup()
