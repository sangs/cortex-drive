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
