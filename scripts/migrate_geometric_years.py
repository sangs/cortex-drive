import os
import json
from neo4j import GraphDatabase

uri = "bolt://localhost:7687"
user = "neo4j"
password = "password"

driver = GraphDatabase.driver(uri, auth=(user, password))

def migrate_years():
    with driver.session() as session:
        print("Migrating Year Nodes & Temporal Relationships...")
        
        # 1. Clear existing synthesized Year nodes if any
        session.run("MATCH (y:Year) DETACH DELETE y")
        
        # 2. Extract years from Projects and Roles and create anchors
        query = """
        MATCH (n)
        WHERE n:Project OR n:Role OR n:Hackathon OR n:ThoughtLeadership OR n:ProfessionalEducation
        WITH n, 
             coalesce(n.startYear, toString(n.year)) as s_year,
             coalesce(n.endYear, toString(n.year)) as e_year
        WHERE s_year IS NOT NULL
        WITH n, 
             toInteger(s_year) as start_y, 
             toInteger(CASE WHEN e_year = 'Present' THEN '2026' ELSE e_year END) as end_y
        
        UNWIND range(start_y, end_y) as y_val
        MERGE (y:Year {name: toString(y_val)})
        ON CREATE SET y.tenant_id = n.tenant_id, y.id = 'Year_' + toString(y_val)
        
        MERGE (n)-[rel:ACTIVE_DURING]->(y)
        SET rel.tenant_id = n.tenant_id
        """
        session.run(query)
        print("SUCCESS: Persistent Geometric Years established.")

if __name__ == "__main__":
    migrate_years()
    driver.close()
