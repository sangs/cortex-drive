#!/usr/bin/env python3
"""
Vocabulary review 2026-11-10: correct how Cortex-Drive and the InfoQ article are tagged (daily log 2026-11-10;
cross-domain discovery design 2026-11-09). Brings the live graph in line with the edited seed_resume_graph.py
§3b / §9 / §16. One-off exception to Invariant 9 (approved by the user): it creates SYSTEM Concepts and deletes
SYSTEM Technology nodes left with no stated links — exact, named nodes and links only.

Rule: a Technology is a concrete product/library/language/service a project USES_TOOL; a practice, theme, method
or category is a Concept that a project or article DISCUSSES.

    .venv/bin/python scripts/migrate_career_vocabulary.py                       # dry run (default): writes the plan
    .venv/bin/python scripts/migrate_career_vocabulary.py --include-credential  # dry run incl. the InfoQ credential
    .venv/bin/python scripts/migrate_career_vocabulary.py --apply --approved logs/career_vocab_plan_<ts>.json
    .venv/bin/python scripts/migrate_career_vocabulary.py --rollback logs/career_vocab_backup_<ts>.json

--apply re-checks every planned item against the live graph, writes a backup of everything it will remove first,
then applies the plan in one transaction. Nothing outside the plan is touched. Permify is not touched.
"""
import argparse
import datetime as dt
import json
import os
import sys
import uuid

from dotenv import load_dotenv
from neo4j import GraphDatabase

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(ROOT, ".env"))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))
from schema_guard import SIMILARITY_RELATIONSHIPS  # noqa: E402

LOG_DIR = os.path.join(ROOT, "logs")
SYSTEM = "SYSTEM"
SYSTEM_OWNER = "user_SYSTEM_ADMIN"
COPY_PROPERTIES = ["description", "embedding", "metadata_embedding"]   # keep semantic search working on the Concept

# The approved change, by exact node name (vocabulary review 2026-11-10).
CHANGES = [
    {
        "node": "Cortex-Drive", "labels": ["Project", "Startup"],
        "remove_uses_tool": ["LangGraph", "Langflow", "FastAPI", "Supabase", "Railway", "Google Antigravity",
                             "Claude Code", "AI", "Software architecture", "AI Agent", "AI Architecture",
                             "Explainability", "Governance"],
        "add_discusses": ["AI Agent", "Explainability", "Governance"],   # AI Architecture is already discussed
    },
    {
        "node": "InfoQ: Architectural Shifts for Platform Engineers in the Age of AI", "labels": ["ThoughtLeadership"],
        "remove_uses_tool": ["Software architecture", "AI", "C4 Model", "Explainability", "Governance"],
        "add_discusses": ["Software Architecture", "AI", "C4 Model", "Explainability", "Governance",
                          "Platform Engineering"],
    },
]
# Optional (--include-credential): the certification awarded for the article; its topics stay reachable through
# AWARDED_FOR → article → concepts.
CREDENTIAL = {
    "node": "[2026] InfoQ Certified Architect", "labels": ["Certification"],
    "remove_uses_tool": ["Software architecture", "AI", "Platform Engineering", "Governance", "Explainability"],
    "add_discusses": [],
}
# Empty duplicates found in the review.
DELETE_IF_UNLINKED = [{"name": "AI Agent", "label": "Tool"}]


def driver():
    return GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"]))


def _one(session, name, labels):
    rows = session.run("MATCH (n) WHERE coalesce(n.name, n.title) = $name AND any(l IN labels(n) WHERE l IN $labels) "
                       "RETURN n.node_id AS id, labels(n) AS labels, n.tenant_id AS tenant", name=name, labels=labels).data()
    if len(rows) != 1:
        raise SystemExit(f"expected exactly one node {name!r} {labels}, found {len(rows)}")
    return rows[0]


