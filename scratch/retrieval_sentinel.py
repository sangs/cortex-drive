import os
import json
from neo4j import GraphDatabase
from dotenv import load_dotenv

load_dotenv()

def audit_identity():
    uri = os.environ.get("NEO4J_URI")
    user = os.environ.get("NEO4J_USERNAME")
    password = os.environ.get("NEO4J_PASSWORD")
    uid = os.environ.get("OWNER_USER_ID")
    
    driver = GraphDatabase.driver(uri, auth=(user, password))
    
    with driver.session() as session:
        # 1. Check User to Note connectivity (The narrative gap)
        query_narrative = """
        MATCH (u:User {id: $uid})
        OPTIONAL MATCH (u)-[r*1..3]-(note:PreparatoryNote)
        WHERE note.text CONTAINS 'Situation'
        RETURN type(r[0]) as first_rel, size(r) as path_depth, note.text as narrative_text
        LIMIT 1
        """
        res_n = session.run(query_narrative, uid=uid)
        narrative_data = [record.data() for record in res_n]
        
        # 2. Check User to Project connectivity (The discovery gap)
        query_project = """
        MATCH (u:User {id: $uid})
        OPTIONAL MATCH (u)-[r*1..3]-(n:Project)
        WHERE n.name CONTAINS 'Cortex'
        RETURN type(r[0]) as first_rel, size(r) as path_depth, n.name as project_name
        LIMIT 1
        """
        res_p = session.run(query_project, uid=uid)
        project_data = [record.data() for record in res_p]

    driver.close()
    
    return {
        "narrative_audit": narrative_data,
        "project_audit": project_data
    }

if __name__ == "__main__":
    print(json.dumps(audit_identity(), indent=2))
