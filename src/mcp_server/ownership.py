"""Who owns which nodes, and moving that ownership when a person leaves (S2-50, 2026-11-20).

Design: documents/security/offboarding-and-retention-design-2026-11-20.md (§3 D2, §11). Called only by the gateway's
offboarding module (utils/offboarding.js) through Bento's internal routes /owner_ids, /owned_nodes, /transfer_owner.

`owner_id` on a node is who added it (stamped at ingestion since 2026-10-28; Permify `node#owner` holds the same fact).
A transfer rewrites `owner_id` to the receiving steward and records where the node came from on the node itself
(`transferred_from_sub`, `transferred_from_name`, `transferred_at`, `transfer_id`), so the steward's "Transferred from
<name>" group can be listed without adding any node or relationship: classification edges between content nodes turn
the target into a hub for bridge search (S2-94 finding, 2026-11-19). `tenant_id` is never changed (Invariant 9).
"""
from typing import Iterable

EVERYONE_TIERS = ['SYSTEM', 'PUBLIC']   # never owned by a person who can leave; never touched here


def owner_ids(driver) -> list:
    """Every distinct owner_id in the graph (the offboarding sweep's Neo4j candidates). Read-only.
    A full scan: fine at today's size; RV-39 tracks an index when a tenant passes 100k nodes."""
    records, _, _ = driver.execute_query(
        "MATCH (n) WHERE n.owner_id IS NOT NULL RETURN DISTINCT n.owner_id AS owner_id")
    return sorted(r["owner_id"] for r in records if r["owner_id"])


def owned_nodes(driver, owner_id: str, extra_node_ids: Iterable[str] = ()) -> list:
    """Nodes a person owns: owner_id = them, plus the given ids (nodes whose Permify owner is them). Read-only.
    Returns [{node_id, tenant_id}], SYSTEM/PUBLIC excluded."""
    if not owner_id:
        raise ValueError("owner_id required")
    records, _, _ = driver.execute_query(
        "MATCH (n) WHERE (n.owner_id = $owner OR n.node_id IN $extra) AND n.node_id IS NOT NULL "
        "AND NOT n.tenant_id IN $everyone "
        "RETURN n.node_id AS node_id, n.tenant_id AS tenant_id",
        owner=owner_id, extra=list(extra_node_ids or []), everyone=EVERYONE_TIERS)
    return [{"node_id": r["node_id"], "tenant_id": r["tenant_id"]} for r in records]


def transfer_owner(driver, from_sub: str, transfers: list) -> dict:
    """Move ownership, one organization at a time, in one transaction.

    transfers: [{tenant_id, to_sub, transfer_id, from_name, node_ids}]. node_ids are the nodes found by owned_nodes
    for that tenant (only those are touched, and only if still owned by from_sub or ownerless). Returns
    {tenant_id: [node_id, ...]} of the nodes changed. Idempotent: a node already moved is not matched again.
    """
    if not from_sub:
        raise ValueError("from_sub required")
    for t in transfers:
        if not t.get("tenant_id") or not t.get("to_sub") or t["to_sub"] == from_sub or t["tenant_id"] in EVERYONE_TIERS:
            raise ValueError(f"refusing transfer {t.get('tenant_id')!r} → {t.get('to_sub')!r}")

    def work(tx):
        changed = {}
        for t in transfers:
            rows = tx.run(
                "MATCH (n) WHERE n.node_id IN $ids AND n.tenant_id = $tenant "
                "AND (n.owner_id = $from OR n.owner_id IS NULL) "
                "SET n.owner_id = $to, n.transferred_from_sub = $from, n.transferred_from_name = $name, "
                "    n.transferred_at = datetime(), n.transfer_id = $tid "
                "RETURN n.node_id AS node_id",
                ids=list(t.get("node_ids") or []), tenant=t["tenant_id"], to=t["to_sub"],
                name=t.get("from_name") or "", tid=t.get("transfer_id") or "", **{"from": from_sub}).data()
            changed[t["tenant_id"]] = [r["node_id"] for r in rows]
        return changed

    with driver.session() as session:
        return session.execute_write(work)


# ---------------------------------------------------------------------------------------------------------------------
# Steward review of transferred content (S2-50 §3b, 2026-11-23): list a transfer's sources, keep them (provenance
# removed, content joins normal answers) or delete them. Only nodes still carrying this transfer_id and owned by the
# steward are ever touched; SYSTEM/PUBLIC never are (a transfer never includes them).
# ---------------------------------------------------------------------------------------------------------------------
TRANSFER_PROVENANCE_PROPS = ["transferred_from_sub", "transferred_from_name", "transferred_at", "transfer_id"]
# A deleted source's nodes stay if anything outside the deleted set still uses them; repeat until stable (bounded).
DELETE_KEEP_PASSES = 10


def _review_source_labels() -> list:
    """Labels of the sources a person adds (website, document): the units a steward keeps or deletes."""
    from domain_registry import ROUTING_NAME_LABELS, ROUTING_SOURCE_DOMAINS
    return sorted({l for d in ROUTING_SOURCE_DOMAINS for l in ROUTING_NAME_LABELS.get(d, [])})


def _check_review_args(steward: str, transfer_id: str, tenant_id: str):
    if not steward or not transfer_id or not tenant_id or tenant_id in EVERYONE_TIERS:
        raise ValueError("steward, transfer_id and an organization tenant are required")


