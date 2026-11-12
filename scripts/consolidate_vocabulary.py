#!/usr/bin/env python3
"""
Vocabulary consolidation (cross-domain discovery design 2026-11-09 §5.0, part A): merge duplicate SYSTEM vocabulary
nodes ("Graph Databases" / "Graph Database" / "Graph database") into one survivor per concept. One-off exception to
Invariant 9 (writes SYSTEM vocabulary), run only with an approved plan.

    .venv/bin/python scripts/consolidate_vocabulary.py                    # dry run: writes the plan (JSON + Markdown)
    .venv/bin/python scripts/consolidate_vocabulary.py --apply --approved logs/vocab_consolidation_plan_<ts>.json
    .venv/bin/python scripts/consolidate_vocabulary.py --rollback logs/vocab_consolidation_backup_<ts>.json

Review: the Markdown file lists every group (survivor, duplicates, links to move, mixed labels). To change a survivor or
skip a group, edit the JSON plan (set "skip": true on a group, or swap a duplicate into "survivor") before approving.
--apply re-checks every node against the live graph, writes a backup first, then merges group by group: each duplicate's
relationships are re-created on the survivor (same type, direction, properties; no self-loops; no duplicate of an
identical existing link), the survivor keeps its properties and takes a missing description/embedding, all spellings go
to `aliases`, `name_key` is set, and the duplicate is deleted. Organization nodes are never merged (Phase 2 links them).
--tier (default SYSTEM) exists for tests on the test tenant only.
"""
import argparse
import datetime as dt
import json
import os
import sys

from dotenv import load_dotenv
from neo4j import GraphDatabase

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(ROOT, ".env"))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))
from domain_registry import VOCABULARY_CONSOLIDATION_LABELS, VOCABULARY_SURVIVOR_LABEL_ORDER  # noqa: E402
from schema_guard import SIMILARITY_RELATIONSHIPS  # noqa: E402
from vocabulary_keys import group_keys  # noqa: E402

LOG_DIR = os.path.join(ROOT, "logs")
COPY_IF_MISSING = ["description", "embedding", "metadata_embedding"]
ALLOWED_TIERS = {"SYSTEM"}
TEST_TIER_PREFIX = "cortex-test-"


def driver():
    return GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"]))


def _check_tier(tier: str):
    if tier not in ALLOWED_TIERS and not tier.startswith(TEST_TIER_PREFIX):
        raise SystemExit(f"refusing tier {tier!r}: SYSTEM or a test tenant only (organization nodes are never merged)")


def _survivor_order(n: dict):
    label_rank = next((i for i, l in enumerate(VOCABULARY_SURVIVOR_LABEL_ORDER) if l in n["labels"]), 99)
    title_case = sum(w[:1].isupper() for w in n["name"].split())
    return (-n["degree"], label_rank, -title_case, -len(n["name"]), n["name"])


def plan(tier: str) -> dict:
    _check_tier(tier)
    with driver() as d:
        rows = d.execute_query(
            """MATCH (n) WHERE n.tenant_id = $tier AND n.name IS NOT NULL AND any(l IN labels(n) WHERE l IN $labels)
               RETURN elementId(n) AS eid, n.node_id AS node_id, n.name AS name, labels(n) AS labels,
                      COUNT { (n)-[r]-() WHERE NOT type(r) IN $sim } AS degree,
                      COUNT { (n)-[]-() } AS all_links""",
            tier=tier, labels=VOCABULARY_CONSOLIDATION_LABELS, sim=SIMILARITY_RELATIONSHIPS).data()
    keys = group_keys([r["name"] for r in rows])
    groups = {}
    for r in rows:
        groups.setdefault(keys[r["name"]], []).append(r)
    out = []
    for key, members in sorted(groups.items()):
        if len(members) < 2:
            continue
        members.sort(key=_survivor_order)
        survivor, dups = members[0], members[1:]
        labels = {next((l for l in m["labels"] if l in VOCABULARY_CONSOLIDATION_LABELS), "?") for m in members}
        out.append({
            "key": key, "skip": False, "mixed_labels": len(labels) > 1, "labels": sorted(labels),
            "survivor": {k: survivor[k] for k in ("eid", "node_id", "name", "labels", "degree")},
            "duplicates": [{k: m[k] for k in ("eid", "node_id", "name", "labels", "degree", "all_links")} for m in dups],
            "links_to_move": sum(m["all_links"] for m in dups),
        })
    return {"created_at": dt.datetime.now(dt.timezone.utc).isoformat(), "tier": tier, "vocabulary_nodes": len(rows),
            "groups": out}


