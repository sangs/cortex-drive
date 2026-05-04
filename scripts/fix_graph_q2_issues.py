"""
Fix three live-graph issues surfaced during Q2 testing (2026-05-04):

1. Hackathon duplicate nodes: block #2 of the seeder created old-name hackathon nodes
   connected to "Thought Leadership & Community". Canonical nodes with full names exist
   under "Hackathons". Deletes the duplicates.

2. JPMorgan project CONTAINS gap: 5 of 7 JPMorgan projects were only connected to the
   Category node, not to the Company node. buildCompanyGroupers only shows children
   connected via Company links — hence only 2 projects bloomed. Adds missing CONTAINS.

3. ReferenceLink name backfill: ReferenceLink nodes have no name property, causing
   elementId to be used as the graph label. Sets name from seeder-defined titles where
   known; falls back to URL pattern for unknown links.

Run from repo root: .venv/bin/python scripts/fix_graph_q2_issues.py
"""

import os, sys
from neo4j import GraphDatabase
from dotenv import load_dotenv

load_dotenv('.env', override=True)
NEO4J_URI      = os.getenv("NEO4J_URI")
NEO4J_USERNAME = os.getenv("NEO4J_USERNAME", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD")

KNOWN_LINK_TITLES = {
    "https://lnkd.in/dcSmQS4n":                                                    "Volarisation Engine @ LinkedIn",
    "https://sites.google.com/view/valorisationengine/valorisation":                "Volarisation Engine Website",
    "https://drive.proton.me/urls/NYB1KQ7QNC#HueGJ6Nq7AAl":                       "Volarisation Engine Demo (Proton)",
    "https://www.infoq.com/minibooks/architecture-age-ai-opportunity/":             "InfoQ: Architectural Shifts for Platform Engineers in the Age of AI",
    "https://www.jpmorganchase.com/about/technology/blog/ignite-takes-new-york-city-by-storm": "Ignite Takes New York City by Storm",
    "https://github.com/sangs/cortex-drive":                                       "Cortex-Drive on GitHub",
}


def run(driver, q, **p):
    with driver.session() as s:
        return list(s.run(q, **p))


# ── Phase 1: Delete old hackathon duplicates under Thought Leadership ─────────

def fix_hackathon_duplicates(driver):
    print("\n── Phase 1: Delete old hackathon duplicates ──")

    # Nodes to remove: old-name Hackathon nodes that are NOT the canonical
    # "@ JPMorgan Chase" / "@ IBM Dev Day 2026" variants.
    old_hackathon_names = [
        "Humanless Autocode at Scale for SRE",
        "Valorisation Engine",
    ]

    for name in old_hackathon_names:
        audit = run(driver, """
            MATCH (h:Hackathon {name: $name})
            RETURN elementId(h) AS eid,
                   [(h)-[r]-() | type(r)] AS rels,
                   [(h)<-[:CONTAINS]-(c) | c.name] AS categories
        """, name=name)

        if not audit:
            print(f"  ✓ '{name}' — not found, already clean.")
            continue

        for row in audit:
            print(f"  Found: '{name}'  eid={row['eid']}")
            print(f"    categories: {row['categories']}")
            print(f"    rels: {row['rels']}")

        run(driver, "MATCH (h:Hackathon {name: $name}) DETACH DELETE h", name=name)
        print(f"  ✓ Deleted '{name}'.")

    # Verify canonical nodes still exist
    canonical = [
        "Humanless Autocode at Scale for SRE @ JPMorgan Chase",
        "Volarisation Engine @ IBM Dev Day 2026",
        "Global Hackathons @ JPMorgan Chase",
    ]
    print("\n  Verifying canonical hackathon nodes:")
    for name in canonical:
        result = run(driver, """
            MATCH (h:Hackathon {name: $name})
            RETURN elementId(h) AS eid,
                   [(h)<-[:CONTAINS]-(c) | c.name] AS categories
        """, name=name)
        if result:
            print(f"  ✓ '{name}' — categories: {result[0]['categories']}")
        else:
            print(f"  ⛔ '{name}' — MISSING, canonical node not found.")


# ── Phase 2: Add missing CONTAINS from JPMorgan Company to projects ──────────

def fix_jpmorgan_contains(driver):
    print("\n── Phase 2: Add missing JPMorgan Company → Project CONTAINS links ──")

    missing_projects = [
        ("Instrument Data on DataMesh",                     "02/2024", "07/2025"),
        ("Infrastructure for Instrument Data on DataMesh",  "02/2024", "07/2025"),
        ("Start of Day Open Short Orders Microservice",     "06/2021", "01/2024"),
        ("Corporate Action Report Automation",              "06/2021", "01/2024"),
        ("Settlement Setup Instruction Verification System","06/2021", "01/2024"),
    ]

    for proj_name, start, end in missing_projects:
        # Check if project exists
        exists = run(driver, "MATCH (p:Project {name: $name}) RETURN elementId(p) AS eid", name=proj_name)
        if not exists:
            print(f"  ⚠  Project not found: '{proj_name}' — skipping")
            continue

        # Add CONTAINS from JPMorgan company
        result = run(driver, """
            MATCH (c:Company {name: "JPMorgan Chase"})
            MATCH (proj:Project {name: $proj_name})
            MERGE (c)-[:CONTAINS]->(proj)
            RETURN proj.name AS name
        """, proj_name=proj_name)
        print(f"  ✓ CONTAINS added: JPMorgan Chase → '{proj_name}'")

        # Also ensure CONTRIBUTED_TO from Person exists (fix undefined r bug)
        contrib = run(driver, """
            MATCH (person:Person {name: "Sangeetha Ramadurai"})
            MATCH (proj:Project {name: $proj_name})
            MERGE (person)-[r:CONTRIBUTED_TO]->(proj)
            ON CREATE SET r.start = $start, r.end = $end
            RETURN proj.name AS name
        """, proj_name=proj_name, start=start, end=end)
        print(f"  ✓ CONTRIBUTED_TO ensured: Sangeetha → '{proj_name}'")

    # Verify: all JPMorgan projects
    print("\n  JPMorgan Chase CONTAINS inventory after fix:")
    results = run(driver, """
        MATCH (c:Company {name: "JPMorgan Chase"})-[:CONTAINS]->(proj)
        WHERE proj:Project OR proj:Role
        RETURN labels(proj) AS labels, proj.name AS name
        ORDER BY name
    """)
    for r in results:
        print(f"    {r['labels']} — {r['name']}")


# ── Phase 3: Backfill ReferenceLink names ─────────────────────────────────────

def fix_reference_link_names(driver):
    print("\n── Phase 3: Backfill ReferenceLink names ──")

    # Set known titles from the map
    for url, title in KNOWN_LINK_TITLES.items():
        result = run(driver, """
            MATCH (ref:ReferenceLink {url: $url})
            SET ref.name = $title
            RETURN ref.url AS url
        """, url=url, title=title)
        if result:
            print(f"  ✓ SET name='{title}'")
        else:
            print(f"  (not found) {url}")

    # For any remaining ReferenceLink nodes without a name, derive from URL pattern
    unnamed = run(driver, """
        MATCH (ref:ReferenceLink)
        WHERE ref.name IS NULL OR ref.name = ''
        RETURN ref.url AS url, elementId(ref) AS eid
    """)
    for row in unnamed:
        url = row['url'] or ''
        if 'github.com' in url:
            title = 'GitHub Repository'
        elif 'linkedin.com' in url or 'lnkd.in' in url:
            title = 'LinkedIn'
        elif 'infoq.com' in url:
            title = 'InfoQ Publication'
        elif 'jpmorganchase.com' in url:
            title = 'JPMorgan Chase Tech Blog'
        elif 'drive.proton.me' in url:
            title = 'Secure Document (Proton)'
        elif 'sites.google.com' in url:
            title = 'Project Website'
        else:
            title = url  # use URL as name if no pattern matches
        run(driver, "MATCH (ref:ReferenceLink) WHERE elementId(ref) = $eid SET ref.name = $title", eid=row['eid'], title=title)
        print(f"  ✓ Pattern-derived name='{title}' for {url[:60]}")

    # Verify: no unnamed ReferenceLink nodes remain
    still_unnamed = run(driver, """
        MATCH (ref:ReferenceLink)
        WHERE ref.name IS NULL OR ref.name = ''
        RETURN count(ref) AS count
    """)
    remaining = still_unnamed[0]['count'] if still_unnamed else 0
    print(f"\n  Unnamed ReferenceLink nodes remaining: {remaining}")


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    if not NEO4J_PASSWORD:
        print("⛔ NEO4J_PASSWORD not set.")
        sys.exit(1)
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USERNAME, NEO4J_PASSWORD))
    try:
        driver.verify_connectivity()
        print(f"Connected to {NEO4J_URI}")
        fix_hackathon_duplicates(driver)
        fix_jpmorgan_contains(driver)
        fix_reference_link_names(driver)
        print("\n── All phases complete ──")
    finally:
        driver.close()


if __name__ == "__main__":
    main()
