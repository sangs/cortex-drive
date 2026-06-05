"""
OpenFGA authorization utilities for CortexDrive.

All tuple operations live here. No authorization logic in expert_tools.py or gateway
beyond calling these functions and getAllowedNodeIds().

Default at ingestion: ONE owner tuple. No tenant_viewer = no org member sees the node.
Owner explicitly promotes visibility via make_tenant_wide() or share_with_user().
"""

import os
from datetime import datetime, timezone, timedelta
from typing import Optional
from openfga_sdk import OpenFgaClient, ClientConfiguration
from openfga_sdk.credentials import CredentialConfiguration, Credentials
from openfga_sdk.client.models import (
    ClientTuple,
    ClientWriteRequest,
    ClientCheckRequest,
    ClientListObjectsRequest,
)


def _encode_eid(element_id: str) -> str:
    """Encode a Neo4j elementId for use as an OpenFGA object ID.

    Neo4j elementIds are formatted as '4:uuid:number' — the colons are invalid
    in OpenFGA object IDs which disallow ':', '#', '@', and whitespace.
    Replace ':' with '.' to produce a stable, reversible encoding.
    """
    return element_id.replace(":", ".")


def _decode_eid(encoded: str) -> str:
    """Reverse of _encode_eid — convert OpenFGA object ID back to Neo4j elementId."""
    return encoded.replace(".", ":")


def _get_client() -> OpenFgaClient:
    """Return a configured OpenFGA client using env vars.

    When OPENFGA_API_TOKEN is set (e.g. Cloud Run OIDC token injected by bootstrap
    entrypoint), it is passed as a bearer token so the SDK can reach a
    --no-allow-unauthenticated Cloud Run service.
    """
    api_token = os.environ.get("OPENFGA_API_TOKEN", "")
    credentials = (
        Credentials(
            method="api_token",
            configuration=CredentialConfiguration(api_token=api_token),
        )
        if api_token else None
    )
    config = ClientConfiguration(
        api_url=os.environ.get("OPENFGA_API_URL", "http://localhost:8082"),
        store_id=os.environ.get("OPENFGA_STORE_ID", ""),
        authorization_model_id=os.environ.get("OPENFGA_MODEL_ID", ""),
        credentials=credentials,
    )
    return OpenFgaClient(config)


# ---------------------------------------------------------------------------
# Core tuple operations
# ---------------------------------------------------------------------------

async def register_node_owner(element_id: str, owner_user_id: str) -> None:
    """Write the single owner tuple for a newly created node.

    Called after every Neo4j CREATE/MERGE. This is the sole gate that makes
    a node private-by-default — no other tuple = invisible to everyone except owner.
    """
    async with _get_client() as fga:
        await fga.write(ClientWriteRequest(
            writes=[ClientTuple(
                user=f"user:{owner_user_id}",
                relation="owner",
                object=f"node:{_encode_eid(element_id)}",
            )]
        ))


async def make_tenant_wide(element_id: str, tenant_org_id: str) -> None:
    """Publish a node to all members of a tenant org.

    Writes a tenant_viewer tuple for org#member. After this call every member's
    listObjects will return this node — no individual tuple needed per member.
    """
    async with _get_client() as fga:
        await fga.write(ClientWriteRequest(
            writes=[ClientTuple(
                user=f"org:{tenant_org_id}#member",
                relation="tenant_viewer",
                object=f"node:{_encode_eid(element_id)}",
            )]
        ))


async def share_with_user(
    element_id: str,
    target_sub: str,
    expires_at: Optional[str] = None,
) -> None:
    """Share a node with a specific user (cross-tenant or same-tenant direct share).

    expires_at: ISO 8601 string e.g. "2026-07-01T00:00:00Z". Omit for permanent share.
    """
    tuple_obj = ClientTuple(
        user=f"user:{target_sub}",
        relation="shared_viewer",
        object=f"node:{_encode_eid(element_id)}",
    )
    if expires_at:
        tuple_obj.condition = {
            "name": "not_expired",
            "context": {"expires_at": expires_at},
        }
    async with _get_client() as fga:
        await fga.write(ClientWriteRequest(writes=[tuple_obj]))


async def share_with_group(
    element_id: str,
    group_id: str,
    expires_at: Optional[str] = None,
) -> None:
    """Share a node with all members of a group."""
    tuple_obj = ClientTuple(
        user=f"group:{group_id}#member",
        relation="shared_viewer",
        object=f"node:{_encode_eid(element_id)}",
    )
    if expires_at:
        tuple_obj.condition = {
            "name": "not_expired",
            "context": {"expires_at": expires_at},
        }
    async with _get_client() as fga:
        await fga.write(ClientWriteRequest(writes=[tuple_obj]))


async def revoke(element_id: str, subject: str, relation: str) -> None:
    """Delete a tuple. Immediate revocation. Neo4j is not touched.

    subject examples:
      "user:investor_sub"
      "org:tenant_org_id#member"
      "group:group_id#member"
      "agent:session_id"
    """
    async with _get_client() as fga:
        await fga.write(ClientWriteRequest(
            deletes=[ClientTuple(
                user=subject,
                relation=relation,
                object=f"node:{_encode_eid(element_id)}",
            )]
        ))


# ---------------------------------------------------------------------------
# Agent session management (Phase 1: stub — model defined, tuples not issued yet)
# ---------------------------------------------------------------------------

async def create_agent_session(
    element_ids: list[str],
    agent_session_id: str,
    delegated_by_user_id: str,
    ttl_hours: float = 1.0,
) -> str:
    """Issue time-bound shared_viewer tuples for an LLM agent session.

    Returns the expires_at ISO string so the caller can log/store it.
    Agent access is always time-bound — no indefinite agent access permitted.
    """
    expires_at = (
        datetime.now(timezone.utc) + timedelta(hours=ttl_hours)
    ).isoformat()

    tuples = [
        ClientTuple(
            user=f"agent:{agent_session_id}",
            relation="shared_viewer",
            object=f"node:{_encode_eid(eid)}",
            condition={"name": "not_expired", "context": {"expires_at": expires_at}},
        )
        for eid in element_ids
    ]
    async with _get_client() as fga:
        await fga.write(ClientWriteRequest(writes=tuples))

    return expires_at


async def revoke_agent_session(agent_session_id: str, element_ids: list[str]) -> None:
    """Immediately revoke all access for an agent session."""
    tuples = [
        ClientTuple(
            user=f"agent:{agent_session_id}",
            relation="shared_viewer",
            object=f"node:{_encode_eid(eid)}",
        )
        for eid in element_ids
    ]
    async with _get_client() as fga:
        await fga.write(ClientWriteRequest(deletes=tuples))


# ---------------------------------------------------------------------------
# Read helpers (used by share UI GET endpoint)
# ---------------------------------------------------------------------------

async def list_node_access(element_id: str) -> list[dict]:
    """Return all tuples for a node (active + expired) for the Manage Access Modal.

    Expired tuples are never auto-deleted — they serve as the audit trail.
    """
    async with _get_client() as fga:
        response = await fga.read(object=f"node:{_encode_eid(element_id)}")
        tuples = response.tuples or []
        return [
            {
                "user": t.key.user,
                "relation": t.key.relation,
                "condition": t.key.condition,
            }
            for t in tuples
        ]