def markdown(p: dict) -> str:
    lines = [f"# Vocabulary consolidation plan ({p['tier']}, {p['created_at'][:16]})", "",
             f"{len(p['groups'])} groups from {p['vocabulary_nodes']} vocabulary nodes. Survivor = most stated links "
             "(ties: Technology, Concept, Tool, Topic; then title case). ⚠ = members with different labels.", "",
             "| # | Key | Survivor (label, stated links) | Merged into it | Links moved |", "|---|---|---|---|---|"]
    for i, g in enumerate(p["groups"], 1):
        s = g["survivor"]
        dups = "; ".join(f"{d['name']} ({d['labels'][0]}, {d['degree']})" for d in g["duplicates"])
        lines.append(f"| {i} | {'⚠ ' if g['mixed_labels'] else ''}{g['key']} | {s['name']} ({s['labels'][0]}, {s['degree']}) | "
                     f"{dups} | {g['links_to_move']} |")
    return "\n".join(lines) + "\n"


def apply(plan_path: str):
    p = json.load(open(plan_path))
    _check_tier(p["tier"])
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = {"plan": plan_path, "tier": p["tier"], "groups": []}
    with driver() as d, d.session() as s:
        todo = [g for g in p["groups"] if not g.get("skip")]
        # Re-check and back up everything first.
        for g in todo:
            ids = [g["survivor"]["eid"]] + [x["eid"] for x in g["duplicates"]]
            live = s.run("MATCH (n) WHERE elementId(n) IN $ids AND n.tenant_id = $tier RETURN elementId(n) AS eid",
                         ids=ids, tier=p["tier"]).data()
            if len(live) != len(ids):
                raise SystemExit(f"plan out of date for group {g['key']!r}: {len(live)}/{len(ids)} nodes found")
            sv = s.run("MATCH (n) WHERE elementId(n) = $e RETURN properties(n) AS props", e=g["survivor"]["eid"]).single()
            dups = []
            for x in g["duplicates"]:
                node = s.run("MATCH (n) WHERE elementId(n) = $e RETURN labels(n) AS labels, properties(n) AS props",
                             e=x["eid"]).single()
                rels = s.run("MATCH (n)-[r]-(m) WHERE elementId(n) = $e RETURN type(r) AS type, startNode(r) = n AS out, "
                             "elementId(m) AS other, m.node_id AS other_id, properties(r) AS props", e=x["eid"]).data()
                dups.append({"labels": node["labels"], "props": node["props"], "relationships": rels})
            backup["groups"].append({"key": g["key"], "survivor_eid": g["survivor"]["eid"],
                                     "survivor_props_before": sv["props"], "duplicates": dups, "created_links": []})
        os.makedirs(LOG_DIR, exist_ok=True)
        path = os.path.join(LOG_DIR, f"vocab_consolidation_backup_{stamp}.json")
        json.dump(backup, open(path, "w"), indent=1, default=str)
        print(f"backup written: {path}")

        for g, b in zip(todo, backup["groups"]):
            sv_eid = g["survivor"]["eid"]
            names = [g["survivor"]["name"]] + [x["name"] for x in g["duplicates"]]
            for x, dup in zip(g["duplicates"], b["duplicates"]):
                for r in dup["relationships"]:
                    if r["other"] == sv_eid or r["other"] in {y["eid"] for y in g["duplicates"]}:
                        continue   # would become a self-loop on the survivor
                    start, end = (sv_eid, r["other"]) if r["out"] else (r["other"], sv_eid)
                    existing = s.run("MATCH (a)-[e]->(z) WHERE elementId(a) = $a AND elementId(z) = $z AND type(e) = $type "
                                     "RETURN count(e) AS c", a=start, z=end, type=r["type"]).single()["c"]
                    if existing:
                        continue   # the survivor already has this link
                    rec = s.run("MATCH (a), (z) WHERE elementId(a) = $a AND elementId(z) = $z "
                                "CALL apoc.create.relationship(a, $type, $props, z) YIELD rel RETURN elementId(rel) AS id",
                                a=start, z=end, type=r["type"], props=r["props"] or {}).single()
                    if rec:
                        b["created_links"].append(rec["id"])
                s.run("MATCH (n) WHERE elementId(n) = $e AND n.tenant_id = $tier DETACH DELETE n", e=x["eid"], tier=p["tier"])
            props = {k: v for dup in b["duplicates"] for k, v in dup["props"].items() if k in COPY_IF_MISSING}
            s.run("""MATCH (n) WHERE elementId(n) = $e
                     SET n.aliases = [x IN apoc.coll.toSet(coalesce(n.aliases, []) + $names) WHERE x <> n.name],
                         n.name_key = $key
                     WITH n UNWIND keys($props) AS k
                     WITH n, k WHERE n[k] IS NULL
                     CALL apoc.create.setProperty(n, k, $props[k]) YIELD node RETURN count(*)""",
                  e=sv_eid, names=names, key=g["key"], props=props)
        json.dump(backup, open(path, "w"), indent=1, default=str)   # with the created links, for rollback
    print(f"merged {len(todo)} groups; {sum(len(g['duplicates']) for g in todo)} duplicates removed; "
          f"{sum(len(b['created_links']) for b in backup['groups'])} links re-created on survivors. Backup: {path}")


