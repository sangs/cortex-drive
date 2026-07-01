"""
Permify authorization utilities for CortexDrive.

Replaces openfga_utils.py. All tuple and attribute operations live here.
No authorization logic in expert_tools.py or gateway beyond calling these functions.

Key differences from OpenFGA:
  - Parent tuples: write_parent_tuple() called at ingestion for every COMPOSITION_RELATIONSHIPS edge.
    ONE shared_viewer tuple on the root → children inherit via parent.can_view.
  - Privacy attributes: write_privacy_attribute() sets is_private=true on PreparatoryNote nodes.
    Blocks non-owner access even through parent.can_view chains.
  - list_viewable_node_ids: calls LookupEntity(depth=PERMIFY_MAX_DEPTH) for live graph traversal.
    New children added after a share are automatically covered — no grant refresh needed.

REST API used directly (no gRPC SDK required). All calls are idempotent.

Permify v0.9+ endpoint map (breaking change from earlier versions):
  Relationships: POST /relationships/write  (key: "tuples")   — NOT /data/write
  Rel delete:    POST /relationships/delete (key: "filter")
  Attributes:    POST /data/write           (key: "attributes") — unchanged
  Attr delete:   POST /data/delete          (keys: "tuple_filter": {}, "attribute_filter": {...})
  Rel read:      POST /data/relationships/read
  Attr read:     POST /data/attributes/read
  Check:         POST /permissions/check
  Lookup:        POST /permissions/lookup-entity

Env vars:
  PERMIFY_API_URL        — base URL of the cortex-permify Cloud Run service
  PERMIFY_TENANT_ID      — Permify tenant identifier (default: "cortex-drive")
  PERMIFY_MAX_DEPTH      — depth for LookupEntity traversal (default: 5)
  PERMIFY_API_TOKEN      — OIDC bearer token for Cloud Run auth
  PERMIFY_SCHEMA_VERSION — schema version hash returned by /schemas/write;
                           required for all /data/write calls (no "head" alias exists)
"""

import os
from datetime import datetime, timezone, timedelta
from typing import Optional
import httpx


def _base_url() -> str:
    return os.environ.get("PERMIFY_API_URL", "http://localhost:3476").rstrip("/")


def _tenant() -> str:
    return os.environ.get("PERMIFY_TENANT_ID", "cortex-drive")


def _max_depth() -> int:
    return int(os.environ.get("PERMIFY_MAX_DEPTH", "5"))


def _schema_version() -> str:
    return os.environ.get("PERMIFY_SCHEMA_VERSION", "")


async def _get_headers() -> dict:
    h = {"Content-Type": "application/json"}
    token = os.environ.get("PERMIFY_API_TOKEN", "")
    if not token and os.environ.get("K_SERVICE"):
        # Running in Cloud Run — fetch a fresh GCP OIDC token from the metadata server.
        # K_SERVICE is set by Cloud Run on every revision; absent in local dev.
        # Uses httpx (already a dependency) so no extra package is needed.
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(
                    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity",
                    params={"audience": _base_url()},
                    headers={"Metadata-Flavor": "Google"},
                )
                resp.raise_for_status()
                token = resp.text.strip()
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning("[OIDC/Permify] token fetch failed: %s", exc)
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _configured() -> bool:
    return bool(os.environ.get("PERMIFY_API_URL"))


# ---------------------------------------------------------------------------
# Core relationship (tuple) operations
# ---------------------------------------------------------------------------

async def register_node_owner(node_id: str, owner_user_id: str) -> None:
    """Write the owner tuple for a newly created node."""
    if not _configured():
        return
    await _write_relationships([{
        "entity":   {"type": "node", "id": node_id},
        "relation": "owner",
        "subject":  {"type": "user", "id": owner_user_id},
    }])


async def make_tenant_wide(node_id: str, tenant_org_id: str) -> None:
    """Publish a node to all members of a tenant org (tenant_viewer tuple)."""
    if not _configured():
        return
    await _write_relationships([{
        "entity":   {"type": "node", "id": node_id},
        "relation": "tenant_viewer",
        "subject":  {"type": "org", "id": tenant_org_id, "relation": "member"},
    }])


async def share_with_user(
    node_id: str,
    target_sub: str,
    expires_at: Optional[str] = None,
) -> None:
    """Share a single node with a specific user (writes ONE shared_viewer tuple on the root).

    With parent tuples in place, this single tuple propagates to all children via
    parent.can_view — no fan-out needed.
    expires_at: ISO 8601 string e.g. "2026-07-01T00:00:00Z". Omit for permanent share.
    """
    if not _configured():
        return
    rel: dict = {
        "entity":   {"type": "node", "id": node_id},
        "relation": "shared_viewer",
        "subject":  {"type": "user", "id": target_sub},
    }
    if expires_at:
        rel["required_conditions"] = {"expires_at": expires_at}
    await _write_relationships([rel])


