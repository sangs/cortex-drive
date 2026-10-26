#!/usr/bin/env python3
"""Check (and optionally fix) Invariant 9 violations.

Invariant 9 (rewritten 2026-10-26, S2-44, visibility-tiers-design-2026-10-23.md): SYSTEM holds curated built-in
vocabulary only (schema_guard.SEED_BUILTIN_VOCABULARY_LABELS). Career-domain nodes are never SYSTEM: they are
org-tenant, except the founder's career graph, which is PUBLIC. This checker reports career-labelled SYSTEM nodes
(fixable with --fix) and, separately, any other SYSTEM node outside the vocabulary list (report only).

Mirrors documents/cortex-neo4j-cypher-queries.md §2.3 / CLAUDE.md Invariant 9 / AP-14.

Usage:
  .venv/bin/python scripts/neo4j_diagnostics/check_invariant9_violations.py
  .venv/bin/python scripts/neo4j_diagnostics/check_invariant9_violations.py --fix org_abc123
"""
import argparse

import os
import sys
from _connection import neo4j_session
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "src", "mcp_server"))
from schema_guard import SEED_BUILTIN_VOCABULARY_LABELS  # noqa: E402

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


def find_non_vocabulary_system(s):
    return list(s.run(
        """
        MATCH (n)
        WHERE n.tenant_id = 'SYSTEM'
          AND NOT any(lbl IN labels(n) WHERE lbl IN $vocab)
          AND NOT any(lbl IN labels(n) WHERE lbl IN $career)
        RETURN labels(n)[0] AS label, n.name AS name
        ORDER BY label, name
        """,
        vocab=SEED_BUILTIN_VOCABULARY_LABELS, career=CAREER_LABELS,
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
        other = find_non_vocabulary_system(s)
        print(f"SYSTEM nodes outside the built-in vocabulary (review, not auto-fixed): {len(other)}")
        for r in other:
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
