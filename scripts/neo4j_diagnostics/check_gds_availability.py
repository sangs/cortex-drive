#!/usr/bin/env python3
"""Check whether Neo4j Graph Data Science (GDS) is installed and enabled on the
connected instance. Read-only.

Usage: .venv/bin/python scripts/neo4j_diagnostics/check_gds_availability.py
"""
import sys

from _connection import neo4j_session


def main():
    with neo4j_session() as s:
        try:
            version = s.run("CALL gds.version() YIELD gdsVersion RETURN gdsVersion").single()
            print(f"GDS version: {version['gdsVersion']}")
        except Exception as e:
            print(f"GDS NOT available: {e}")
            sys.exit(1)

        print()
        print("Key gds.* procedures:")
        for pattern in ["gds.shortestPath.dijkstra", "gds.graph.project", "gds.nodeSimilarity"]:
            rows = list(s.run(
                "SHOW PROCEDURES YIELD name WHERE name STARTS WITH $p RETURN name ORDER BY name",
                p=pattern,
            ))
            names = [r["name"] for r in rows]
            print(f"  {pattern}: {len(names)} found")
            for n in names:
                print(f"    - {n}")

        total = s.run(
            "SHOW PROCEDURES YIELD name WHERE name STARTS WITH 'gds.' RETURN count(name) AS total"
        ).single()
        print()
        print(f"Total gds.* procedures: {total['total']}")

        edition = s.run(
            "CALL dbms.components() YIELD name, versions, edition RETURN name, versions, edition"
        ).data()
        print()
        print("dbms.components():")
        for row in edition:
            print(f"  {row['name']}: {row['versions']} ({row['edition']})")


if __name__ == "__main__":
    main()
