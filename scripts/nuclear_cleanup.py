import os
from neo4j import GraphDatabase
from dotenv import load_dotenv

# Load configuration
dotenv_path = os.path.join(os.getcwd(), ".env")
load_dotenv(dotenv_path)

def nuclear_cleanup():
    uri = os.getenv("NEO4J_URI")
    user = os.getenv("NEO4J_USERNAME")
    pwd = os.getenv("NEO4J_PASSWORD")
    tenant_id = os.getenv("TENANT_ID", "org_3AacpFBbt39hPmDKyZyNBQuuM6t")

    if not uri:
        print("❌ NEO4J_URI not found in .env")
        return

    print(f"🚀 Starting Nuclear Cleanup for tenant: {tenant_id}...")
    
    driver = GraphDatabase.driver(uri, auth=(user, pwd))
    with driver.session() as session:
        # 1. Delete professional resume nodes
        delete_query = """
        MATCH (n)
        WHERE (n:Project OR n:Hackathon OR n:ThoughtLeadership OR n:Category OR n:Role OR n:Achievement OR n:Outcome OR n:PreparatoryNote OR n:ReferenceLink)
          AND n.tenant_id = $tenant_id
        DETACH DELETE n
        """
        result = session.run(delete_query, tenant_id=tenant_id)
        summary = result.consume()
        print(f"✅ Deleted {summary.counters.nodes_deleted} professional nodes.")

        # 2. Optional: Delete legacy podcast nodes if they are cluttering
        # (Commented out to preserve user's podcast data unless explicitly requested)
        # session.run("MATCH (n) WHERE (n:Episode OR n:Topic OR n:Chunk) AND n.tenant_id = $tenant_id DETACH DELETE n", tenant_id=tenant_id)

    driver.close()
    print("------------------------------------------")
    print("✨ Cleanup complete. Ready for re-seeding.")

if __name__ == "__main__":
    nuclear_cleanup()
