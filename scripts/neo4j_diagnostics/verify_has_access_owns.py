#!/usr/bin/env python3
"""Verify (and optionally clean up) stale HAS_ACCESS/OWNS relationships.

Mirrors documents/cortex-neo4j-cypher-queries.md §2.1/§2.2. Both relationship types
are dead — authorization is handled by Permify/OpenFGA, not Neo4j relationships.

Usage:
  .venv/bin/python scripts/neo4j_diagnostics/verify_has_access_owns.py            # read-only
  .venv/bin/python scripts/neo4j_diagnostics/verify_has_access_owns.py --cleanup  # delete + re-verify
"""
import argparse

from _connection import neo4j_session


def counts(s):
    has_access = s.run("MATCH ()-[r:HAS_ACCESS]->() RETURN count(r) AS c").single()["c"]
    owns = s.run("MATCH ()-[r:OWNS]->() RETURN count(r) AS c").single()["c"]
    return has_access, owns


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cleanup", action="store_true", help="Delete HAS_ACCESS/OWNS edges, then re-verify.")
    args = parser.parse_args()

    with neo4j_session() as s:
        has_access, owns = counts(s)
        print(f"HAS_ACCESS count: {has_access} (expect 0)")
        print(f"OWNS count: {owns} (expect 0)")

        if not args.cleanup:
            if has_access == 0 and owns == 0:
                print("— clean")
            else:
                print(f"Run with --cleanup to delete {has_access + owns} stale edge(s).")
            return

        if has_access == 0 and owns == 0:
            print("Nothing to clean up.")
            return

        print()
        print("Deleting...")
        s.run("MATCH ()-[r:HAS_ACCESS]->() DELETE r")
        s.run("MATCH ()-[r:OWNS]->() DELETE r")

        has_access, owns = counts(s)
        print(f"Re-verified — HAS_ACCESS count: {has_access} (expect 0)")
        print(f"Re-verified — OWNS count: {owns} (expect 0)")
        print("— clean" if has_access == 0 and owns == 0 else "— WARNING: still nonzero")


if __name__ == "__main__":
    main()
