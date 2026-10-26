"""
Move the founder's career graph to the PUBLIC tier (S2-44; documents/architecture/visibility-tiers-design-2026-10-23.md §4).

    .venv/bin/python scripts/migrate_career_graph_public.py                 # dry run (default): report only
    .venv/bin/python scripts/migrate_career_graph_public.py --apply --approved logs/career_public_dryrun_<ts>.json
    .venv/bin/python scripts/migrate_career_graph_public.py --rollback logs/career_public_backup_<ts>.json

Boundary: the founder's Person node + nodes reached via CAREER_PUBLIC_FROM_PERSON_RELATIONSHIPS, + one more hop via
CAREER_PUBLIC_DETAIL_RELATIONSHIPS; never CAREER_PUBLIC_EXCLUDED_LABELS (other people, notes, podcast/ingested content,
vocabulary). Only nodes in the founder's tenant, plus SYSTEM section Categories, are candidates.
--apply moves exactly the node_ids in the approved dry-run file (re-checked against the live graph) and writes a
backup of every previous tenant_id/owner_id first. Permify is not touched (PUBLIC bypasses the allowlist).
"""
import argparse
import datetime as dt
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))
from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(ROOT, ".env"))
from neo4j import GraphDatabase  # noqa: E402
from schema_guard import (  # noqa: E402
    CAREER_PUBLIC_FROM_PERSON_RELATIONSHIPS, CAREER_PUBLIC_DETAIL_RELATIONSHIPS, CAREER_PUBLIC_EXCLUDED_LABELS,
)

FOUNDER_NAME = os.environ.get("FOUNDER_PERSON_NAME", "Sangeetha Ramadurai")
PUBLIC, SYSTEM = "PUBLIC", "SYSTEM"
LOG_DIR = os.path.join(ROOT, "logs")

CANDIDATES = """
MATCH (p:Person {name: $founder}) WHERE p.tenant_id IN [$tenant, $public]
OPTIONAL MATCH (p)-[r1]-(h1) WHERE type(r1) IN $rels1 AND NOT any(l IN labels(h1) WHERE l IN $excluded)
OPTIONAL MATCH (h1)-[r2]-(h2) WHERE type(r2) IN $rels2 AND h2 <> p AND NOT any(l IN labels(h2) WHERE l IN $excluded)
WITH p, collect(DISTINCT h1) + collect(DISTINCT h2) AS found
UNWIND [p] + found AS n
WITH DISTINCT n WHERE n IS NOT NULL AND n.node_id IS NOT NULL
  AND (n.tenant_id = $tenant OR (n.tenant_id = $system AND 'Category' IN labels(n)) OR n.tenant_id = $public)
RETURN n.node_id AS node_id, labels(n) AS labels, n.name AS name, n.tenant_id AS tenant_id, n.owner_id AS owner_id
ORDER BY labels(n)[0], n.name
"""
EXCLUDED_NEIGHBOURS = """
MATCH (p:Person {name: $founder})-[r1]-(h1) WHERE p.tenant_id IN [$tenant, $public] AND type(r1) IN $rels1
MATCH (h1)-[r]-(x) WHERE x <> p AND any(l IN labels(x) WHERE l IN ['PreparatoryNote','ExternalSilo','PageMetadata','Person'])
RETURN labels(x)[0] AS label, count(DISTINCT x) AS c ORDER BY c DESC
"""


def driver():
    return GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"]))


def founder_tenant():
    t = os.environ.get("FOUNDER_TENANT_ID") or os.environ.get("TENANT_ID")
    if not t or not t.startswith("org_"):
        sys.exit("FOUNDER_TENANT_ID / TENANT_ID must be the founder's org id")
    return t


def candidates(d, tenant):
    recs, _, _ = d.execute_query(CANDIDATES, founder=FOUNDER_NAME, tenant=tenant, rels1=CAREER_PUBLIC_FROM_PERSON_RELATIONSHIPS,
                                 rels2=CAREER_PUBLIC_DETAIL_RELATIONSHIPS, excluded=CAREER_PUBLIC_EXCLUDED_LABELS,
                                 system=SYSTEM, public=PUBLIC)
    return [dict(r) for r in recs]


def stamp():
    return dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%SZ")