async def share_with_group(
    node_id: str,
    group_id: str,
    expires_at: Optional[str] = None,
) -> None:
    """Share a node with all members of a group."""
    if not _configured():
        return
    rel: dict = {
        "entity":   {"type": "node", "id": node_id},
        "relation": "shared_viewer",
        "subject":  {"type": "group", "id": group_id, "relation": "member"},
    }
    if expires_at:
        rel["required_conditions"] = {"expires_at": expires_at}
    await _write_relationships([rel])


async def write_parent_tuple(child_node_id: str, parent_node_id: str) -> None:
    """Write a composition parent tuple: child.parent = parent_node.

    Called at ingestion time for every COMPOSITION_RELATIONSHIPS edge.
    These tuples encode graph structure — they are NEVER deleted on share revoke.
    Guard: caller must ensure neither node is SYSTEM/PUBLIC tenant.
    """
    if not _configured():
        return
    await _write_relationships([{
        "entity":   {"type": "node", "id": child_node_id},
        "relation": "parent",
        "subject":  {"type": "node", "id": parent_node_id},
    }])


async def revoke(node_id: str, subject: str, relation: str) -> None:
    """Delete a tuple. Immediate revocation — only for shared_viewer/tenant_viewer/owner.

    Never call this for parent tuples — those encode graph structure.
    subject format: "user:sub", "org:orgId#member", "group:gid#member", "agent:sid"
    """
    if not _configured():
        return
    subject_type, subject_rest = subject.split(":", 1)
    subject_id = subject_rest.split("#")[0]
    subject_rel = subject_rest.split("#")[1] if "#" in subject_rest else None

    subject_obj: dict = {"type": subject_type, "id": subject_id}
    if subject_rel:
        subject_obj["relation"] = subject_rel

    await _delete_relationships([{
        "entity":   {"type": "node", "id": node_id},
        "relation": relation,
        "subject":  subject_obj,
    }])


# ---------------------------------------------------------------------------
# Attribute operations (ABAC — privacy markers)
# ---------------------------------------------------------------------------

async def write_privacy_attribute(node_id: str, is_private: bool) -> None:
    """Set or clear the is_private attribute on a node in Permify.

    True: non-owners cannot see this node even if it is reachable via parent.can_view.
    False: removes the attribute (Permify treats absent attribute as false in the rule).
    Called at ingestion for PreparatoryNote nodes, and by PATCH /api/nodes/:id/privacy.
    """
    if not _configured():
        return
    if is_private:
        await _write_attributes([{
            "entity":    {"type": "node", "id": node_id},
            "attribute": "is_private",
            "value": {
                "@type": "type.googleapis.com/base.v1.BooleanValue",
                "data":  True,
            },
        }])
    else:
        await _delete_attributes([{
            "entity":    {"type": "node", "id": node_id},
            "attribute": "is_private",
        }])


# ---------------------------------------------------------------------------
# Agent session management
# ---------------------------------------------------------------------------

async def create_agent_session(
    node_ids: list[str],
    agent_session_id: str,
    delegated_by_user_id: str,
    ttl_hours: float = 1.0,
) -> str:
    """Issue time-bound shared_viewer tuples for an LLM agent session.

    Returns the expires_at ISO string. Agent access is always time-bound.
    """
    expires_at = (
        datetime.now(timezone.utc) + timedelta(hours=ttl_hours)
    ).isoformat()
    if not _configured():
        return expires_at
    rels = [
        {
            "entity":   {"type": "node", "id": nid},
            "relation": "shared_viewer",
            "subject":  {"type": "agent", "id": agent_session_id},
            "required_conditions": {"expires_at": expires_at},
        }
        for nid in node_ids
    ]
    await _write_relationships(rels)
    return expires_at


async def revoke_agent_session(agent_session_id: str, node_ids: list[str]) -> None:
    """Immediately revoke all access for an agent session."""
    if not _configured():
        return
    rels = [
        {
            "entity":   {"type": "node", "id": nid},
            "relation": "shared_viewer",
            "subject":  {"type": "agent", "id": agent_session_id},
        }
        for nid in node_ids
    ]
    await _delete_relationships(rels)


# ---------------------------------------------------------------------------
# Permission resolution (used by MCP + Bento Redis cache population)
# ---------------------------------------------------------------------------