def _transfer_graph(tx, steward: str, transfer_id: str, tenant_id: str):
    """The transfer's nodes and the links among them, and which nodes each source reaches (not through another
    source). Returns (nodes {id: {labels, name}}, sources [id], reach {source_id: set(node ids)})."""
    rows = tx.run(
        "MATCH (n) WHERE n.transfer_id = $tid AND n.owner_id = $steward AND n.tenant_id = $tenant "
        "RETURN n.node_id AS id, labels(n) AS labels, coalesce(n.name, n.title) AS name",
        tid=transfer_id, steward=steward, tenant=tenant_id).data()
    nodes = {r["id"]: {"labels": r["labels"], "name": r["name"]} for r in rows if r["id"]}
    edges = tx.run(
        "MATCH (a) WHERE a.node_id IN $ids MATCH (a)--(b) WHERE b.node_id IN $ids "
        "RETURN DISTINCT a.node_id AS a, b.node_id AS b", ids=list(nodes)).data()
    adj = {i: set() for i in nodes}
    for e in edges:
        if e["a"] != e["b"]:
            adj[e["a"]].add(e["b"])
    source_labels = set(_review_source_labels())
    sources = sorted(i for i, n in nodes.items() if source_labels & set(n["labels"]))
    reach = {}
    for s in sources:
        seen, todo = {s}, [s]
        while todo:
            for nxt in adj[todo.pop()]:
                if nxt not in seen and nxt not in sources:
                    seen.add(nxt)
                    todo.append(nxt)
        reach[s] = seen
    return nodes, sources, reach


def transfer_items(driver, steward: str, transfer_id: str, tenant_id: str) -> dict:
    """What is still in review for one transfer. Read-only.
    {sources: [{node_id, name, type, nodes}], other_nodes: n, total_nodes: n}."""
    _check_review_args(steward, transfer_id, tenant_id)
    with driver.session() as session:
        nodes, sources, reach = session.execute_read(_transfer_graph, steward, transfer_id, tenant_id)
    source_labels = set(_review_source_labels())
    covered = set().union(*reach.values()) if reach else set()
    return {
        "sources": [{"node_id": s, "name": nodes[s]["name"],
                     "type": next((l for l in nodes[s]["labels"] if l in source_labels), None),
                     "nodes": len(reach[s])} for s in sources],
        "other_nodes": len(set(nodes) - covered),
        "total_nodes": len(nodes),
    }


def keep_transferred(driver, steward: str, transfer_id: str, tenant_id: str, source_ids=None) -> list:
    """Keep as mine: remove the provenance properties (the former person's name leaves the graph) from the whole
    transfer, or from the given sources and everything they reach. Returns the node ids changed."""
    _check_review_args(steward, transfer_id, tenant_id)
    remove = ", ".join(f"n.{p}" for p in TRANSFER_PROVENANCE_PROPS)

    def work(tx):
        nodes, sources, reach = _transfer_graph(tx, steward, transfer_id, tenant_id)
        if source_ids is None:
            ids = list(nodes)
        else:
            unknown = [s for s in source_ids if s not in reach]
            if unknown:
                raise ValueError(f"not a source of this transfer: {unknown[:3]}")
            ids = sorted(set().union(*(reach[s] for s in source_ids))) if source_ids else []
        rows = tx.run(f"MATCH (n) WHERE n.node_id IN $ids AND n.transfer_id = $tid AND n.owner_id = $steward "
                      f"AND n.tenant_id = $tenant REMOVE {remove} RETURN n.node_id AS id",
                      ids=ids, tid=transfer_id, steward=steward, tenant=tenant_id).data()
        return [r["id"] for r in rows]

    with driver.session() as session:
        return session.execute_write(work)


def delete_transferred_sources(driver, steward: str, transfer_id: str, tenant_id: str, source_ids) -> dict:
    """Permanently delete the given sources of a transfer and the transferred nodes only they use.

    A node reached from a deleted source is deleted too unless another (kept) source of the transfer reaches it, or it
    is linked to any node outside the deletion set that is not SYSTEM/PUBLIC vocabulary (someone else's content still
    uses it). Ownerless tenant nodes and SYSTEM/PUBLIC are never in a transfer, so never deleted.
    Returns {"deleted": [node ids], "kept_in_use": [node ids]}."""
    _check_review_args(steward, transfer_id, tenant_id)
    if not source_ids:
        raise ValueError("source_ids required")

    def work(tx):
        nodes, sources, reach = _transfer_graph(tx, steward, transfer_id, tenant_id)
        unknown = [s for s in source_ids if s not in reach]
        if unknown:
            raise ValueError(f"not a source of this transfer: {unknown[:3]}")
        chosen = set(source_ids)
        kept_sources_reach = set().union(*(reach[s] for s in sources if s not in chosen)) if len(chosen) < len(sources) else set()
        cand = set().union(*(reach[s] for s in chosen)) - kept_sources_reach
        cand |= chosen
        in_use = set()
        for _ in range(DELETE_KEEP_PASSES):
            rows = tx.run(
                "MATCH (c) WHERE c.node_id IN $cand AND NOT c.node_id IN $sources "
                "MATCH (c)--(o) WHERE NOT o.node_id IN $cand AND NOT coalesce(o.tenant_id, '') IN $everyone "
                "RETURN DISTINCT c.node_id AS id",
                cand=sorted(cand), sources=sorted(chosen), everyone=EVERYONE_TIERS).data()
            used = {r["id"] for r in rows}
            if not used:
                break
            in_use |= used
            cand -= used
        rows = tx.run("MATCH (n) WHERE n.node_id IN $ids AND n.transfer_id = $tid AND n.owner_id = $steward "
                      "AND n.tenant_id = $tenant WITH n, n.node_id AS id DETACH DELETE n RETURN id",
                      ids=sorted(cand), tid=transfer_id, steward=steward, tenant=tenant_id).data()
        return {"deleted": sorted(r["id"] for r in rows), "kept_in_use": sorted(in_use)}

    with driver.session() as session:
        return session.execute_write(work)
