#!/usr/bin/env python3
"""Check (and optionally fix) Invariant 9 violations — career-domain node types that
should always be org-tenant, found tagged tenant_id='SYSTEM'.

Mirrors documents/cortex-neo4j-cypher-queries.md §2.3 / CLAUDE.md Invariant 9 / AP-14.

Usage:
  .venv/bin/python scripts/neo4j_diagnostics/check_invariant9_violations.py
  .venv/bin/python scripts/neo4j_diagnostics/check_invariant9_violations.py --fix org_abc123
"""
import argparse

from _connection import neo4j_session

CAREER_LABELS = [
    "Company", "Startup", "Hackathon", "Project", "Role", "Person",
    "Degree", "Publication", "Certification", "ThoughtLeadership",
]


def find_violations(s):
    return list(s.run(
        """
        MATCH (n)
        WHERE n.tenant_id = 'SYSTEM'
          AND any(lbl IN labels(n) WHERE lbl IN $labels)
        RETURN labels(n)[0] AS label, n.name AS name, elementId(n) AS eid
        ORDER BY label, name
        """,
        labels=CAREER_LABELS,
    ))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fix", metavar="ORG_TENANT_ID", help="Reassign found violations to this tenant_id, then re-verify.")
    args = parser.parse_args()

    with neo4j_session() as s:
        rows = find_violations(s)
        print(f"Invariant 9 violations found: {len(rows)} (expect 0)")
        for r in rows:
            print(f"  {r['label']}: {r['name']}")

        if not args.fix:
            print("— clean" if not rows else "Run with --fix <org_tenant_id> to reassign.")
            return

        if not rows:
            print("Nothing to fix.")
            return

        print()
        print(f"Reassigning {len(rows)} node(s) to tenant_id='{args.fix}'...")
        s.run(
            """
            MATCH (n)
            WHERE n.tenant_id = 'SYSTEM'
              AND any(lbl IN labels(n) WHERE lbl IN $labels)
            SET n.tenant_id = $tenant_id
            """,
            labels=CAREER_LABELS,
            tenant_id=args.fix,
        )

        rows = find_violations(s)
        print(f"Re-verified — violations: {len(rows)} (expect 0)")
        print("— clean" if not rows else "— WARNING: still nonzero")


if __name__ == "__main__":
    main()