def dry_run(d, tenant):
    rows = candidates(d, tenant)
    if not rows:
        sys.exit(f"Founder Person '{FOUNDER_NAME}' not found in tenant {tenant}")
    to_move = [r for r in rows if r["tenant_id"] != PUBLIC]
    already = [r for r in rows if r["tenant_id"] == PUBLIC]
    excl, _, _ = d.execute_query(EXCLUDED_NEIGHBOURS, founder=FOUNDER_NAME, tenant=tenant, public=PUBLIC, rels1=CAREER_PUBLIC_FROM_PERSON_RELATIONSHIPS)
    os.makedirs(LOG_DIR, exist_ok=True)
    path = os.path.join(LOG_DIR, f"career_public_dryrun_{stamp()}.json")
    json.dump({"tenant": tenant, "founder": FOUNDER_NAME, "to_move": to_move, "already_public": already}, open(path, "w"), indent=2)
    print(f"DRY RUN — nothing changed. {len(to_move)} node(s) would move to PUBLIC; {len(already)} already PUBLIC.")
    for r in to_move:
        frm = "own org" if r["tenant_id"] == tenant else r["tenant_id"]
        print(f"  {r['labels'][0]:22} {frm:8} {r['name']}")
    print("Not moved (excluded neighbours of career nodes): " + ", ".join(f"{x['label']} {x['c']}" for x in excl))
    print(f"Report: {path}")


def apply(d, tenant, approved_path):
    approved = json.load(open(approved_path))
    if approved.get("tenant") != tenant:
        sys.exit("approved file is for a different tenant")
    approved_ids = {r["node_id"] for r in approved["to_move"]}
    live = {r["node_id"]: r for r in candidates(d, tenant) if r["tenant_id"] != PUBLIC}
    missing = approved_ids - set(live)
    if missing:
        sys.exit(f"{len(missing)} approved node(s) are no longer candidates; re-run the dry run. Nothing changed.")
    backup = [{"node_id": i, "tenant_id": live[i]["tenant_id"], "owner_id": live[i]["owner_id"]} for i in sorted(approved_ids)]
    path = os.path.join(LOG_DIR, f"career_public_backup_{stamp()}.json")
    json.dump({"tenant": tenant, "nodes": backup}, open(path, "w"), indent=2)
    d.execute_query("MATCH (n) WHERE n.node_id IN $ids SET n.tenant_id = $public RETURN count(n) AS c",
                                    ids=sorted(approved_ids), public=PUBLIC)
    recs, _, _ = d.execute_query("MATCH (n) WHERE n.node_id IN $ids AND n.tenant_id = $public RETURN count(n) AS c",
                                 ids=sorted(approved_ids), public=PUBLIC)
    print(f"Moved {recs[0]['c']}/{len(approved_ids)} node(s) to PUBLIC. Backup: {path}")


def promote_founder_career_graph(d, tenant):
    """Seeder hook: move every current candidate to PUBLIC (policy approved 2026-10-26: the founder's career
    graph is PUBLIC). Writes the same backup as --apply and prints what moved."""
    rows = [r for r in candidates(d, tenant) if r["tenant_id"] != PUBLIC]
    if not rows:
        print("  -> career graph: nothing new to promote to PUBLIC")
        return
    os.makedirs(LOG_DIR, exist_ok=True)
    path = os.path.join(LOG_DIR, f"career_public_backup_{stamp()}.json")
    json.dump({"tenant": tenant, "nodes": [{"node_id": r["node_id"], "tenant_id": r["tenant_id"], "owner_id": r["owner_id"]} for r in rows]},
              open(path, "w"), indent=2)
    d.execute_query("MATCH (n) WHERE n.node_id IN $ids SET n.tenant_id = $public", ids=[r["node_id"] for r in rows], public=PUBLIC)
    print(f"  -> career graph: promoted {len(rows)} node(s) to PUBLIC (backup {path}):")
    for r in rows:
        print(f"       {r['labels'][0]:22} {r['name']}")


def rollback(d, backup_path):
    data = json.load(open(backup_path))
    for row in data["nodes"]:
        d.execute_query("MATCH (n {node_id: $id}) SET n.tenant_id = $tenant, n.owner_id = $owner",
                        id=row["node_id"], tenant=row["tenant_id"], owner=row["owner_id"])
    print(f"Restored {len(data['nodes'])} node(s) from {backup_path}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--apply", action="store_true")
    g.add_argument("--rollback", metavar="BACKUP_JSON")
    ap.add_argument("--approved", metavar="DRYRUN_JSON")
    a = ap.parse_args()
    with driver() as d:
        if a.rollback:
            rollback(d, a.rollback)
        elif a.apply:
            if not a.approved:
                sys.exit("--apply needs --approved <dry-run json> (the list the founder approved)")
            apply(d, founder_tenant(), a.approved)
        else:
            dry_run(d, founder_tenant())
