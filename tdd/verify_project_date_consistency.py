"""
TDD: Graph-Wide Project Date Consistency Verification.

This is the canonical date consistency guard for the CortexDrive career graph.
It verifies that ALL nodes with date-carrying relationships have correct
derived cache properties (startEpoch, endEpoch, isPresent, displayDate)
that match their relationship source of truth.

Red criteria (ALL must pass to go green):
  - Every node connected via a date-carrying relationship must have startEpoch
  - startEpoch must match the parsed relationship start date
  - endEpoch must match the parsed relationship end date (999999 for "Present")
  - isPresent must be True if and only if rel.end == "Present"
  - displayDate must be present and non-empty

Run this after every seeder execution to detect data drift.
"""

import os
import json
import sys
import re

# Add the src/mcp_server to the path
sys.path.append(os.path.join(os.getcwd(), "src", "mcp_server"))

PRESENT_SENTINEL = 999999


def parse_epoch(date_str: str, is_end: bool = False) -> int:
    """
    Convert a date string to a yyyyMM integer epoch.

    Handles:
      - "mm/yyyy"  →  yyyyMM (e.g., "02/2024" → 202402)
      - "Present"  →  999999 (sentinel for present/active)
      - "yyyy"     →  yyyyMM (Jan for start, Dec for end)
    """
    if not date_str:
        return None
    val = date_str.strip()

    # Handle "Present" / "PRESENT" / "present"
    if val.lower() in ("present", "active", "current"):
        return PRESENT_SENTINEL

    # Handle "mm/yyyy" format
    mm_yyyy = re.match(r"^(\d{2})/(\d{4})$", val)
    if mm_yyyy:
        month = int(mm_yyyy.group(1))
        year = int(mm_yyyy.group(2))
        return year * 100 + month

    # Handle "yyyy" format — use Jan for start, Dec for end
    yyyy = re.match(r"^(\d{4})$", val)
    if yyyy:
        year = int(yyyy.group(1))
        return year * 100 + (12 if is_end else 1)

    return None


try:
    from neo4j import GraphDatabase

    neo4j_uri = os.getenv("NEO4J_URI", "")
    neo4j_user = os.getenv("NEO4J_USERNAME", "neo4j")
    neo4j_pass = os.getenv("NEO4J_PASSWORD", "")
    tenant_id = os.getenv("TENANT_ID", "org_3AacpFBbt39hPmDKyZyNBQuuM6t")

    print("--- 🔍 TDD RED: Graph-Wide Project Date Consistency ---")
    print(f"    Tenant: {tenant_id}")

    # Query all date-carrying relationships and their connected node cache values
    driver = GraphDatabase.driver(neo4j_uri, auth=(neo4j_user, neo4j_pass))

    with driver.session() as session:
        # Check relationship → node consistency for all project/activity nodes
        result = session.run(
            """
            MATCH (n {tenant_id: $tid})
            WHERE (n:Project OR n:Hackathon OR n:ThoughtLeadership OR n:Community)
            OPTIONAL MATCH ()-[rel:CONTRIBUTED_TO|PARTICIPATED_IN|FEATURE_GUEST|AUTHORED]->(n)
            WHERE rel.start IS NOT NULL OR rel.end IS NOT NULL
            RETURN
                n.name AS name,
                labels(n)[0] AS label,
                rel.start AS rel_start,
                rel.end AS rel_end,
                n.startEpoch AS node_startEpoch,
                n.endEpoch AS node_endEpoch,
                n.isPresent AS node_isPresent,
                n.displayDate AS node_displayDate,
                n.startYear AS node_startYear,
                n.endYear AS node_endYear
            ORDER BY name
            """,
            tid=tenant_id,
        )
        records = list(result)

    driver.close()

    print(f"\n📊 Found {len(records)} node-relationship pairs to verify.\n")

    issues = []
    seen_nodes = set()

    for rec in records:
        name = rec["name"] or "(unnamed)"
        label = rec["label"] or "(unknown)"
        rel_start = rec["rel_start"]
        rel_end = rec["rel_end"]
        n_start_epoch = rec["node_startEpoch"]
        n_end_epoch = rec["node_endEpoch"]
        n_is_present = rec["node_isPresent"]
        n_display_date = rec["node_displayDate"]
        n_start_year = rec["node_startYear"]
        n_end_year = rec["node_endYear"]

        # Skip nodes with no relationship dates (may be Category-only nodes)
        if rel_start is None and rel_end is None:
            continue

        # Avoid duplicate checking for same node (multiple rels)
        node_key = name
        if node_key in seen_nodes:
            continue
        seen_nodes.add(node_key)

        node_issues = []

        # --- Check 1: startEpoch must exist ---
        if n_start_epoch is None:
            node_issues.append(f"startEpoch missing (rel.start='{rel_start}')")
        else:
            expected_start = parse_epoch(rel_start, is_end=False) if rel_start else None
            if expected_start and int(n_start_epoch) != expected_start:
                node_issues.append(
                    f"startEpoch mismatch: node={n_start_epoch}, expected={expected_start} "
                    f"(from rel.start='{rel_start}')"
                )

        # --- Check 2: endEpoch must exist ---
        if n_end_epoch is None:
            node_issues.append(f"endEpoch missing (rel.end='{rel_end}')")
        else:
            expected_end = parse_epoch(rel_end, is_end=True) if rel_end else None
            if expected_end and int(n_end_epoch) != expected_end:
                node_issues.append(
                    f"endEpoch mismatch: node={n_end_epoch}, expected={expected_end} "
                    f"(from rel.end='{rel_end}')"
                )

        # --- Check 3: isPresent must be correct ---
        expected_is_present = (
            rel_end is not None and rel_end.strip().lower() == "present"
        )
        if n_is_present is None:
            node_issues.append("isPresent missing")
        elif bool(n_is_present) != expected_is_present:
            node_issues.append(
                f"isPresent mismatch: node={n_is_present}, expected={expected_is_present} "
                f"(rel.end='{rel_end}')"
            )

        # --- Check 4: displayDate must be non-empty ---
        if not n_display_date:
            node_issues.append("displayDate missing or empty")

        # --- Check 5: startYear and endYear must be present ---
        if not n_start_year:
            node_issues.append("startYear missing")
        if not n_end_year and not expected_is_present:
            node_issues.append("endYear missing (and not a present-active node)")

        # Report
        if node_issues:
            issues.append((name, label, node_issues))
            print(f"  ❌ [{label}] {name}")
            for issue in node_issues:
                print(f"     → {issue}")
        else:
            print(f"  ✅ [{label}] {name}")

    print(f"\n{'=' * 60}")
    if not issues:
        print(f"🎊 TDD SUCCESS: All {len(seen_nodes)} nodes pass date consistency check!")
        sys.exit(0)
    else:
        print(
            f"❌ TDD FAILURE: {len(issues)}/{len(seen_nodes)} nodes have date consistency issues."
        )
        print("   Run the seeder to propagate startEpoch/endEpoch to all nodes.")
        sys.exit(1)

except Exception as e:
    print(f"🛑 CRITICAL ERROR: {str(e)}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
