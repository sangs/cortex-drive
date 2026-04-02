import os
import json
from neo4j import GraphDatabase
from dotenv import load_dotenv
from schema_guard import (
    CORTEX_DRIVE_NODES, 
    PROJECT_GRAPH_NODES, 
    SYSTEM_NODES,
    CORTEX_DRIVE_RELATIONSHIPS, 
    PROJECT_GRAPH_RELATIONSHIPS
)

# Load configuration
dotenv_path = os.path.join(os.getcwd(), ".env")
load_dotenv(dotenv_path)

class DryRunAuditor:
    def __init__(self):
        self.uri = os.getenv("NEO4J_URI")
        self.user = os.getenv("NEO4J_USERNAME")
        self.pwd = os.getenv("NEO4J_PASSWORD")
        
        if not self.uri:
            raise ValueError("NEO4J_URI not found in .env")
        
        self.driver = GraphDatabase.driver(self.uri, auth=(self.user, self.pwd))
        self.legal_labels = CORTEX_DRIVE_NODES + PROJECT_GRAPH_NODES + SYSTEM_NODES
        self.legal_relationships = CORTEX_DRIVE_RELATIONSHIPS + PROJECT_GRAPH_RELATIONSHIPS

    def close(self):
        self.driver.close()

    def run_dry_run(self):
        print("🔍 Starting CortexDrive Cleanup Dry Run...")
        print("------------------------------------------")
        
        with self.driver.session() as session:
            # 1. Total Illegal Nodes
            count_query = """
            MATCH (n) 
            WHERE NOT any(label IN labels(n) WHERE label IN $legal_labels)
            RETURN labels(n) as Labels, count(n) as Count
            """
            result = session.run(count_query, legal_labels=self.legal_labels)
            illegal_data = [dict(record) for record in result]
            
            total_illegal = sum(d['Count'] for d in illegal_data)
            print(f"📍 Found {total_illegal} nodes outside the current schema.")
            for d in illegal_data:
                print(f"   - Label {d['Labels']}: {d['Count']} nodes")

            print("\n🛠 Proposed Actions:")
            print("------------------")

            # 2. Check for Source -> ReferenceLink migration
            source_count = session.run("MATCH (n:Source) RETURN count(n) as Count").single()["Count"]
            if source_count > 0:
                print(f"✅ ACTION: Relabel {source_count} 'Source' nodes to 'ReferenceLink'.")
            
            # 3. Check for Entity -> Topic/Concept migration
            entity_count = session.run("MATCH (n:Entity) RETURN count(n) as Count").single()["Count"]
            if entity_count > 0:
                print(f"✅ ACTION: Relabel {entity_count} 'Entity' nodes (requires manual review of 'type' property).")

            # 4. Relationship Intersection Analysis
            print("\n🔄 Relationship Type Intersection Analysis:")
            print("------------------------------------------")
            
            combined_rel_query = """
            // Identify illegal relationships and flag if they belong to the 'Golden List'
            MATCH (n2)-[r2]->(m2)
            WHERE any(node IN [n2, m2] WHERE NOT any(label IN labels(node) WHERE label IN $legal_labels))
            RETURN type(r2) as RelType, 
                   count(r2) as Count, 
                   (type(r2) IN $legal_relationships) as IsIntersection
            """
            
            rel_results = list(session.run(combined_rel_query, 
                                          legal_labels=self.legal_labels,
                                          legal_relationships=self.legal_relationships))
            
            intersection_types = []
            print(f"{'RelType':<20} | {'Count':<6} | {'Status'}")
            print("-" * 40)
            for record in rel_results:
                is_intersect = record["IsIntersection"]
                status = "⚠️ INTERSECTION" if is_intersect else "✅ Unique"
                if is_intersect:
                    intersection_types.append(record["RelType"])
                print(f"{record['RelType']:<20} | {record['Count']:<6} | {status}")

            if intersection_types:
                print("\n🔍 Deep Dive: Nodes in Intersection Relationships:")
                print("---------------------------------------------")
                for rel_type in intersection_types:
                    node_detail_query = """
                    MATCH (n)-[r]-(m)
                    WHERE type(r) = $rel_type
                      AND (NOT any(label IN labels(n) WHERE label IN $legal_labels)
                           OR NOT any(label IN labels(m) WHERE label IN $legal_labels))
                    WITH n, m, labels(n) as labelsN, labels(m) as labelsM
                    UNWIND [ (CASE WHEN NOT any(l IN labelsN WHERE l IN $legal_labels) THEN n ELSE null END),
                             (CASE WHEN NOT any(l IN labelsM WHERE l IN $legal_labels) THEN m ELSE null END) ] as illegalNode
                    WITH illegalNode WHERE illegalNode IS NOT NULL
                    RETURN DISTINCT labels(illegalNode) as IllegalLabel, 
                                    count(illegalNode) as Count,
                                    properties(illegalNode) as Data
                    """
                    details = session.run(node_detail_query, rel_type=rel_type, legal_labels=self.legal_labels)
                    print(f"\nRelationship: {rel_type}")
                    for detail in details:
                        print(f"   ↳ Illegal Node Label: {detail['IllegalLabel']} ({detail['Count']} nodes)")
                        print(f"     Data Sample: {json.dumps(detail['Data'], indent=2)[:200]}...")
                    
                    print(f"\n🎨 VISUAL AUDIT QUERY (Paste into Neo4j Browser):")
                    print(f"   MATCH (n)-[r:{rel_type}]-(m) ")
                    print(f"   WHERE (NOT any(label IN labels(n) WHERE label IN {self.legal_labels}))")
                    print(f"      OR (NOT any(label IN labels(m) WHERE label IN {self.legal_labels}))")
                    print(f"   RETURN n, r, m LIMIT 25")

                    # Legal Usage Summary
                    legal_summary_query = """
                    MATCH (n)-[r]-(m)
                    WHERE type(r) = $rel_type
                      AND all(node IN [n, m] WHERE any(label IN labels(node) WHERE label IN $legal_labels))
                    RETURN labels(n) as SourceLabels, 
                           labels(m) as TargetLabels, 
                           count(*) as Count
                    """
                    legal_usage = session.run(legal_summary_query, rel_type=rel_type, legal_labels=self.legal_labels)
                    print(f"\n✅ LEGAL USAGE SUMMARY for {rel_type}:")
                    legal_records = list(legal_usage)
                    if legal_records:
                        print(f"   {'Source':<30} | {'Target':<30} | {'Count'}")
                        print(f"   {'-'*30} | {'-'*30} | {'-'*5}")
                        for rec in legal_records:
                            src = ", ".join(rec['SourceLabels'])
                            tgt = ", ".join(rec['TargetLabels'])
                            print(f"   {src:<30} | {tgt:<30} | {rec['Count']}")
                    else:
                        print("   No legal usage found for this relationship type.")

                    print(f"\n🎨 LEGAL GRAPH QUERY (Paste into Neo4j Browser):")
                    print(f"   MATCH (n)-[r:{rel_type}]->(m)")
                    print(f"   WHERE all(node IN [n, m] WHERE any(label IN labels(node) WHERE label IN {self.legal_labels}))")
                    print(f"   RETURN n, r, m LIMIT 50")
                
                print("\n⚠️ RECOMMENDATION: The illegal nodes above use standard schema relationships.")
                print("   They are likely valid data with incorrect labels (e.g. 'Source' instead of 'ReferenceLink').")
            else:
                print("\n✅ All illegal relationships use unique/non-standard types.")
            
            print("\n🔗 Relationship Impact:")
            print("----------------------")
            # Re-running the count for the impact summary
            impact_summary = session.run("""
            MATCH (n)-[r]->(m) 
            WHERE any(node IN [n, m] WHERE NOT any(label IN labels(node) WHERE label IN $legal_labels))
            RETURN type(r) as RelType, count(r) as Count
            """, legal_labels=self.legal_labels)
            
            for record in impact_summary:
                print(f"   - Relationship '{record['RelType']}' connected to illegal nodes: {record['Count']}")

            # 6. Valid Schema Relationships Discovery
            print("\n💎 Valid Schema Relationships Discovery (Current State):")
            print("---------------------------------------------------------")
            valid_schema_rels_query = """
            MATCH (n)-[r]->(m)
            WHERE all(node IN [n, m] WHERE any(label IN labels(node) WHERE label IN $legal_labels))
            RETURN DISTINCT labels(n) as Source, 
                            type(r) as RelType, 
                            labels(m) as Target, 
                            count(*) as Count
            ORDER BY RelType
            """
            valid_schema_rels = session.run(valid_schema_rels_query, legal_labels=self.legal_labels)
            
            print(f"{'Source':<20} | {'Relationship':<20} | {'Target':<20} | {'Count'}")
            print("-" * 75)
            for record in valid_schema_rels:
                src = ", ".join(record['Source'])
                tgt = ", ".join(record['Target'])
                print(f"{src:<20} | {record['RelType']:<20} | {tgt:<20} | {record['Count']}")

            print(f"\n🎨 VISUAL VALID SCHEMA (Paste into Neo4j Browser):")
            print(f"   MATCH (n)-[r]->(m)")
            print(f"   WHERE all(node IN [n, m] WHERE any(label IN labels(node) WHERE label IN {self.legal_labels}))")
            print(f"   RETURN n, r, m LIMIT 100")

            # 7. Unique Valid Relationship Names (Golden List)
            print("\n🌟 Golden List: Unique Relationship Names between Valid Nodes:")
            print("---------------------------------------------------------")
            golden_rels_query = """
            MATCH (n)-[r]->(m)
            WHERE all(node IN [n, m] WHERE any(label IN labels(node) WHERE label IN $legal_labels))
            RETURN DISTINCT type(r) as UniqueRelationship
            ORDER BY UniqueRelationship
            """
            golden_rels = session.run(golden_rels_query, legal_labels=self.legal_labels)
            
            rel_list = [record["UniqueRelationship"] for record in golden_rels]
            if rel_list:
                print(f"✅ Found {len(rel_list)} unique relationship types:")
                for rel in rel_list:
                    print(f"   - {rel}")
                print(f"\n💡 Use this list for 'allowed_relationships' in IngestionEngine:")
                print(f"   {json.dumps(rel_list)}")
            else:
                print("   No relationships found between valid nodes.")

            print("\n------------------------------------------")
            print("🚀 Dry run complete. No data was modified.")
            print("To proceed with the actual cleanup, refer to documents/neo4j_cleanup_migration_plan.md")

if __name__ == "__main__":
    try:
        auditor = DryRunAuditor()
        auditor.run_dry_run()
    except Exception as e:
        print(f"❌ Error during dry run: {e}")
    finally:
        if 'auditor' in locals():
            auditor.close()
