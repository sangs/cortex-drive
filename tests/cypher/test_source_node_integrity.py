import os
import sys
from neo4j import GraphDatabase
from dotenv import load_dotenv

def run_integrity_check():
    """
    Verifies that the graph architecture complies with the Source Node design.
    Ensures no chunks are floating without a Source, and no Sources are floating without an Episode.
    """
    load_dotenv('podcast-gds.env', override=True)
    
    uri = os.environ.get('NEO4J_URI')
    user = os.environ.get('NEO4J_USERNAME')
    password = os.environ.get('NEO4J_PASSWORD')
    
    if not uri or not user or not password:
        print("ERROR: Neo4j credentials missing in environment.")
        sys.exit(1)
        
    driver = GraphDatabase.driver(uri, auth=(user, password))
    
    q_isolated_chunks = "MATCH (c:Chunk) WHERE NOT (c)<-[:CONTAINS]-(:Source) RETURN count(c) as count"
    q_missing_source = "MATCH (s:Source) WHERE NOT (s)<-[:HAS_SOURCE]-(:Episode) RETURN count(s) as count"
    q_missing_tenant = "MATCH (s:Source) WHERE s.tenant_id IS NULL RETURN count(s) as count"
    
    failed = False
    
    try:
        with driver.session() as session:
            isolated_chunks = session.run(q_isolated_chunks).single()['count']
            missing_source = session.run(q_missing_source).single()['count']
            missing_tenant = session.run(q_missing_tenant).single()['count']
            
            print(f"Isolated Chunks (Missing Source Parent): {isolated_chunks}")
            if isolated_chunks > 0: failed = True
                
            print(f"Orphaned Sources (Missing Episode Parent): {missing_source}")
            if missing_source > 0: failed = True
                
            print(f"Sources Missing Tenant ID: {missing_tenant}")
            if missing_tenant > 0: failed = True
            
            if failed:
                print("\n❌ INTEGRITY CHECK FAILED. Orphaned nodes detected in schema.")
                sys.exit(1)
            else:
                print("\n✅ INTEGRITY CHECK PASSED. Graph complies with Source architecture.")
                
    except Exception as e:
        print(f"Error executing Neo4j validation queries: {e}")
        sys.exit(1)
    finally:
        driver.close()

if __name__ == "__main__":
    run_integrity_check()
