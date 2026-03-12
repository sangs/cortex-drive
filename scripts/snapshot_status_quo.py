import os
import json
from datetime import datetime
from neo4j import GraphDatabase
from dotenv import load_dotenv
from schema_guard import (
    CORTEX_MODEL_NODES, 
    PROJECT_GRAPH_NODES, 
    SYSTEM_NODES,
    CORTEX_MODEL_RELATIONSHIPS, 
    PROJECT_GRAPH_RELATIONSHIPS
)

# Load configuration
dotenv_path = os.path.join(os.getcwd(), ".env")
load_dotenv(dotenv_path)

class StatusQuoAuditor:
    """
    Captures a snapshot of the Neo4j database state before cleanup.
    Saves a detailed report to documents/status_quo_snapshots/.
    """
    def __init__(self):
        self.uri = os.getenv("NEO4J_URI")
        self.user = os.getenv("NEO4J_USERNAME")
        self.pwd = os.getenv("NEO4J_PASSWORD")
        
        if not self.uri:
            raise ValueError("NEO4J_URI not found in .env")
        
        self.driver = GraphDatabase.driver(self.uri, auth=(self.user, self.pwd))
        self.legal_labels = CORTEX_MODEL_NODES + PROJECT_GRAPH_NODES + SYSTEM_NODES
        self.legal_relationships = CORTEX_MODEL_RELATIONSHIPS + PROJECT_GRAPH_RELATIONSHIPS

    def close(self):
        self.driver.close()

    def capture_snapshot(self):
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        report_path = f"documents/status_quo_report_{timestamp}.md"
        
        print(f"📸 Capturing Status Quo Snapshot...")
        print(f"📝 Report will be saved to: {report_path}")

        report_content = f"# CortexDrive: Database Status Quo Snapshot\n"
        report_content += f"**Captured at:** {datetime.now().isoformat()}\n\n"

        with self.driver.session() as session:
            # 1. Total Counts
            print("   - Counting nodes and relationships...")
            node_counts = session.run("MATCH (n) RETURN labels(n) as Labels, count(n) as Count ORDER BY Count DESC")
            rel_counts = session.run("MATCH ()-[r]->() RETURN type(r) as Type, count(r) as Count ORDER BY Count DESC")

            report_content += "## 📊 General Statistics\n"
            report_content += "### Nodes\n| Labels | Count |\n| --- | --- |\n"
            for record in node_counts:
                report_content += f"| {record['Labels']} | {record['Count']} |\n"

            report_content += "\n### Relationships\n| Type | Count |\n| --- | --- |\n"
            for record in rel_counts:
                report_content += f"| {record['Type']} | {record['Count']} |\n"

            # 2. Illegal Node Detail
            print("   - Identifying schema violations...")
            illegal_nodes = session.run("""
                MATCH (n) 
                WHERE NOT any(label IN labels(n) WHERE label IN $legal_labels)
                RETURN labels(n) as Labels, count(n) as Count, collect(properties(n))[0..3] as Samples
            """, legal_labels=self.legal_labels)

            report_content += "\n## ⚠️ Schema Violations (Nodes to be Cleaned)\n"
            report_content += "| Labels | Count | Sample Data (First 3) |\n| --- | --- | --- |\n"
            for record in illegal_nodes:
                samples = json.dumps(record['Samples'], indent=2)
                report_content += f"| {record['Labels']} | {record['Count']} | <pre>{samples}</pre> |\n"

            # 3. Illegal Relationship Detail
            illegal_rels = session.run("""
                MATCH (n)-[r]->(m)
                WHERE NOT type(r) IN $legal_relationships
                   OR NOT any(label IN labels(n) WHERE label IN $legal_labels)
                   OR NOT any(label IN labels(m) WHERE label IN $legal_labels)
                RETURN type(r) as Type, count(r) as Count, labels(n) as Source, labels(m) as Target
                ORDER BY Count DESC
            """, legal_labels=self.legal_labels, legal_relationships=self.legal_relationships)

            report_content += "\n## 🔗 Illegal Connections (To be Deleted)\n"
            report_content += "| Rel Type | Count | Source | Target |\n| --- | --- | --- | --- |\n"
            for record in illegal_rels:
                report_content += f"| {record['Type']} | {record['Count']} | {record['Source']} | {record['Target']} |\n"

            # 4. Valid Schema Integrity Check
            report_content += "\n## ✅ Valid Schema Integrity\n"
            report_content += "The following relationships exist between valid nodes and will be preserved:\n\n"
            report_content += "| Source | Relationship | Target | Count |\n| --- | --- | --- | --- |\n"
            valid_stats = session.run("""
                MATCH (n)-[r]->(m)
                WHERE all(node IN [n, m] WHERE any(label IN labels(node) WHERE label IN $legal_labels))
                  AND type(r) IN $legal_relationships
                RETURN labels(n) as Source, type(r) as Rel, labels(m) as Target, count(*) as Count
                ORDER BY Rel
            """, legal_labels=self.legal_labels, legal_relationships=self.legal_relationships)
            for record in valid_stats:
                report_content += f"| {record['Source']} | {record['Rel']} | {record['Target']} | {record['Count']} |\n"

        # Ensure directory exists
        os.makedirs("documents", exist_ok=True)
        with open(report_path, "w") as f:
            f.write(report_content)
        
        print(f"✅ Snapshot complete.")

if __name__ == "__main__":
    try:
        auditor = StatusQuoAuditor()
        auditor.capture_snapshot()
    except Exception as e:
        print(f"❌ Error: {e}")
    finally:
        if 'auditor' in locals():
            auditor.close()
