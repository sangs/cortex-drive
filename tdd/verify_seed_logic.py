import os
import sys

# Add project root to python path so schema_guard imports correctly
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from neo4j import GraphDatabase

def verify_seed_logic():
    print("🚀 Running TDD: Seed-Time Flattening Integrity")
    tenant_id = os.getenv('TENANT_ID', 'default_tenant')
    
    driver = GraphDatabase.driver(
        os.getenv('NEO4J_URI'),
        auth=(os.getenv('NEO4J_USERNAME'), os.getenv('NEO4J_PASSWORD'))
    )
    
    query = '''
    MATCH (n {tenant_id: $tenant_id})
    WHERE (n:Project OR n:Hackathon OR n:Startup OR n:ThoughtLeadership)
    RETURN labels(n) AS labels, n.name AS name, n.description AS desc, n.links AS links
    '''
    
    faults = 0
    with driver.session() as session:
        results = session.run(query, tenant_id=tenant_id)
        
        for record in results:
            name = record['name']
            desc = record['desc']
            links = record['links']
            
            # Assert Descriptions exist and are adequately sized (Pitch Quality)
            if desc is None or len(desc.strip()) < 20:
                print(f"  ❌ FAILURE: {name} is missing a flattened description pitch.")
                faults += 1
                
            # Assert Links were populated into array format if they exist
            # Note: We don't fail if links are empty, as some projects legitimately have no URLs.
            # But we assert that IF it exists, it's an array for proper flattening.
            if links is not None and not isinstance(links, list):
                print(f"  ❌ FAILURE: {name} 'links' property is not a flattened array.")
                faults += 1
                
    if faults > 0:
        print(f"\\n🛑 TDD FAILED. Detected {faults} missing flattening attributes from seed_resume_graph.py.")
        sys.exit(1)
    else:
        print("\\n🟩 TDD PASSED. All top-level portfolio nodes possess heavy flattened string attributes.")
        sys.exit(0)

if __name__ == "__main__":
    if "NEO4J_URI" not in os.environ:
        print("⚠️ Environment variables not loaded. Run via: export $(grep -v '^#' .env | xargs) && python tdd/verify_seed_logic.py")
        sys.exit(1)
    verify_seed_logic()
