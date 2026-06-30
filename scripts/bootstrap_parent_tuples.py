#!/usr/bin/env python3
"""
Bootstrap Permify parent tuples and privacy attributes for the existing Neo4j graph.

Writes two things to Permify:
  1. parent tuples for every COMPOSITION_RELATIONSHIPS edge where both nodes are
     org-tenant and have node_id (249 edges in the current live graph).
  2. is_private=true attributes for every PreparatoryNote node (27 nodes).

Idempotent — Permify write operations are no-ops for existing data.
Must be run AFTER Permify Cloud Run service is deployed and schema is loaded.

Usage:
    PERMIFY_API_URL=https://cortex-permify-xxx.run.app \
    PERMIFY_API_TOKEN=$(gcloud auth print-identity-token) \
    NEO4J_URI=neo4j+s://... NEO4J_USERNAME=neo4j NEO4J_PASSWORD=... \
    python3 scripts/bootstrap_parent_tuples.py [--dry-run]
"""

import asyncio
import os
import sys
import argparse
from pathlib import Path

from dotenv import load_dotenv
from neo4j import GraphDatabase

load_dotenv()

# Add MCP server to path so permify_utils resolves
sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "mcp_server"))
from permify_utils import write_parent_tuple, write_privacy_attribute, _configured

# Relationships that carry downward permission inheritance.
# Must match COMPOSITION_RELATIONSHIPS in schema_guard.py.
COMPOSITION_RELATIONSHIPS = [
    "HAS_EPISODE",
    "HAS_SOURCE",
    "CONTAINS",
    "HAS_REFERENCE",
    "HAS_PRIVATE_NOTE",
]

BATCH_SIZE = 50


def get_neo4j_driver():
    return GraphDatabase.driver(
        os.environ["NEO4J_URI"],
        auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"]),
    )


def fetch_composition_edges(driver) -> list[tuple[str, str, str]]:
    """Return (rel_type, parent_node_id, child_node_id) for all org-tenant composition edges."""
    rel_pattern = "|".join(COMPOSITION_RELATIONSHIPS)
    query = f"""
        MATCH (parent)-[r:{rel_pattern}]->(child)
        WHERE parent.node_id IS NOT NULL
          AND child.node_id IS NOT NULL
          AND NOT parent.tenant_id IN ['SYSTEM', 'PUBLIC']
          AND NOT child.tenant_id IN ['SYSTEM', 'PUBLIC']
        RETURN type(r) AS rel_type,
               parent.node_id AS parent_id,
               child.node_id  AS child_id
        ORDER BY rel_type
    """
    with driver.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as session:
        return [(r["rel_type"], r["parent_id"], r["child_id"]) for r in session.run(query)]


def fetch_preparatory_notes(driver) -> list[str]:
    """Return node_ids of all PreparatoryNote nodes (all should get is_private=true)."""
    query = """
        MATCH (n:PreparatoryNote)
        WHERE n.node_id IS NOT NULL
          AND NOT n.tenant_id IN ['SYSTEM', 'PUBLIC']
        RETURN n.node_id AS node_id
    """
    with driver.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as session:
        return [r["node_id"] for r in session.run(query)]


async def bootstrap_parent_tuples(edges: list[tuple[str, str, str]], dry_run: bool) -> None:
    print(f"\n[bootstrap] Writing {len(edges)} parent tuples...")
    by_rel: dict[str, int] = {}
    for i, (rel_type, parent_id, child_id) in enumerate(edges):
        by_rel[rel_type] = by_rel.get(rel_type, 0) + 1
        if dry_run:
            if i < 5:
                print(f"  [dry-run] parent tuple: node:{child_id} -[parent]-> node:{parent_id}  (via {rel_type})")
            elif i == 5:
                print(f"  [dry-run] ... and {len(edges) - 5} more")
            continue
        await write_parent_tuple(child_node_id=child_id, parent_node_id=parent_id)
        if (i + 1) % BATCH_SIZE == 0:
            print(f"  [{i + 1}/{len(edges)}] tuples written")

    print("[bootstrap] Parent tuple summary:")
    for rel, cnt in sorted(by_rel.items()):
        print(f"  {rel}: {cnt}")


async def bootstrap_privacy_attributes(node_ids: list[str], dry_run: bool) -> None:
    print(f"\n[bootstrap] Writing is_private=true for {len(node_ids)} PreparatoryNote nodes...")
    for i, node_id in enumerate(node_ids):
        if dry_run:
            if i < 5:
                print(f"  [dry-run] is_private=true: node:{node_id}")
            elif i == 5:
                print(f"  [dry-run] ... and {len(node_ids) - 5} more")
            continue
        await write_privacy_attribute(node_id=node_id, is_private=True)
        if (i + 1) % BATCH_SIZE == 0:
            print(f"  [{i + 1}/{len(node_ids)}] privacy attributes written")


async def main(dry_run: bool) -> None:
    if not dry_run and not _configured():
        print("ERROR: PERMIFY_API_URL not set. Run with --dry-run to preview, or set env vars.")
        sys.exit(1)

    driver = get_neo4j_driver()
    try:
        print("[bootstrap] Querying Neo4j for composition edges...")
        edges = fetch_composition_edges(driver)
        print(f"[bootstrap] Found {len(edges)} composition edges.")

        print("[bootstrap] Querying Neo4j for PreparatoryNote nodes...")
        note_ids = fetch_preparatory_notes(driver)
        print(f"[bootstrap] Found {len(note_ids)} PreparatoryNote nodes.")
    finally:
        driver.close()

    await bootstrap_parent_tuples(edges, dry_run)
    await bootstrap_privacy_attributes(note_ids, dry_run)

    if dry_run:
        print("\n[bootstrap] Dry-run complete — no writes made.")
    else:
        print(f"\n[bootstrap] Done. {len(edges)} parent tuples + {len(note_ids)} privacy attributes written.")
        print("[bootstrap] Verify with: permify relationships read --entity-type node --relation parent")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Bootstrap Permify parent tuples for CortexDrive.")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing to Permify.")
    args = parser.parse_args()
    asyncio.run(main(dry_run=args.dry_run))