def rollback(backup_path: str):
    b = json.load(open(backup_path))
    _check_tier(b["tier"])
    with driver() as d, d.session() as s:
        for g in b["groups"]:
            for rid in g["created_links"]:
                s.run("MATCH ()-[r]->() WHERE elementId(r) = $id DELETE r", id=rid)
            for dup in g["duplicates"]:
                rec = s.run(f"CREATE (x:{':'.join(dup['labels'])}) SET x = $props RETURN elementId(x) AS eid",
                            props=dup["props"]).single()
                for r in dup["relationships"]:
                    a, z = (rec["eid"], r["other"]) if r["out"] else (r["other"], rec["eid"])
                    s.run("MATCH (a), (z) WHERE elementId(a) = $a AND elementId(z) = $z "
                          "CALL apoc.create.relationship(a, $type, $props, z) YIELD rel RETURN count(*)",
                          a=a, z=z, type=r["type"], props=r["props"] or {})
            s.run("MATCH (n) WHERE elementId(n) = $e SET n = $props", e=g["survivor_eid"], props=g["survivor_props_before"])
    print("rolled back")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="SYSTEM")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--approved")
    ap.add_argument("--rollback")
    a = ap.parse_args()
    if a.rollback:
        return rollback(a.rollback)
    if a.apply:
        if not a.approved:
            raise SystemExit("--apply needs --approved <plan file from a dry run>")
        return apply(a.approved)
    p = plan(a.tier)
    os.makedirs(LOG_DIR, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    jpath = os.path.join(LOG_DIR, f"vocab_consolidation_plan_{stamp}.json")
    mpath = jpath.replace(".json", ".md")
    json.dump(p, open(jpath, "w"), indent=1)
    open(mpath, "w").write(markdown(p))
    print(f"DRY RUN — nothing changed. {len(p['groups'])} groups.\nPlan: {jpath}\nReview: {mpath}")


if __name__ == "__main__":
    main()
