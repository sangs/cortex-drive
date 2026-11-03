"""
Add a missing career label to specific nodes, by node_id (data fix, 2026-11-03).

    .venv/bin/python scripts/add_career_label.py --node-id <uuid> --label ThoughtLeadership            # dry run
    .venv/bin/python scripts/add_career_label.py --node-id <uuid> --label ThoughtLeadership --apply
    .venv/bin/python scripts/add_career_label.py --node-id <uuid> --label ThoughtLeadership --remove   # rollback

Why: a career item stored with only a label shared with another domain (e.g. `Publication`, which is in
the podcast manifest too) is classified as that other domain by AP-29 / bridge discovery. Adding the
career-exclusive label fixes the classification.

Guards: the label must be exclusive to the career domain (domain_registry.get_exclusive_labels), so this
can't be used to move a node into another domain; matching is by node_id only (never by name, AP-14);
only PUBLIC nodes or the founder's tenant are touched; dry run is the default. Nothing else on the node
changes (tenant, owner, properties, relationships).
After --apply: the routing catalog changes (ThoughtLeadership is a ROUTING_NAME_LABELS career label), so
redeploy the gateway (its pre-deploy step regenerates the catalog) or INCR entcat_version:PUBLIC (AP-30).
"""
import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))
from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(ROOT, ".env"))
from neo4j import GraphDatabase  # noqa: E402
from domain_registry import get_exclusive_labels  # noqa: E402

CAREER_DOMAIN = "professional"
PUBLIC = "PUBLIC"
LABEL_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--node-id", required=True, action="append", help="node_id (repeatable)")
    ap.add_argument("--label", required=True)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--remove", action="store_true")
    args = ap.parse_args()

    allowed = set(get_exclusive_labels(CAREER_DOMAIN))
    if args.label not in allowed or not LABEL_RE.match(args.label):
        sys.exit(f"--label must be one of the career-exclusive labels: {sorted(allowed)}")
    tenants = [PUBLIC] + [t for t in [os.environ.get("FOUNDER_TENANT_ID") or os.environ.get("TENANT_ID")] if t]

    drv = GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"]))
    try:
        with drv.session() as s:
            rows = s.run("MATCH (n) WHERE n.node_id IN $ids RETURN n.node_id AS id, n.name AS name, "
                         "labels(n) AS labels, n.tenant_id AS tenant", ids=args.node_id).data()
            found = {r["id"] for r in rows}
            missing = [i for i in args.node_id if i not in found]
            if missing:
                sys.exit(f"node_id not found: {missing}")
            for r in rows:
                if r["tenant"] not in tenants:
                    sys.exit(f"refusing: {r['name']!r} is in tenant {r['tenant']!r} (allowed: {tenants})")
                print(f"{r['name']!r} [{r['tenant']}] labels={r['labels']}")
            if not (args.apply or args.remove):
                print(f"dry run: would {'add'} :{args.label} to {len(rows)} node(s). Re-run with --apply.")
                return
            verb = "SET" if args.apply else "REMOVE"
            out = s.run(f"MATCH (n) WHERE n.node_id IN $ids AND n.tenant_id IN $tenants {verb} n:{args.label} "
                        "RETURN n.name AS name, labels(n) AS labels", ids=args.node_id, tenants=tenants).data()
            for r in out:
                print(f"{verb.lower()} done: {r['name']!r} labels={r['labels']}")
    finally:
        drv.close()


if __name__ == "__main__":
    main()
