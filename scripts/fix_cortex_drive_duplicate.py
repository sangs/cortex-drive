"""
Fix: duplicate Cortex-Drive node.

seed_resume_graph.py MERGE'd (:Project {name: "Cortex-Drive"}) — single label, no description.
seed_cortex_drive_project.py MERGE'd (:Startup:Project {name: "Cortex-Drive", ...}) — correct node.
Neo4j MERGE on multi-label creates a second node when one with ALL labels doesn't exist.

Result: two nodes. CURRENTLY_BUILDING points to the Project-only node (no description).
Fix: re-point CURRENTLY_BUILDING and HAS_PRIVATE_NOTE to the Startup:Project node, delete the duplicate.

Run from repo root: .venv/bin/python scripts/fix_cortex_drive_duplicate.py
"""

import os, sys
from neo4j import GraphDatabase
from dotenv import load_dotenv

load_dotenv('.env', override=True)
NEO4J_URI      = os.getenv("NEO4J_URI")
NEO4J_USERNAME = os.getenv("NEO4J_USERNAME", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD")


def run(driver, q, **p):
    with driver.session() as s:
        return list(s.run(q, **p))


def audit(driver):
    print("\n── Audit: all Cortex-Drive nodes ──")
    results = run(driver, """
        MATCH (n {name: "Cortex-Drive"})
        RETURN labels(n) AS labels, n.tenant_id AS tenant_id,
               n.owner_id AS owner_id,
               left(coalesce(n.description, ""), 60) AS description_preview,
               elementId(n) AS eid
    """)
    for r in results:
        print(f"  labels={r['labels']}  tenant={r['tenant_id']}  owner={r['owner_id']}")
        print(f"    description: {r['description_preview'] or '(none)'}")
        print(f"    elementId: {r['eid']}")
    return results


def fix(driver):
    print("\n── Step 1: identify correct and duplicate nodes ──")
    # Correct node: has BOTH Startup and Project labels AND has a description
    # Duplicate node: has only ONE of the two labels and/or no description
    good = run(driver, """
        MATCH (b:Startup:Project {name: "Cortex-Drive"})
        RETURN elementId(b) AS eid, left(b.description, 60) AS desc
    """)
    # Startup-only (no Project label)
    startup_only = run(driver, """
        MATCH (a:Startup {name: "Cortex-Drive"}) WHERE NOT a:Project
        RETURN elementId(a) AS eid, a.description AS desc
    """)
    # Project-only (no Startup label)
    project_only = run(driver, """
        MATCH (a:Project {name: "Cortex-Drive"}) WHERE NOT a:Startup
        RETURN elementId(a) AS eid, a.description AS desc
    """)

    bad = startup_only or project_only
    bad_label_filter = "WHERE NOT a:Project" if startup_only else "WHERE NOT a:Startup"
    bad_label_match = "Startup" if startup_only else "Project"

    if not bad:
        print("  No incomplete-label duplicate found — already clean.")
        return
    if not good:
        print("  ⛔ Startup:Project node not found. Aborting.")
        sys.exit(1)

    print(f"  Duplicate (to delete): labels=[{bad_label_match}]  eid={bad[0]['eid']}  desc={bad[0]['desc'] or '(none)'}")
    print(f"  Correct (to keep):     labels=[Startup, Project]  eid={good[0]['eid']}  desc={good[0]['desc']}")

    print("\n── Step 2: re-point CURRENTLY_BUILDING to correct node ──")
    r = run(driver, f"""
        MATCH (a:{bad_label_match} {{name: "Cortex-Drive"}}) {bad_label_filter}
        MATCH (b:Startup:Project {{name: "Cortex-Drive"}})
        MATCH (p:Person)-[r:CURRENTLY_BUILDING]->(a)
        MERGE (p)-[r2:CURRENTLY_BUILDING]->(b)
        SET r2 = properties(r)
        DELETE r
        RETURN p.name AS person, count(r2) AS moved
    """)
    for row in r:
        print(f"  ✓ CURRENTLY_BUILDING re-pointed: {row['person']} → Cortex-Drive (Startup:Project)  count={row['moved']}")
    if not r:
        print("  (no CURRENTLY_BUILDING on duplicate — nothing to re-point)")

    print("\n── Step 3: re-point HAS_PRIVATE_NOTE to correct node ──")
    r = run(driver, f"""
        MATCH (a:{bad_label_match} {{name: "Cortex-Drive"}}) {bad_label_filter}
        MATCH (b:Startup:Project {{name: "Cortex-Drive"}})
        MATCH (a)-[r:HAS_PRIVATE_NOTE]->(note)
        MERGE (b)-[r2:HAS_PRIVATE_NOTE]->(note)
        SET r2 = properties(r)
        DELETE r
        RETURN count(r2) AS moved
    """)
    moved = r[0]['moved'] if r else 0
    print(f"  ✓ HAS_PRIVATE_NOTE re-pointed: {moved}")

    print("\n── Step 3.5: re-point CONTAINS from categories to correct node ──")
    r = run(driver, f"""
        MATCH (a:{bad_label_match} {{name: "Cortex-Drive"}}) {bad_label_filter}
        MATCH (b:Startup:Project {{name: "Cortex-Drive"}})
        MATCH (cat)-[r:CONTAINS]->(a)
        MERGE (cat)-[:CONTAINS]->(b)
        DELETE r
        RETURN count(r) AS moved
    """)
    moved = r[0]['moved'] if r else 0
    print(f"  ✓ CONTAINS re-pointed: {moved} category links")

    print("\n── Step 3.6: set isPresent / endDate / endYear on correct node ──")
    run(driver, """
        MATCH (b:Startup:Project {name: "Cortex-Drive"})
        SET b.isPresent = true, b.endDate = "Present", b.endYear = "Present"
    """)
    print("  ✓ isPresent=true, endDate='Present', endYear='Present' set")

    print("\n── Step 4: report remaining relationships before delete ──")
    r = run(driver, f"""
        MATCH (a:{bad_label_match} {{name: "Cortex-Drive"}}) {bad_label_filter}
        RETURN [(a)-[r]-() | type(r)] AS remaining_rels
    """)
    if r and r[0]['remaining_rels']:
        print(f"  ⚠️  Remaining relationships on duplicate (will be dropped): {r[0]['remaining_rels']}")
    else:
        print("  No remaining relationships on duplicate.")

    print("\n── Step 5: DETACH DELETE duplicate ──")
    run(driver, f"""
        MATCH (a:{bad_label_match} {{name: "Cortex-Drive"}}) {bad_label_filter}
        DETACH DELETE a
    """)
    print(f"  ✓ Duplicate {bad_label_match}-only Cortex-Drive node deleted.")

    print("\n── Step 6: verify single node remains ──")
    remaining = run(driver, """
        MATCH (n {name: "Cortex-Drive"}) RETURN labels(n) AS labels, n.tenant_id AS tenant_id, elementId(n) AS eid
    """)
    print(f"  Remaining Cortex-Drive nodes: {len(remaining)}")
    for r in remaining:
        print(f"    labels={r['labels']}  tenant={r['tenant_id']}  eid={r['eid']}")
    correct = len(remaining) == 1 and 'Startup' in remaining[0]['labels'] and 'Project' in remaining[0]['labels']
    print(f"  {'✓ Exactly one Startup:Project node remains.' if correct else '⛔ Unexpected state — manual review needed.'}")

    print("\n── Step 7: confirm CURRENTLY_BUILDING points to correct node ──")
    r = run(driver, """
        MATCH (p:Person)-[r:CURRENTLY_BUILDING]->(n {name: "Cortex-Drive"})
        RETURN p.name AS person, labels(n) AS node_labels, r.role AS role, r.end AS end_date
    """)
    for row in r:
        print(f"  ✓ {row['person']} -[:CURRENTLY_BUILDING {{role: {row['role']}, end: {row['end_date']}}}]-> Cortex-Drive {row['node_labels']}")
    if not r:
        print("  ⛔ No CURRENTLY_BUILDING relationship found after fix.")


def main():
    if not NEO4J_PASSWORD:
        print("⛔ NEO4J_PASSWORD not set.")
        sys.exit(1)
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USERNAME, NEO4J_PASSWORD))
    try:
        driver.verify_connectivity()
        print(f"Connected to {NEO4J_URI}")
        audit(driver)
        fix(driver)
    finally:
        driver.close()


if __name__ == "__main__":
    main()
