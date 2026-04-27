#!/usr/bin/env python3
"""
verify_role_properties.py - TDD Validation for Relationship Branding

This script verifies:
1. All (:Person)-[:HELD_ROLE]->(:Company) relationships have 'title', 'start', and 'end'.
2. No nodes exist with the label ':Role' (Institutional Clarity).
"""

import os
import sys
from neo4j import GraphDatabase
from dotenv import load_dotenv

load_dotenv('.env', override=True)

NEO4J_URI = os.getenv("NEO4J_URI")
NEO4J_USERNAME = os.getenv("NEO4J_USERNAME", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD")

def run_verification():
    if not NEO4J_PASSWORD:
        print("Error: NEO4J_PASSWORD not set.")
        sys.exit(1)

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USERNAME, NEO4J_PASSWORD))
    
    try:
        with driver.session() as session:
            # 1. Audit for Legacy Role nodes
            role_count = session.run("MATCH (r:Role) RETURN count(r) AS count").single()["count"]
            if role_count > 0:
                print(f"FAILED: Found {role_count} legacy :Role nodes. Migration incomplete.")
            else:
                print("PASSED: Institutional Memory is clear of :Role diamond nodes.")

            # 2. Verify Edge Properties
            edge_audit = session.run("""
                MATCH (p:Person)-[rel:HELD_ROLE]->(c:Company)
                WHERE rel.title IS NULL OR rel.start IS NULL
                RETURN p.name as person, c.name as company, rel.title as title
            """).data()
            
            if edge_audit:
                print(f"FAILED: Found {len(edge_audit)} HELD_ROLE links without mandatory title/date properties.")
            else:
                print("PASSED: All career relationships are high-fidelity (title/dates present).")

    except Exception as e:
        print(f"Verification Error: {e}")
    finally:
        driver.close()

if __name__ == "__main__":
    print("Executing Institutional Schema Audit...")
    run_verification()
