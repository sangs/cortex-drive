"""
Migration: Tenant invariant fixes + Episode date field cleanup.

Phase 1 — Audit: verify current state before any writes.
Phase 2 — Migrate: atomic tenant_id + owner_id SET for 5 node types, Concept stale copy
           resolution, Episode startYear/endYear/displayDate removal.
Phase 3 — Verify: confirm post-migration state matches expectations.

Run from the repo root:
    .venv/bin/python scripts/migrate_tenant_and_episode_dates.py

Dry-run (audit only, no writes):
    .venv/bin/python scripts/migrate_tenant_and_episode_dates.py --dry-run
"""

import os
import sys
import argparse
from neo4j import GraphDatabase
from dotenv import load_dotenv

load_dotenv('.env', override=True)

NEO4J_URI      = os.getenv("NEO4J_URI")
NEO4J_USERNAME = os.getenv("NEO4J_USERNAME", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD")

ORG_ID  = "org_3AacpFBbt39hPmDKyZyNBQuuM6t"
USER_ID = "user_3AadvqIme5F12afWwde9nv92T5R"

VIOLATION_TYPES = {
    "Company":     "SYSTEM",
    "Degree":      "SYSTEM",
    "Startup":     "SYSTEM",
    "Hackathon":   "PUBLIC",
    "Publication": "PUBLIC",
}

EXPECTED_COUNTS = {
    "Company":     6,
    "Degree":      2,
    "Startup":     1,
    "Hackathon":   2,
    "Publication": 3,
}

STALE_CONCEPT_TENANT = ORG_ID
EXPECTED_STALE_CONCEPTS = 6
EXPECTED_EPISODES = 6


def run(driver, query, **params):
    with driver.session() as session:
        return list(session.run(query, **params))


# ── Phase 1: Audit ────────────────────────────────────────────────────────────

def audit_violating_nodes(driver):
    print("\n── Phase 1.1: Violating node types ──")
    results = run(driver, """
        MATCH (n)
        WHERE labels(n)[0] IN ['Company','Degree','Startup','Hackathon','Publication']
          AND n.tenant_id IN ['SYSTEM','PUBLIC']
        RETURN labels(n)[0] AS type, n.name AS name,
               n.tenant_id AS tenant_id, n.owner_id AS owner_id
        ORDER BY type, name
    """)
    if not results:
        print("  No violating nodes found — already migrated or audit mismatch.")
        return False

    counts = {}
    owner_mismatch = False
    for r in results:
        print(f"  [{r['type']}] {r['name']}  tenant={r['tenant_id']}  owner={r['owner_id']}")
        counts[r['type']] = counts.get(r['type'], 0) + 1
        if r['owner_id'] != 'user_SYSTEM_ADMIN':
            print(f"    ⚠️  Unexpected owner_id — expected 'user_SYSTEM_ADMIN', got '{r['owner_id']}'")
            owner_mismatch = True

    print()
    for t, expected in EXPECTED_COUNTS.items():
        actual = counts.get(t, 0)
        status = "✓" if actual == expected else f"⚠️  expected {expected}"
        print(f"  {t}: {actual} nodes  {status}")

    if owner_mismatch:
        print("\n  ⛔ owner_id mismatch detected — review before proceeding.")
        return False
    return True


def audit_stale_concepts(driver):
    print("\n── Phase 1.2: Stale org-tenant Concept copies ──")
    results = run(driver, """
        MATCH (c:Concept {tenant_id: $org_id})
        RETURN c.name AS name,
               [(c)-[r]-() | {rel_type: type(r)}] AS rels
        ORDER BY name
    """, org_id=STALE_CONCEPT_TENANT)

    if not results:
        print("  No stale Concept copies found.")
        return True, False

    has_rels = False
    for r in results:
        rel_types = [x['rel_type'] for x in r['rels']]
        marker = "⚠️  HAS RELATIONSHIPS" if rel_types else "✓ no rels"
        print(f"  {r['name']}  {marker}  {rel_types}")
        if rel_types:
            has_rels = True

    count = len(results)
    status = "✓" if count == EXPECTED_STALE_CONCEPTS else f"⚠️  expected {EXPECTED_STALE_CONCEPTS}"
    print(f"\n  Stale concepts found: {count}  {status}")
    if has_rels:
        print("  ⚠️  Some stale concepts have relationships — will re-point before deleting.")
    return True, has_rels


def audit_episode_dates(driver):
    print("\n── Phase 1.3: Episode date fields ──")
    results = run(driver, """
        MATCH (e:Episode)
        RETURN e.name AS name, e.aired_date AS aired_date,
               e.year AS year, e.startYear AS startYear,
               e.endYear AS endYear, e.displayDate AS displayDate
        ORDER BY name
    """)

    if not results:
        print("  No Episode nodes found.")
        return False

    stale_count = 0
    for r in results:
        has_stale = any(r[f] is not None for f in ['startYear', 'endYear', 'displayDate'])
        marker = "⚠️  stale fields present" if has_stale else "✓ clean"
        print(f"  {r['name']}")
        print(f"    aired_date={r['aired_date']}  year={r['year']}  {marker}")
        if has_stale:
            print(f"    startYear={r['startYear']}  endYear={r['endYear']}  displayDate={r['displayDate']}")
            stale_count += 1

    print(f"\n  Episodes with stale fields: {stale_count} of {len(results)}")
    return True


# ── Phase 2: Migrations ───────────────────────────────────────────────────────

def migrate_violating_nodes(driver):
    print("\n── Phase 2.1–2.5: Migrating violating node types ──")
    for node_type, from_tenant in VIOLATION_TYPES.items():
        results = run(driver, f"""
            MATCH (n:{node_type} {{tenant_id: $from_tenant}})
            SET n.tenant_id = $org_id, n.owner_id = $user_id
            RETURN n.name AS name, n.tenant_id AS tenant_id, n.owner_id AS owner_id
        """, from_tenant=from_tenant, org_id=ORG_ID, user_id=USER_ID)

        if not results:
            print(f"  {node_type}: nothing to migrate (already done or none found)")
        else:
            for r in results:
                print(f"  ✓ {node_type}: {r['name']}  →  tenant={r['tenant_id']}  owner={r['owner_id']}")


def migrate_stale_concepts(driver, has_rels):
    print("\n── Phase 2.6: Stale Concept copy resolution ──")
    if has_rels:
        # Only re-point COVERS_CONCEPT — the semantic link from Episodes to these Concepts.
        # SIMILAR/IS_SIMILAR are vector similarity edges; canonical SYSTEM copies already have
        # their own. HAS_ACCESS/OWNS are GACL entries that must not be written onto SYSTEM-tier
        # nodes (SYSTEM concepts are globally visible — no org-specific ownership applies).
        print("  Re-pointing COVERS_CONCEPT from stale copies to canonical SYSTEM versions...")
        results = run(driver, """
            MATCH (stale:Concept {tenant_id: $org_id})
            MATCH (canonical:Concept {tenant_id: 'SYSTEM', name: stale.name})
            MATCH (source)-[r:COVERS_CONCEPT]->(stale)
            MERGE (source)-[r2:COVERS_CONCEPT]->(canonical)
            SET r2 = properties(r)
            DELETE r
            RETURN stale.name AS name, count(r) AS repointed
        """, org_id=STALE_CONCEPT_TENANT)
        for r in results:
            print(f"  Re-pointed COVERS_CONCEPT: {r['name']}  count={r['repointed']}")

    count_result = run(driver, """
        MATCH (c:Concept {tenant_id: $org_id})
        RETURN count(c) AS total
    """, org_id=STALE_CONCEPT_TENANT)
    total = count_result[0]['total'] if count_result else 0

    run(driver, """
        MATCH (c:Concept {tenant_id: $org_id})
        DETACH DELETE c
    """, org_id=STALE_CONCEPT_TENANT)
    print(f"  ✓ Deleted {total} stale Concept copies (DETACH DELETE — all remaining rels dropped)")


def migrate_episode_dates(driver):
    print("\n── Phase 2.7: Remove stale date fields from Episode nodes ──")
    results = run(driver, """
        MATCH (e:Episode)
        REMOVE e.startYear, e.endYear, e.displayDate
        RETURN e.name AS name, e.aired_date AS aired_date, e.year AS year
    """)
    for r in results:
        print(f"  ✓ {r['name']}  aired_date={r['aired_date']}  year={r['year']}")
    print(f"  Cleaned {len(results)} Episode nodes")


# ── Phase 3: Post-migration verification ─────────────────────────────────────

def verify(driver):
    print("\n── Phase 3: Post-migration verification ──")

    # 3.1 — no more SYSTEM/PUBLIC violations
    violations = run(driver, """
        MATCH (n)
        WHERE labels(n)[0] IN ['Company','Degree','Startup','Hackathon','Publication']
          AND n.tenant_id IN ['SYSTEM','PUBLIC']
        RETURN count(n) AS remaining
    """)
    count = violations[0]['remaining']
    print(f"  Remaining SYSTEM/PUBLIC violations: {count}  {'✓' if count == 0 else '⛔ FAIL'}")

    # 3.2 — migrated nodes have correct tenant and owner
    migrated = run(driver, """
        MATCH (n)
        WHERE labels(n)[0] IN ['Company','Degree','Startup','Hackathon','Publication']
          AND n.tenant_id = $org_id AND n.owner_id = $user_id
        RETURN count(n) AS migrated
    """, org_id=ORG_ID, user_id=USER_ID)
    expected_total = sum(EXPECTED_COUNTS.values())  # 14
    count = migrated[0]['migrated']
    print(f"  Correctly migrated nodes: {count}/{expected_total}  {'✓' if count == expected_total else '⛔ FAIL'}")

    # 3.3 — no stale Concept copies
    stale = run(driver, """
        MATCH (c:Concept {tenant_id: $org_id})
        RETURN count(c) AS remaining
    """, org_id=STALE_CONCEPT_TENANT)
    count = stale[0]['remaining']
    print(f"  Remaining stale Concept copies: {count}  {'✓' if count == 0 else '⛔ FAIL'}")

    # 3.4 — Episode nodes clean
    episodes = run(driver, """
        MATCH (e:Episode)
        WHERE e.startYear IS NOT NULL OR e.endYear IS NOT NULL OR e.displayDate IS NOT NULL
        RETURN count(e) AS dirty
    """)
    count = episodes[0]['dirty']
    print(f"  Episode nodes with stale date fields: {count}  {'✓' if count == 0 else '⛔ FAIL'}")

    # 3.5 — Episode aired_date and year still intact
    episodes_ok = run(driver, """
        MATCH (e:Episode)
        WHERE e.aired_date IS NOT NULL AND e.year IS NOT NULL
        RETURN count(e) AS intact
    """)
    count = episodes_ok[0]['intact']
    print(f"  Episode nodes with aired_date + year intact: {count}/{EXPECTED_EPISODES}  {'✓' if count == EXPECTED_EPISODES else '⛔ FAIL'}")


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Tenant migration + Episode date cleanup")
    parser.add_argument("--dry-run", action="store_true", help="Audit only — no writes")
    args = parser.parse_args()

    if not NEO4J_PASSWORD:
        print("⛔ NEO4J_PASSWORD not set.")
        sys.exit(1)

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USERNAME, NEO4J_PASSWORD))
    try:
        driver.verify_connectivity()
        print(f"Connected to {NEO4J_URI}")
    except Exception as e:
        print(f"⛔ Connection failed: {e}")
        sys.exit(1)

    try:
        # Phase 1
        violations_ok = audit_violating_nodes(driver)
        concepts_ok, has_rels = audit_stale_concepts(driver)
        episodes_ok = audit_episode_dates(driver)

        if args.dry_run:
            print("\n── Dry-run complete — no writes performed ──")
            return

        if not violations_ok:
            print("\n⛔ Audit found unexpected state. Aborting migration.")
            print("   Review the output above and re-run after resolving.")
            sys.exit(1)

        # Phase 2
        migrate_violating_nodes(driver)
        migrate_stale_concepts(driver, has_rels)
        migrate_episode_dates(driver)

        # Phase 3
        verify(driver)

        print("\n── Migration complete. Run AP-12 gate: Q1, Q2, Q3 before proceeding to code changes. ──")

    finally:
        driver.close()


if __name__ == "__main__":
    main()
