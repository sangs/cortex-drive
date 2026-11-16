import os
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '../src/mcp_server'))
from neo4j_connection import create_driver  # noqa: E402 — the one driver factory (S2-79)
from dotenv import load_dotenv

def cleanup_tests():
    load_dotenv('.env', override=True)
    driver = create_driver()
    
    # We delete everything associated with the test tenant, allowing the user to safely wipe the tests
    query = """
    MATCH (n)
    WHERE n.tenant_id = 'test_org_123'
    DETACH DELETE n
    RETURN count(n) as deleted_count
    """
    
    with driver.session() as session:
        result = session.run(query).single()
        print(f"Successfully deleted {result['deleted_count']} test nodes and their relationships from the database.")
        
    driver.close()

if __name__ == "__main__":
    cleanup_tests()