def plan(include_credential: bool) -> dict:
    changes = CHANGES + ([CREDENTIAL] if include_credential else [])
    out = {"created_at": dt.datetime.now(dt.timezone.utc).isoformat(), "include_credential": include_credential,
           "remove_links": [], "create_concepts": [], "add_links": [], "delete_nodes": []}
    with driver() as d, d.session() as s:
        technologies_touched = set()
        for c in changes:
            node = _one(s, c["node"], c["labels"])
            for tech in c["remove_uses_tool"]:
                rows = s.run("MATCH (n {node_id: $id})-[r:USES_TOOL]->(t:Technology {name: $tech}) "
                             "RETURN elementId(r) AS rel, t.node_id AS tid, t.tenant_id AS tenant",
                             id=node["id"], tech=tech).data()
                for r in rows:
                    out["remove_links"].append({"from": c["node"], "from_id": node["id"], "type": "USES_TOOL",
                                                "to": tech, "to_id": r["tid"], "to_tenant": r["tenant"]})
                    technologies_touched.add((tech, r["tid"]))
            for concept in c["add_discusses"]:
                existing = s.run("MATCH (k:Concept) WHERE toLower(k.name) = toLower($n) AND k.tenant_id = $sys "
                                 "RETURN k.node_id AS id, k.name AS name", n=concept, sys=SYSTEM).data()
                if existing:
                    cid = existing[0]["id"]
                else:
                    cid = next((x["node_id"] for x in out["create_concepts"] if x["name"].lower() == concept.lower()), None)
                    if not cid:
                        src = s.run("MATCH (t:Technology) WHERE toLower(t.name) = toLower($n) AND t.tenant_id = $sys "
                                    "RETURN t.node_id AS id, [k IN $props WHERE t[k] IS NOT NULL] AS props",
                                    n=concept, sys=SYSTEM, props=COPY_PROPERTIES).data()
                        cid = str(uuid.uuid4())
                        out["create_concepts"].append({"name": concept, "node_id": cid, "tenant_id": SYSTEM,
                                                       "copy_from": src[0]["id"] if src else None,
                                                       "copied": src[0]["props"] if src else []})
                already = s.run("MATCH (n {node_id: $id})-[:DISCUSSES]->(k {node_id: $cid}) RETURN count(*) AS c",
                                id=node["id"], cid=cid).single()["c"]
                if not already:
                    out["add_links"].append({"from": c["node"], "from_id": node["id"], "type": "DISCUSSES",
                                             "to": concept, "to_id": cid})
        # Technology nodes left with no stated (non-similarity) link after the removals are deleted.
        removed = {(x["from_id"], x["to_id"]) for x in out["remove_links"]}
        for tech, tid in sorted(technologies_touched):
            links = s.run(
                "MATCH (t {node_id: $tid})-[r]-(m) WHERE NOT type(r) IN $sim "
                "RETURN m.node_id AS mid, type(r) AS type", tid=tid, sim=SIMILARITY_RELATIONSHIPS).data()
            remaining = [x for x in links if not (x["type"] == "USES_TOOL" and (x["mid"], tid) in removed)]
            if not remaining:
                sim = s.run("MATCH (t {node_id: $tid})-[r]-() WHERE type(r) IN $sim RETURN count(r) AS c",
                            tid=tid, sim=SIMILARITY_RELATIONSHIPS).single()["c"]
                out["delete_nodes"].append({"name": tech, "node_id": tid, "label": "Technology",
                                            "similarity_links_removed_with_it": sim})
        for dup in DELETE_IF_UNLINKED:
            rows = s.run(f"MATCH (n:{dup['label']} {{name: $n, tenant_id: $sys}}) WHERE NOT (n)--() "
                         "RETURN n.node_id AS id", n=dup["name"], sys=SYSTEM).data()
            for r in rows:
                out["delete_nodes"].append({"name": dup["name"], "node_id": r["id"], "label": dup["label"],
                                            "similarity_links_removed_with_it": 0})
    return out


