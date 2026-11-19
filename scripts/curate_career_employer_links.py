#!/usr/bin/env python3
"""Link career items to the employer they were done at (S2-94).

Design: documents/architecture/career-map-chronology-design-2026-11-19.md §3.1.
Mapping (data): data/curation/career_employer_links.json, confirmed by the owner 2026-11-19.

Writes `(employer:Company)-[:CONTAINS]->(item)` between EXISTING nodes of one tier (PUBLIC for the founder's career
graph). It never creates or deletes nodes and never changes `tenant_id` (Invariant 9 / AP-14).

Refuses the whole run (nothing written) when any entry:
  - matches 0 or more than 1 item (by exact name AND all `item_labels`; AP-13 collision check),
  - matches 0 or more than 1 employer,
  - is outside the tier,
  - already has a DIFFERENT employer link.
Entries already linked to the same employer are skipped, so a re-run changes nothing (idempotent).

Usage:
    .venv/bin/python scripts/curate_career_employer_links.py            # dry run: prints the plan
    .venv/bin/python scripts/curate_career_employer_links.py --apply    # writes, in one transaction
After --apply on the live graph, invalidate cached career answers (POST /api/cache/invalidate) or ask with refresh.
"""
import argparse
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_MAPPING = os.path.join(REPO, "data", "curation", "career_employer_links.json")
sys.path.insert(0, os.path.join(REPO, "src", "mcp_server"))

CURATION_SOURCE = "curation:career_employer_links"


def load_mapping(path: str = DEFAULT_MAPPING) -> dict:
    with open(path) as f:
        return json.load(f)


def plan_links(session, mapping: dict, tier: str) -> dict:
    """Read-only. Returns {"to_link": [...], "already": [...], "errors": [...]}."""
    from schema_guard import EMPLOYER_LABEL, EMPLOYER_CONTAINS_RELATIONSHIP, EMPLOYER_AT_RELATIONSHIP
    if mapping.get("employer_label") != EMPLOYER_LABEL or mapping.get("relationship") != EMPLOYER_CONTAINS_RELATIONSHIP:
        raise ValueError("mapping file disagrees with schema_guard (employer label / relationship)")
    plan = {"to_link": [], "already": [], "errors": []}
    for entry in mapping["links"]:
        items = session.run(
            "MATCH (n {name: $name}) WHERE all(l IN $labels WHERE l IN labels(n)) "
            "RETURN elementId(n) AS id, n.tenant_id AS tier",
            name=entry["item"], labels=entry["item_labels"]).data()
        employers = session.run(
            f"MATCH (e:{EMPLOYER_LABEL} {{name: $name}}) RETURN elementId(e) AS id, e.tenant_id AS tier",
            name=entry["employer"]).data()
        label = f'{entry["item"]} → {entry["employer"]}'
        if len(items) != 1:
            plan["errors"].append(f"{label}: {len(items)} items match (need exactly 1)")
            continue
        if len(employers) != 1:
            plan["errors"].append(f"{label}: {len(employers)} employers match (need exactly 1)")
            continue
        if items[0]["tier"] != tier or employers[0]["tier"] != tier:
            plan["errors"].append(f"{label}: outside tier {tier} (item {items[0]['tier']}, employer {employers[0]['tier']})")
            continue
        current = session.run(
            f"MATCH (n) WHERE elementId(n) = $id "
            f"OPTIONAL MATCH (e1:{EMPLOYER_LABEL})-[:{EMPLOYER_CONTAINS_RELATIONSHIP}]->(n) "
            f"OPTIONAL MATCH (n)-[:{EMPLOYER_AT_RELATIONSHIP}]->(e2:{EMPLOYER_LABEL}) "
            f"RETURN [x IN collect(DISTINCT e1.name) + collect(DISTINCT e2.name) WHERE x IS NOT NULL] AS names",
            id=items[0]["id"]).single()["names"]
        others = [n for n in current if n != entry["employer"]]
        if others:
            plan["errors"].append(f"{label}: already linked to a different employer {others}")
        elif entry["employer"] in current:
            plan["already"].append(label)
        else:
            plan["to_link"].append({"label": label, "item_id": items[0]["id"], "employer_id": employers[0]["id"]})
    return plan


def apply_links(session, plan: dict) -> int:
    """Writes the planned links in ONE transaction. Refuses if the plan has errors. Returns links created."""
    from schema_guard import EMPLOYER_CONTAINS_RELATIONSHIP
    if plan["errors"]:
        raise RuntimeError("refusing to write: the plan has errors")
    if not plan["to_link"]:
        return 0

    def work(tx):
        created = 0
        for link in plan["to_link"]:
            rec = tx.run(
                f"MATCH (e) WHERE elementId(e) = $eid MATCH (n) WHERE elementId(n) = $nid "
                f"MERGE (e)-[r:{EMPLOYER_CONTAINS_RELATIONSHIP}]->(n) "
                f"ON CREATE SET r.source = $source, r.created_at = datetime() "
                f"RETURN r.source = $source AS ours",
                eid=link["employer_id"], nid=link["item_id"], source=CURATION_SOURCE).single()
            created += 1 if rec and rec["ours"] else 0
        return created

    return session.execute_write(work)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="write the links (default: dry run)")
    parser.add_argument("--mapping", default=DEFAULT_MAPPING)
    args = parser.parse_args()

    from dotenv import load_dotenv
    load_dotenv()
    from neo4j_connection import create_driver
    mapping = load_mapping(args.mapping)
    tier = mapping["required_tier"]
    driver = create_driver()
    try:
        with driver.session() as session:
            plan = plan_links(session, mapping, tier)
            for label in plan["already"]:
                print(f"  = already linked: {label}")
            for link in plan["to_link"]:
                print(f"  + to link:        {link['label']}")
            for err in plan["errors"]:
                print(f"  ! {err}")
            if plan["errors"]:
                print(f"Refused: {len(plan['errors'])} problem(s); nothing written.")
                return 1
            if not args.apply:
                print(f"Dry run: {len(plan['to_link'])} link(s) would be created, {len(plan['already'])} already present. "
                      f"Run with --apply to write.")
                return 0
            created = apply_links(session, plan)
            print(f"Applied: {created} link(s) created. Invalidate cached career answers next.")
            return 0
    finally:
        driver.close()


if __name__ == "__main__":
    sys.exit(main())