async def list_viewable_node_ids(user_id: str) -> list[str] | None:
    """Return all node UUIDs visible to a user via Permify can_view permission.

    Uses LookupEntity with PERMIFY_MAX_DEPTH — traverses live parent tuples at
    query time, so new children added after a share are automatically covered.
    Returns None when Permify is not configured — callers fall back to tenant_id mode.
    user_id is the raw Clerk sub (no "user:" prefix — added here).
    """
    if not _configured():
        return None
    url = f"{_base_url()}/v1/tenants/{_tenant()}/permissions/lookup-entity"
    payload = {
        "metadata":    {"depth": _max_depth(), "schema_version": "", "snap_token": ""},
        "entity_type": "node",
        "permission":  "can_view",
        "subject":     {"type": "user", "id": user_id},
        "context":     {"tuples": [], "attributes": [], "data": {}},
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(url, json=payload, headers=await _get_headers())
        resp.raise_for_status()
        data = resp.json()
        entity_ids = data.get("entity_ids") or []
        return entity_ids


async def check_permission(node_id: str, user_id: str, permission: str = "can_view") -> bool:
    """Point-check whether a user has a specific permission on a node."""
    if not _configured():
        return False
    url = f"{_base_url()}/v1/tenants/{_tenant()}/permissions/check"
    payload = {
        "metadata":  {"depth": _max_depth(), "schema_version": "", "snap_token": ""},
        "entity":    {"type": "node", "id": node_id},
        "permission": permission,
        "subject":   {"type": "user", "id": user_id},
        "context":   {"tuples": [], "attributes": [], "data": {}},
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(url, json=payload, headers=await _get_headers())
        resp.raise_for_status()
        return resp.json().get("can") == "CHECK_RESULT_ALLOWED"


# ---------------------------------------------------------------------------
# Read helpers (for Manage Access UI)
# ---------------------------------------------------------------------------

async def list_node_access(node_id: str) -> list[dict]:
    """Return all relationship tuples for a node (for the Manage Access modal)."""
    if not _configured():
        return []
    url = f"{_base_url()}/v1/tenants/{_tenant()}/data/relationships/read"
    payload = {
        "metadata":  {"schema_version": "", "snap_token": ""},
        "filter":    {"entity": {"type": "node", "ids": [node_id]}, "relation": ""},
        "page_size": 100,
        "continuous_token": "",
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(url, json=payload, headers=await _get_headers())
        resp.raise_for_status()
        tuples = resp.json().get("tuples") or []
        return [
            {
                "subject":  t.get("subject"),
                "relation": t.get("relation"),
                "entity":   t.get("entity"),
            }
            for t in tuples
        ]


# ---------------------------------------------------------------------------
# Low-level REST helpers
# ---------------------------------------------------------------------------

async def _write_relationships(tuples: list[dict]) -> None:
    # Permify v0.9+: relationships use /relationships/write with "tuples" key.
    # /data/write silently ignores the "relationships" field in this version.
    url = f"{_base_url()}/v1/tenants/{_tenant()}/relationships/write"
    payload = {
        "metadata": {"schema_version": _schema_version()},
        "tuples":   tuples,
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(url, json=payload, headers=await _get_headers())
        resp.raise_for_status()


async def _delete_relationships(tuples: list[dict]) -> None:
    # /relationships/delete takes a single "filter" (not a list); call once per tuple.
    url = f"{_base_url()}/v1/tenants/{_tenant()}/relationships/delete"
    async with httpx.AsyncClient(timeout=15.0) as client:
        for tup in tuples:
            resp = await client.post(url, json={"filter": tup}, headers=await _get_headers())
            resp.raise_for_status()


async def _write_attributes(attributes: list[dict]) -> None:
    url = f"{_base_url()}/v1/tenants/{_tenant()}/data/write"
    payload = {
        "metadata":   {"schema_version": _schema_version()},
        "attributes": attributes,
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(url, json=payload, headers=await _get_headers())
        resp.raise_for_status()


async def _delete_attributes(attributes: list[dict]) -> None:
    # /data/delete requires tuple_filter (non-null) even for attribute-only deletes.
    # Pass an empty tuple_filter {} which matches nothing and satisfies the constraint.
    url = f"{_base_url()}/v1/tenants/{_tenant()}/data/delete"
    for attr in attributes:
        payload = {
            "tuple_filter":     {},
            "attribute_filter": {
                "entity":    attr["entity"],
                "attribute": attr["attribute"],
            },
        }
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, json=payload, headers=await _get_headers())
            resp.raise_for_status()
