import os
import json
import argparse
from typing import List, Dict, Any
from neo4j import GraphDatabase
from dotenv import load_dotenv
from schema_guard import (
    CORTEX_MODEL_NODES, 
    PROJECT_GRAPH_NODES,
    SYSTEM_NODES,
    CORTEX_MODEL_RELATIONSHIPS,
    PROJECT_GRAPH_RELATIONSHIPS
)

load_dotenv()

class ModelAuditor:
    """
    Audit and Cleanup tool for CortexModel Neo4j database.
    Ensures data follows the schema guardrails and multi-tenancy rules.
    """

    CORE_LABELS = CORTEX_MODEL_NODES + PROJECT_GRAPH_NODES + SYSTEM_NODES
    CORE_RELATIONSHIPS = CORTEX_MODEL_RELATIONSHIPS + PROJECT_GRAPH_RELATIONSHIPS

    def __init__(self):
        self.uri = os.environ.get("NEO4J_URI")
        self.user = os.environ.get("NEO4J_USERNAME")
        self.password = os.environ.get("NEO4J_PASSWORD")
        
        if not all([self.uri, self.user, self.password]):
            raise ValueError("Missing Neo4j environment variables in .env")
            
        self.driver = GraphDatabase.driver(self.uri, auth=(self.user, self.password))

    def close(self):
        self.driver.close()

    def run_audit(self) -> Dict[str, Any]:
        """Runs discovery queries to find malformed data."""
        report = {
            "missing_tenant": [],
            "illegal_labels": [],
            "illegal_relationships": [],
            "orphaned_chunks": 0
        }

        with self.driver.session() as session:
            # 1. Missing Tenant
            print("Auditing missing tenant_id...")
            q1 = "MATCH (n) WHERE n.tenant_id IS NULL OR n.tenant_id = '' RETURN labels(n) as Label, count(n) as Count"
            result = session.run(q1)
            report["missing_tenant"] = [dict(record) for record in result]

            # 2. Illegal Labels
            print("Auditing illegal labels...")
            q2 = """
            MATCH (n) 
            WHERE NOT any(label IN labels(n) WHERE label IN $core_labels)
            RETURN labels(n) as Labels, count(n) as Count
            """
            result = session.run(q2, core_labels=self.CORE_LABELS)
            report["illegal_labels"] = [dict(record) for record in result]

            # 3. Illegal Relationships
            print("Auditing illegal relationships...")
            q3 = """
            MATCH ()-[r]->()
            WHERE NOT type(r) IN $core_rels
            RETURN type(r) as Type, count(r) as Count
            """
            result = session.run(q3, core_rels=self.CORE_RELATIONSHIPS)
            report["illegal_relationships"] = [dict(record) for record in result]

            # 4. Orphaned Chunks
            print("Auditing orphaned chunks...")
            q4 = "MATCH (c:Chunk) WHERE NOT (c)<-[:CONTAINS]-(:Source) RETURN count(c) as Count"
            report["orphaned_chunks"] = session.run(q4).single()["Count"]

        return report

    def cleanup_missing_tenant(self, target_tenant_id: str):
        """Retroactively tags nodes with missing tenant_id."""
        print(f"Repairing missing tenant_id -> {target_tenant_id}...")
        query = """
        MATCH (n) 
        WHERE n.tenant_id IS NULL OR n.tenant_id = '' 
        WITH n LIMIT 1000
        SET n.tenant_id = $tenant_id
        RETURN count(n) as count
        """
        total = 0
        with self.driver.session() as session:
            while True:
                count = session.run(query, tenant_id=target_tenant_id).single()["count"]
                if count == 0:
                    break
                total += count
                print(f"  Fixed {total} nodes...")
        print(f"Repair complete. Total fixed: {total}")

    def purge_illegal_nodes(self):
        """Deletes nodes that do not belong to the core schema."""
        print("Purging nodes with illegal labels...")
        query = """
        MATCH (n) 
        WHERE NOT any(label IN labels(n) WHERE label IN $core_labels)
        WITH n LIMIT 500
        DETACH DELETE n
        RETURN count(n) as count
        """
        total = 0
        with self.driver.session() as session:
            while True:
                count = session.run(query, core_labels=self.CORE_LABELS).single()["count"]
                if count == 0:
                    break
                total += count
                print(f"  Deleted {total} nodes...")
        print(f"Node purge complete. Total deleted: {total}")

    def purge_illegal_relationships(self):
        """Deletes relationships that do not belong to the core schema."""
        print("Purging illegal relationships...")
        query = """
        MATCH ()-[r]->()
        WHERE NOT type(r) IN $core_rels
        WITH r LIMIT 1000
        DELETE r
        RETURN count(r) as count
        """
        total = 0
        with self.driver.session() as session:
            while True:
                count = session.run(query, core_rels=self.CORE_RELATIONSHIPS).single()["count"]
                if count == 0:
                    break
                total += count
                print(f"  Deleted {total} relationships...")
        print(f"Relationship purge complete. Total deleted: {total}")

def main():
    parser = argparse.ArgumentParser(description="CortexModel Neo4j Auditor")
    parser.add_argument("--mode", choices=["audit", "fix-tenant", "purge-illegal", "full-cleanup"], default="audit")
    parser.add_argument("--tenant-id", help="The target tenant_id to apply during repair")
    
    args = parser.parse_args()
    auditor = ModelAuditor()
    
    # Hierarchy: TENANT_ID (Primary) -> TEST_TENANT (Fallback) -> "test-tenant" (Hardcoded default)
    default_tenant = os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"

    try:
        if args.mode == "audit":
            report = auditor.run_audit()
            print("\n--- AUDIT REPORT ---")
            print(json.dumps(report, indent=2))
            
        elif args.mode == "fix-tenant":
            target_tenant = args.tenant_id or default_tenant
            print(f"Using tenant_id: {target_tenant}")
            auditor.cleanup_missing_tenant(target_tenant)
            
        elif args.mode == "purge-illegal":
            confirm = input("Are you sure you want to PERMANENTLY DELETE illegal nodes and relationships? (y/n): ")
            if confirm.lower() == 'y':
                auditor.purge_illegal_nodes()
                auditor.purge_illegal_relationships()
                
        elif args.mode == "full-cleanup":
            target_tenant = args.tenant_id or default_tenant
            print(f"Using tenant_id: {target_tenant}")
            auditor.cleanup_missing_tenant(target_tenant)
            auditor.purge_illegal_nodes()
            auditor.purge_illegal_relationships()

    finally:
        auditor.close()

if __name__ == "__main__":
    main()