def apply(plan_path: str):
    p = json.load(open(plan_path))
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = {"plan": plan_path, "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
              "removed_links": [], "deleted_nodes": [], "created_concepts": [c["node_id"] for c in p["create_concepts"]],
              "added_links": [{"from_id": a["from_id"], "to_id": a["to_id"]} for a in p["add_links"]]}
    with driver() as d, d.session() as s:
        # Re-check and back up everything that will be removed.
        for r in p["remove_links"]:
            rows = s.run("MATCH (a {node_id: $f})-[r:USES_TOOL]->(b {node_id: $t}) RETURN properties(r) AS props",
                         f=r["from_id"], t=r["to_id"]).data()
            if len(rows) != 1:
                raise SystemExit(f"plan out of date: link {r['from']} -USES_TOOL-> {r['to']} found {len(rows)} times")
            backup["removed_links"].append({**r, "props": rows[0]["props"]})
        for n in p["delete_nodes"]:
            node = s.run("MATCH (n {node_id: $id}) RETURN labels(n) AS labels, properties(n) AS props",
                         id=n["node_id"]).data()
            if len(node) != 1:
                raise SystemExit(f"plan out of date: node {n['name']} not found once")
            rels = s.run("MATCH (n {node_id: $id})-[r]-(m) RETURN type(r) AS type, startNode(r) = n AS out, "
                         "m.node_id AS other, properties(r) AS props", id=n["node_id"]).data()
            backup["deleted_nodes"].append({"labels": node[0]["labels"], "props": node[0]["props"], "relationships": rels})
        os.makedirs(LOG_DIR, exist_ok=True)
        backup_path = os.path.join(LOG_DIR, f"career_vocab_backup_{stamp}.json")
        json.dump(backup, open(backup_path, "w"), indent=1, default=str)
        print(f"backup written: {backup_path}")

        def tx(t):
            for c in p["create_concepts"]:
                t.run("CREATE (k:Concept {name: $name, node_id: $id, tenant_id: $sys, owner_id: $owner, type: 'Concept'})",
                      name=c["name"], id=c["node_id"], sys=SYSTEM, owner=SYSTEM_OWNER)
                if c["copy_from"]:
                    t.run("MATCH (src {node_id: $src}), (k {node_id: $id}) "
                          "FOREACH (key IN $props | SET k[key] = src[key])",
                          src=c["copy_from"], id=c["node_id"], props=c["copied"])
            for a in p["add_links"]:
                t.run("MATCH (a {node_id: $f}), (k:Concept {node_id: $t}) MERGE (a)-[:DISCUSSES]->(k)",
                      f=a["from_id"], t=a["to_id"])
            for r in p["remove_links"]:
                t.run("MATCH (a {node_id: $f})-[r:USES_TOOL]->(b {node_id: $t}) DELETE r", f=r["from_id"], t=r["to_id"])
            for n in p["delete_nodes"]:
                t.run("MATCH (n {node_id: $id}) WHERE n.tenant_id = $sys DETACH DELETE n", id=n["node_id"], sys=SYSTEM)
        s.execute_write(tx)
    print(f"applied: {len(p['create_concepts'])} concepts created, {len(p['add_links'])} links added, "
          f"{len(p['remove_links'])} links removed, {len(p['delete_nodes'])} nodes deleted")


def rollback(backup_path: str):
    b = json.load(open(backup_path))

    def tx(t):
        for n in b["deleted_nodes"]:
            labels = ":".join(n["labels"])
            t.run(f"CREATE (x:{labels}) SET x = $props", props=n["props"])
        for n in b["deleted_nodes"]:
            for r in n["relationships"]:
                a, z = (n["props"]["node_id"], r["other"]) if r["out"] else (r["other"], n["props"]["node_id"])
                t.run(f"MATCH (a {{node_id: $a}}), (z {{node_id: $z}}) CREATE (a)-[r:{r['type']}]->(z) SET r = $props",
                      a=a, z=z, props=r["props"])
        for r in b["removed_links"]:
            t.run("MATCH (a {node_id: $f}), (z {node_id: $t}) CREATE (a)-[r:USES_TOOL]->(z) SET r = $props",
                  f=r["from_id"], t=r["to_id"], props=r["props"])
        for a in b["added_links"]:
            t.run("MATCH (a {node_id: $f})-[r:DISCUSSES]->(z {node_id: $t}) DELETE r", f=a["from_id"], t=a["to_id"])
        for cid in b["created_concepts"]:
            t.run("MATCH (k:Concept {node_id: $id}) WHERE NOT (k)--() DELETE k", id=cid)
    with driver() as d, d.session() as s:
        s.execute_write(tx)
    print("rolled back")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--include-credential", action="store_true")
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
    p = plan(a.include_credential)
    os.makedirs(LOG_DIR, exist_ok=True)
    path = os.path.join(LOG_DIR, f"career_vocab_plan_{dt.datetime.now().strftime('%Y%m%d-%H%M%S')}"
                                 f"{'_with_credential' if a.include_credential else ''}.json")
    json.dump(p, open(path, "w"), indent=1)
    print(f"DRY RUN — nothing changed. Plan: {path}")
    for k in ("remove_links", "create_concepts", "add_links", "delete_nodes"):
        print(f"\n{k} ({len(p[k])}):")
        for x in p[k]:
            if k == "remove_links":
                print(f"  - {x['from']}  -[USES_TOOL]->  {x['to']} ({x['to_tenant']})")
            elif k == "add_links":
                print(f"  + {x['from']}  -[DISCUSSES]->  {x['to']} (Concept)")
            elif k == "create_concepts":
                print(f"  + Concept {x['name']!r} SYSTEM" + (f", copying {x['copied']} from the Technology" if x["copy_from"] else ""))
            else:
                print(f"  x {x['label']} {x['name']!r} (no stated links left; {x['similarity_links_removed_with_it']} similarity links go with it)")


if __name__ == "__main__":
    main()
