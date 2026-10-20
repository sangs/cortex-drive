"""
Uniqueness constraint for Phase B documents (M3'): one DocumentSource per (tenant_id, uri).

The worker's per-document Redis lock prevents two runs from ingesting the same document at once;
this constraint is the database-level guarantee behind it: even if two runs ever overlapped (e.g. a
Redis failover lost the lock), Neo4j refuses a second DocumentSource for the same document, and
MERGE on (tenant_id, uri) becomes concurrency-safe.

Checks for existing duplicates first and refuses to continue if any exist (the constraint can't be
created over them). Read-only unless --apply. Idempotent: CREATE ... IF NOT EXISTS.

    .venv/bin/python scripts/create_document_source_constraint.py            # check only
    .venv/bin/python scripts/create_document_source_constraint.py --apply    # check, then create
"""
import os
import sys

from dotenv import load_dotenv
from neo4j import GraphDatabase

CONSTRAINT_NAME = "documentSourceIdentity"
LABEL = "DocumentSource"
KEY_PROPERTIES = ("tenant_id", "uri")


def main() -> int:
    load_dotenv()
    apply = "--apply" in sys.argv[1:]
    driver = GraphDatabase.driver(os.environ["NEO4J_URI"],
                                  auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"]))
    try:
        with driver.session() as session:
            total = session.run(f"MATCH (d:{LABEL}) RETURN count(d) AS c").single()["c"]
            dups = [r.data() for r in session.run(
                f"""MATCH (d:{LABEL}) WITH d.tenant_id AS tenant_id, d.uri AS uri, count(*) AS n
                    WHERE n > 1 RETURN tenant_id, uri, n ORDER BY n DESC LIMIT 20""")]
            existing = [r["name"] for r in session.run("SHOW CONSTRAINTS YIELD name RETURN name")
                        if r["name"] == CONSTRAINT_NAME]
            print(f"{LABEL} nodes: {total}; duplicate (tenant_id, uri) groups: {len(dups)}; "
                  f"constraint present: {bool(existing)}")
            for d in dups:
                print(f"  duplicate: {d}")
            if dups:
                print("Refusing to create the constraint over duplicates; resolve them first.")
                return 1
            if not apply:
                print("Check only. Re-run with --apply to create the constraint.")
                return 0
            props = ", ".join(f"d.{p}" for p in KEY_PROPERTIES)
            session.run(f"CREATE CONSTRAINT {CONSTRAINT_NAME} IF NOT EXISTS "
                        f"FOR (d:{LABEL}) REQUIRE ({props}) IS UNIQUE")
            state = [r.data() for r in session.run(
                "SHOW CONSTRAINTS YIELD name, type, labelsOrTypes, properties WHERE name = $n RETURN *",
                n=CONSTRAINT_NAME)]
            print(f"Created: {state}")
            return 0
    finally:
        driver.close()


if __name__ == "__main__":
    sys.exit(main())
