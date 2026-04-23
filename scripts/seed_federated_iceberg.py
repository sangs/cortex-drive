#!/usr/bin/env python3
"""
seed_federated_iceberg.py - Federated Metadata Seeder for Cortex-Drive

This script seeds the "Iceberg" metadata landmarks used to demonstrate 
the Federated Knowledge Bridge. It creates external siloes (S3, GitHub)
as metadata nodes to showcase inter-graph discovery.
"""

import os
import sys
from neo4j import GraphDatabase
from dotenv import load_dotenv

load_dotenv('.env', override=True)

NEO4J_URI = os.getenv("NEO4J_URI")
NEO4J_USERNAME = os.getenv("NEO4J_USERNAME", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD")
TENANT_ID = os.getenv("TENANT_ID")

FEDERATED_QUERIES = [
    # 1. Enterprise Data Lakehouse (The Trade/Consumer Iceberg)
    """
    MERGE (cat:Category {name: "Federated Knowledge Silos"})
    MERGE (dl:ExternalSilo:DataLake {name: "s3://enterprise-data-lakehouse-prod"})
    SET dl.type = "ObjectStore",
        dl.provider = "AWS",
        dl.region = "us-east-1",
        dl.description = "Federated Metadata Catalog for dynamic daily trade and consumer response data. Borrowing Iceberg table format for ACID compliance.",
        dl.tenant_id = $tenant_id,
        dl.isIceberg = true
    
    MERGE (cat)-[:CONTAINS]->(dl)
    
    WITH dl
    MERGE (t1:TableMetadata {name: "daily_trades_iceberg"})
    SET t1.format = "Iceberg", t1.partitioning = "days(trade_date)", t1.tenant_id = $tenant_id
    MERGE (dl)-[:STORES]->(t1)
    """,

    # 2. GitHub Metadata Silo (The Code Iceberg)
    """
    MATCH (cat:Category {name: "Federated Knowledge Silos"})
    MERGE (gh:ExternalSilo:GitHub {name: "github.com/sangs/cortex-drive"})
    SET gh.type = "VCS",
        gh.visibility = "Private",
        gh.description = "Federated Metadata Catalog for core infrastructure repositories.",
        gh.tenant_id = $tenant_id,
        gh.isIceberg = true
    
    MERGE (cat)-[:CONTAINS]->(gh)
    
    WITH gh
    MATCH (p:Project {name: "Cortex-Drive"})
    MERGE (p)-[:FEDERATED_TO]->(gh)
    """,

    # 3. Confluence Metadata Silo (The Corporate Memory Iceberg)
    """
    MATCH (cat:Category {name: "Federated Knowledge Silos"})
    MERGE (cf:ExternalSilo:Confluence {name: "cortex-drive.atlassian.net/wiki"})
    SET cf.type = "Wiki",
        cf.description = "Federated Metadata Catalog for Architecture Decision Records (ADRs), Product Strategy, and Design Notes.",
        cf.tenant_id = $tenant_id,
        cf.isIceberg = true
    
    MERGE (cat)-[:CONTAINS]->(cf)
    
    WITH cf
    MERGE (p1:PageMetadata {name: "ADR-001: Relationship-Centric Schema"})
    SET p1.pageId = "12345", p1.status = "Accepted", p1.tenant_id = $tenant_id
    MERGE (cf)-[:STORES]->(p1)
    
    WITH cf, p1
    MATCH (p:Project {name: "Cortex-Drive"})
    MERGE (p)-[:DOCUMENTED_BY]->(p1)
    """
]

def seed_iceberg():
    if not NEO4J_PASSWORD or not TENANT_ID:
        print("Error: Required environment variables not set.")
        sys.exit(1)

    print(f"Connecting to Neo4j to seed Federated Iceberg landmarks for {TENANT_ID}...")
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USERNAME, NEO4J_PASSWORD))
    
    try:
        with driver.session() as session:
            for i, query in enumerate(FEDERATED_QUERIES, 1):
                print(f"  -> Running Federated Pass {i}/{len(FEDERATED_QUERIES)}")
                session.run(query, tenant_id=TENANT_ID)
        print("\n✓ SUCCESS: Federated Iceberg landmarks seeded.")
    except Exception as e:
        print(f"Error: {e}")
    finally:
        driver.close()

if __name__ == "__main__":
    seed_iceberg()
