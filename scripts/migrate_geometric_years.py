"""
Year anchors for career items, test tenant only (rewritten 2026-11-16, tracker S2-82).

    .venv/bin/python scripts/migrate_geometric_years.py              # dry run: counts only, writes nothing
    .venv/bin/python scripts/migrate_geometric_years.py --apply      # write Year anchors in the test tenant
    .venv/bin/python scripts/migrate_geometric_years.py --rollback   # remove what --apply wrote

Before: an in-code `bolt://localhost` credential (AP-24), a global `MATCH (y:Year) DETACH DELETE y` across every
tenant, and unscoped `MATCH (n)` / `MERGE (:Year {name})` (AP-14, Invariant 9). Owner decision 2026-11-16: keep it,
run it against the test account only.

Guards:
- connects through the one driver factory (`neo4j_connection.create_driver`, S2-79); no credentials in code;
- reads and writes only `tests.test_tenant.TEST_TENANT_ID`; there is no option to pass another tenant;
- Year nodes it creates carry the test tenant and `created_by = SCRIPT_TAG`; built-in SYSTEM Year nodes are never
  matched, changed or deleted;
- `--rollback` deletes only nodes / relationships carrying `SCRIPT_TAG` in the test tenant;
- dry run is the default.

The production career timeline uses sortable year numbers on the items themselves
(`architecture/career-timeline-ordering-design-2026-11-16.md`), not Year anchor nodes.
"""
import argparse
import datetime
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))
from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(ROOT, ".env"))
from neo4j_connection import create_driver  # noqa: E402 — the one driver factory (S2-79)
from tests.test_tenant import TEST_TENANT_ID  # noqa: E402 — the shared test tenant (2026-10-06)

SCRIPT_TAG = "migrate_geometric_years"
# Career item labels that carry start / end years; read once here, passed to Cypher as a parameter.
DATED_LABELS = ["Project", "Role", "Hackathon", "ThoughtLeadership", "ProfessionalEducation"]
ONGOING_END = "Present"   # an item still running ends in the current year (computed, never a fixed year)

_ITEMS = """
MATCH (n {tenant_id: $tenant})
WHERE any(l IN labels(n) WHERE l IN $labels)
WITH n, coalesce(n.startYear, toString(n.year)) AS s, coalesce(n.endYear, toString(n.year)) AS e
WHERE s IS NOT NULL
WITH n, toInteger(s) AS start_y, toInteger(CASE WHEN e = $ongoing THEN toString($this_year) ELSE e END) AS end_y
WHERE start_y IS NOT NULL AND end_y IS NOT NULL AND start_y <= end_y
"""

COUNT = _ITEMS + "RETURN count(n) AS items, sum(end_y - start_y + 1) AS links"

APPLY = _ITEMS + """
UNWIND range(start_y, end_y) AS y_val
MERGE (y:Year {name: toString(y_val), tenant_id: $tenant, created_by: $tag})
  ON CREATE SET y.id = $tenant + ':Year_' + toString(y_val)
MERGE (n)-[r:ACTIVE_DURING]->(y)
  ON CREATE SET r.tenant_id = $tenant, r.created_by = $tag
RETURN count(r) AS links
"""

ROLLBACK = """
MATCH (y:Year {tenant_id: $tenant, created_by: $tag})
DETACH DELETE y
RETURN count(y) AS removed
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="write Year anchors in the test tenant")
    mode.add_argument("--rollback", action="store_true", help="remove the Year anchors this script wrote")
    args = parser.parse_args()

    params = {"tenant": TEST_TENANT_ID, "labels": DATED_LABELS, "ongoing": ONGOING_END,
              "this_year": datetime.date.today().year, "tag": SCRIPT_TAG}
    driver = create_driver()
    try:
        with driver.session() as session:
            if args.rollback:
                print(f"Removed {session.run(ROLLBACK, params).single()['removed']} Year nodes from {TEST_TENANT_ID}")
                return 0
            row = session.run(COUNT, params).single()
            print(f"Tenant {TEST_TENANT_ID}: {row['items']} dated items, {row['links'] or 0} year links")
            if not args.apply:
                print("Dry run: nothing written. Add --apply to write.")
                return 0
            print(f"Wrote {session.run(APPLY, params).single()['links']} ACTIVE_DURING links")
    finally:
        driver.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
