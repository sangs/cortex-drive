import os
from neo4j import GraphDatabase
from dotenv import load_dotenv

def cleanup_tests():
    load_dotenv('.env', override=True)
    driver = GraphDatabase.driver(
        os.environ['NEO4J_URI'],
        auth=(os.environ['NEO4J_USERNAME'], os.environ['NEO4J_PASSWORD'])
    )
    
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
