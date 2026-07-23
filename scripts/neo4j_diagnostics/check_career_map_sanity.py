#!/usr/bin/env python3
"""Quick sanity check: does a given Person node still have its expected career-graph
connections? Run before/after any admin script that touches tenant_id or relationships,
to catch an accidental break.

Usage:
  .venv/bin/python scripts/neo4j_diagnostics/check_career_map_sanity.py "Sangeetha Ramadurai"
"""
import argparse

from _connection import neo4j_session


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("person_name", nargs="?", default="Sangeetha Ramadurai")
    args = parser.parse_args()

    with neo4j_session() as s:
        person = s.run(
            "MATCH (p:Person {name: $name}) RETURN p.tenant_id AS tenant_id",
            name=args.person_name,
        ).single()

        if not person:
            print(f"No Person node found named '{args.person_name}'.")
            return

        print(f"Person: {args.person_name}")
        print(f"  tenant_id: {person['tenant_id']}")

        connected = s.run(
            """
            MATCH (p:Person {name: $name})-[:WORKED_AT|HELD_ROLE|GRADUATED_FROM]->(n)
            RETURN count(DISTINCT n) AS c
            """,
            name=args.person_name,
        ).single()["c"]
        print(f"  connected nodes (WORKED_AT/HELD_ROLE/GRADUATED_FROM): {connected}")

        if connected == 0:
            print("  — WARNING: zero connections found. Career graph may be broken.")
        else:
            print("  — looks intact")


if __name__ == "__main__":
    main()
