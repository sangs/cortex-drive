import os
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

import uvicorn
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.cors import CORSMiddleware
import contextvars
import asyncio
import json
import redis.asyncio as aioredis
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import Field
from typing import Optional

# Local dependency
from expert_tools import ExpertTools

# Contextvar to hold the tenant_id extracted from the request headers
tenant_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("tenant_id", default="")
# Contextvar to hold the authenticated Clerk user ID (sub claim)
user_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("user_id", default="")
# Contextvar to hold the 'Schema Readable' permission state
schema_readable_var: contextvars.ContextVar[bool] = contextvars.ContextVar("schema_readable", default=False)
# Contextvar to hold the authorized node ID for Guest Share Tokens
guest_share_anchor_var: contextvars.ContextVar[str] = contextvars.ContextVar("guest_share_anchor", default="")
# Log prefix for all permission cache operations (Redis hit/miss/error)
LOG_PERM_CACHE = "[PERM-CACHE/MCP]"

# Contextvar to hold resolved allowed node IDs (list | None; None = legacy tenant_id mode)
allowed_ids_var: contextvars.ContextVar[list | None] = contextvars.ContextVar("allowed_ids", default=None)
# Contextvar to hold perm_version at request start for staleness detection
perm_version_var: contextvars.ContextVar[str] = contextvars.ContextVar("perm_version", default="0")

# Async Redis client — shared across all requests (connection pool managed by aioredis)
_redis = aioredis.Redis.from_url(
    os.environ.get("REDIS_URL", "redis://localhost:6379"),
    decode_responses=True,
    socket_connect_timeout=1,
    socket_timeout=1,
)


async def _resolve_allowed_ids(user_id: str, tenant_id: str) -> tuple[list | None, str]:
    """Resolve allowed node IDs from Redis cache, falling back to OpenFGA on miss.

    Returns (allowed_ids, perm_version).
    allowed_ids=None means OpenFGA is unconfigured → legacy tenant_id-only mode.
    """
    if not user_id:
        return None, "0"
    perm_key = f"perm:{user_id}"
    version_key = f"perm_version:{tenant_id}"
    try:
        cached, version = await _redis.mget(perm_key, version_key)
        if cached is not None:
            print(f"{LOG_PERM_CACHE} hit user={user_id} version={version or '0'}")
            return json.loads(cached), version or "0"
    except Exception as e:
        print(f"{LOG_PERM_CACHE} Redis read failed, falling back to Permify: {e}")
    # Cache miss — resolve from Permify (LookupEntity traverses live parent tuples at depth 5)
    from permify_utils import list_viewable_node_ids
    allowed_ids = await list_viewable_node_ids(user_id)
    version = "0"
    try:
        version = await _redis.get(version_key) or "0"
        if allowed_ids is not None:
            await _redis.setex(perm_key, 300, json.dumps(allowed_ids))
            print(f"{LOG_PERM_CACHE} miss — resolved {len(allowed_ids)} ids for user={user_id}, cached 300s")
    except Exception as e:
        print(f"{LOG_PERM_CACHE} Redis write failed (non-fatal): {e}")
    return allowed_ids, version


async def _get_current_allowed_ids() -> list | None:
    """Return allowed_ids from context, re-resolving from OpenFGA if perm_version changed.

    Called at the start of every MCP tool to detect mid-session permission revocations.
    The Redis GET adds ~0.5ms — negligible against a Cypher query.
    """
    user_id = user_id_var.get() or ""
    tenant_id = tenant_id_var.get() or ""
    if not user_id:
        return None
    try:
        current_version = await _redis.get(f"perm_version:{tenant_id}") or "0"
        if current_version != perm_version_var.get():
            print(f"{LOG_PERM_CACHE} version stale (stored={perm_version_var.get()} current={current_version}) — re-resolving")
            allowed_ids, new_version = await _resolve_allowed_ids(user_id, tenant_id)
            allowed_ids_var.set(allowed_ids)
            perm_version_var.set(new_version)
            return allowed_ids
    except Exception:
        pass
    return allowed_ids_var.get()

mcp = FastMCP(
    "cortex-os-mentalmodel",
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)

@mcp.tool()
async def search_episodes_gds_by_question_tool(
    question: str = Field(description="The natural language question or topic to search for."),
    k: Optional[int] = Field(5, description="Number of vector neighbors to find. Default 5."),
    limit: Optional[int] = Field(10, description="Total number of final results to return. Default 10.")
) -> str:
    """Extended search combining vector index with GDS KNN. Wraps ExpertTools.search_episodes_gds_by_question."""
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    user_id = user_id_var.get() or ""
    guest_anchor = guest_share_anchor_var.get() or ""
    allowed_ids = await _get_current_allowed_ids()
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id, guest_share_anchor=guest_anchor, allowed_ids=allowed_ids)
    try:
        return expert.search_episodes_gds_by_question(question, k=k, limit=limit)
    except Exception as e:
        print(f"Error in search_episodes_gds_by_question_tool: {e}")
        return json.dumps({"error": str(e)})
    finally:
        expert.close()

@mcp.tool()
async def search_episodes_by_question_tool(
    question: str = Field(description="The natural language question or topic to search for."),
    k: Optional[int] = Field(5, description="Number of vector neighbors to find. Default 5.")
) -> str:
    """Search for relevant episodes using vector similarity search on chunk embeddings.
    Returns JSON string with EpisodeTitle, EpisodeNumber, ChunkContent, and SimilarityScore.
    Use this for summarization or detailed content questions.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    user_id = user_id_var.get() or ""
    guest_anchor = guest_share_anchor_var.get() or ""
    allowed_ids = await _get_current_allowed_ids()
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id, guest_share_anchor=guest_anchor, allowed_ids=allowed_ids)
    try:
        return expert.search_episodes_by_question(question, k=k)
    except Exception as e:
        print(f"Error in search_episodes_by_question_tool: {e}")
        return json.dumps({"error": str(e)})
    finally:
        expert.close()

@mcp.tool()
async def query_relevant_chunks_hybrid_tool(
    question: str = Field(description="The natural language question or topic to search for using Hybrid (Vector + BM25) search."),
    top_k: Optional[int] = Field(10, description="Number of results to return. Default 10.")
) -> str:
    """
    Perform a High-Fidelity Hybrid Search (BM25 + Vector) with Reciprocal Rank Fusion (RRF).
    This is the most accurate tool for finding specific context from transcripts.
    It combines conceptual depth (Vector) with literal keyword precision (BM25).
    
    Returns JSON with episode metadata and transcript chunks.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    user_id = user_id_var.get() or ""
    guest_anchor = guest_share_anchor_var.get() or ""
    allowed_ids = await _get_current_allowed_ids()
    print(f"[FGA/MCP] query_relevant_chunks_hybrid_tool: mode={'openfga' if allowed_ids is not None else 'legacy'} ids={len(allowed_ids) if allowed_ids is not None else 'N/A'}")
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id, guest_share_anchor=guest_anchor, allowed_ids=allowed_ids)
    try:
        return json.dumps(expert.query_relevant_chunks_hybrid(question, top_k=top_k))
    except Exception as e:
        print(f"Error in query_relevant_chunks_hybrid_tool: {e}")
        return json.dumps({"error": str(e)})
    finally:
        expert.close()

@mcp.tool()
async def get_context() -> str:
    """Gets the context for how to use & access podcast episode data. Always run this first and store in your memory."""
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    user_id = user_id_var.get() or ""
    guest_anchor = guest_share_anchor_var.get() or ""
    allowed_ids = await _get_current_allowed_ids()
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id, guest_share_anchor=guest_anchor, allowed_ids=allowed_ids)
    try:
        return expert.get_tool_context()
    except Exception as e:
        print(f"Error in get_context: {e}")
        return json.dumps({"error": str(e)})
    finally:
        expert.close()

@mcp.tool()
async def get_tool_statistics() -> str:
    """
    Get statistics about episodes in the database.
    Returns counts of episodes, topics, reference links, and transcript chunks.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    user_id = user_id_var.get() or ""
    guest_anchor = guest_share_anchor_var.get() or ""
    allowed_ids = await _get_current_allowed_ids()
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id, guest_share_anchor=guest_anchor, allowed_ids=allowed_ids)
    try:
        return expert.get_episode_statistics()
    except Exception as e:
        print(f"Error in get_tool_statistics: {e}")
        return json.dumps({"error": str(e)})
    finally:
        expert.close()

@mcp.tool()
async def find_episodes_by_people(question: str) -> str:
    """
    Search for episodes that feature specific people (hosts, guests, or listeners).
    Searches for people whose names contain the given question string
    and returns all episodes where they appear, along with their relationship type
    to the episode (e.g., HOSTS, GUEST_ON, LISTENS_TO_EPISODE, etc.).
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    user_id = user_id_var.get() or ""
    allowed_ids = await _get_current_allowed_ids()
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id, allowed_ids=allowed_ids)
    try:
        return expert.find_episodes_by_people(question)
    except Exception as e:
        print(f"Error in find_episodes_by_people: {e}")
        return json.dumps({"error": str(e)})
    finally:
        expert.close()

@mcp.tool()
async def get_episodes_with_cast() -> str:
    """
    List all available podcast episodes along with their hosts and guests.
    Use this for broad discovery of the podcast catalog.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    user_id = user_id_var.get() or ""
    allowed_ids = await _get_current_allowed_ids()
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id, allowed_ids=allowed_ids)
    try:
        return expert.get_episodes_with_cast()
    except Exception as e:
        print(f"Error in get_episodes_with_cast: {e}")
        return json.dumps({"error": str(e)})
    finally:
        expert.close()

@mcp.tool()
async def find_episodes_by_concept(question: str) -> str:
    """
    Search for episodes that discuss specific concepts or ideas.
    Performs a case-insensitive search on both concept names and descriptions
    to find relevant episodes.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    user_id = user_id_var.get() or ""
    allowed_ids = await _get_current_allowed_ids()
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id, allowed_ids=allowed_ids)
    try:
        return expert.find_episodes_by_concept(question)
    except Exception as e:
        print(f"Error in find_episodes_by_concept: {e}")
        return json.dumps({"error": str(e)})
    finally:
        expert.close()

@mcp.tool()
async def find_episodes_by_topic(question: str) -> str:
    """
    Search for episodes that contain specific topics or keywords.
    Performs a case-insensitive search across episode names, descriptions,
    and topic names to find episodes that match the given question.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    user_id = user_id_var.get() or ""
    allowed_ids = await _get_current_allowed_ids()
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id, allowed_ids=allowed_ids)
    try:
        return expert.find_episodes_by_topic(question)
    except Exception as e:
        print(f"Error in find_episodes_by_topic: {e}")
        return json.dumps({"error": str(e)})
    finally:
        expert.close()

@mcp.tool()
async def find_episodes_by_technology(question: str) -> str:
    """
    Search for episodes that discuss specific technologies or tools.
    Performs a case-insensitive search on technology names to find relevant episodes
    that discuss or mention the technology.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    user_id = user_id_var.get() or ""
    allowed_ids = await _get_current_allowed_ids()
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id, allowed_ids=allowed_ids)
    try:
        return expert.find_episodes_by_technology(question)
    except Exception as e:
        print(f"Error in find_episodes_by_technology: {e}")
        return json.dumps({"error": str(e)})
    finally:
        expert.close()

@mcp.tool()
async def find_episodes_by_reference(reference_string: str) -> str:
    """
    Find episodes that have reference links containing the input string.
    Searches for episodes that are connected to reference links
    through the HAS_REFERENCE_LINK relationship, where the reference URL or text
    contains the provided string. It performs a case-insensitive search.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    user_id = user_id_var.get() or ""
    allowed_ids = await _get_current_allowed_ids()
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id, allowed_ids=allowed_ids)
    try:
        return expert.find_episodes_by_reference(reference_string)
    except Exception as e:
        print(f"Error in find_episodes_by_reference: {e}")
        return json.dumps({"error": str(e)})
    finally:
        expert.close()

@mcp.tool()
async def find_episodes_by_mentions(search_terms: str) -> str:
    """
    Find episodes that mention the input search term in their reference links.
    Performs a case-insensitive search on reference URLs and text to find relevant episodes.
    Returns episodes with the matched reference link and which search term was matched.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    user_id = user_id_var.get() or ""
    allowed_ids = await _get_current_allowed_ids()
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id, allowed_ids=allowed_ids)
    try:
        return expert.find_episodes_by_mentions(search_terms)
    except Exception as e:
        print(f"Error in find_episodes_by_mentions: {e}")
        return json.dumps({"error": str(e)})
    finally:
        expert.close()

@mcp.tool()
async def get_people_by_episode_tool(
    episode_name: str = Field(description="The name or partial name of the episode to find people for.")
) -> str:
    """Find all people (hosts, guests, etc.) associated with a specific episode.
    Returns JSON string with person_name, relationship, episode_title, and episode_number.
    Use this when you have an episode and need to know who the guest or host is.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    user_id = user_id_var.get() or ""
    allowed_ids = await _get_current_allowed_ids()
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id, allowed_ids=allowed_ids)
    try:
        return expert.get_people_by_episode(episode_name)
    except Exception as e:
        print(f"Error in get_people_by_episode: {e}")
        return json.dumps({"error": str(e)})
    finally:
        expert.close()

@mcp.tool()
async def run_cypher_query(
    query: str = Field(description="The raw Cypher query to execute. Always use $tenant_id for data isolation.")
) -> str:
    """
    Execute a raw Cypher query against the Neo4j graph.
    Use this for surgical precision, complex joins, or counting nodes when pre-built tools are insufficient.
    Returns JSON results. NOTE: Sensitive node traversals are blocked for non-owner users.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    user_id = user_id_var.get() or ""
    guest_anchor = guest_share_anchor_var.get() or ""
    schema_readable = schema_readable_var.get()
    allowed_ids = await _get_current_allowed_ids()
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id, guest_share_anchor=guest_anchor, allowed_ids=allowed_ids)
    try:
        return expert.run_cypher_query(query, requesting_user_id=user_id, schema_readable=schema_readable)
    finally:
        expert.close()

@mcp.tool()
async def get_node_details(
    node_id: Optional[str] = Field(None, description="The unique element_id of the node."),
    node_name: Optional[str] = Field(None, description="The 'name' property of the node (fallback).")
) -> str:
    """
    Fetch all properties and labels for a specific node by its 'element_id' or 'name'.
    Use this to 'enrich' your knowledge of an entity once you have its handle from a search.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    user_id = user_id_var.get() or ""
    allowed_ids = await _get_current_allowed_ids()
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id, allowed_ids=allowed_ids)
    try:
        return expert.get_node_details(node_id=node_id, node_name=node_name)
    except Exception as e:
        print(f"Error in get_node_details: {e}")
        return json.dumps({"error": str(e)})
    finally:
        expert.close()

@mcp.tool()
async def search_enterprise_graph(
    keyword: str = Field(description="The search term to find across the graph (e.g., 'startup', 'BAML', 'Iceberg', 'Kafka')."),
    domain_intent: str = Field("all", description="The domain sandbox to search within. Allowed values: 'professional' (Resume), 'podcast' (Episodes/Chunks), 'federated' (External Silos), or 'all'."),
    wants_visual_map: bool = Field(False, description="Set to true if the user asks for a map, graph, overview, or visual landscape.")
) -> str:
    """
    Search for entities across the Universal Enterprise Graph.
    Acts as the main switchboard for all domain-specific subgraph routing. 
    Use this when the user asks questions spanning Resume, Podcasts, or Federated Data Silos.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    user_id = user_id_var.get() or "trial-user"
    guest_anchor = guest_share_anchor_var.get() or ""
    allowed_ids = await _get_current_allowed_ids()
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id, guest_share_anchor=guest_anchor, allowed_ids=allowed_ids)
    try:
        return expert.search_enterprise_graph(keyword, requesting_user_id=user_id, wants_visual_map=wants_visual_map, domain_intent=domain_intent)
    except Exception as e:
        print(f"Error in search_enterprise_graph: {e}")
        return json.dumps({"error": str(e)})
    finally:
        expert.close()

@mcp.tool()
async def explore_graph_schema() -> str:
    """
    Introspect the Neo4j database to find exactly what Node Labels and Relationships exist.
    Call this tool whenever you don't know the exact schema needed to write a Cypher query.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    user_id = user_id_var.get() or ""
    schema_readable = schema_readable_var.get()
    allowed_ids = await _get_current_allowed_ids()
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id, allowed_ids=allowed_ids)
    try:
        return expert.explore_graph_schema(schema_readable=schema_readable)
    except Exception as e:
        print(f"Error in explore_graph_schema: {e}")
        return json.dumps({"error": str(e)})
    finally:
        expert.close()

@mcp.tool()
async def hybrid_discovery_tool(
    question: str = Field(description="The semantic query or question to search for."),
    k: Optional[int] = Field(5, description="Number of results to return. Default 5.")
) -> str:
    """
    Perform a native Hybrid Search (GraphRAG).
    Finds relevant chunks via vector search and automatically enriches them with
    Episode metadata and Participant names (Hosts/Guests) from the graph.
    
    Returns JSON with content, similarity, metadata, and participants.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    user_id = user_id_var.get() or ""
    allowed_ids = await _get_current_allowed_ids()
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id, allowed_ids=allowed_ids)
    try:
        return expert.hybrid_discovery(question, k=k)
    except Exception as e:
        print(f"Error in hybrid_discovery_tool: {e}")
        return json.dumps({"error": str(e)})
    finally:
        expert.close()

@mcp.tool()
async def get_cluster_context(
    node_id: Optional[str] = Field(None, description="The unique element_id of the node to expand."),
    node_name: Optional[str] = Field(None, description="The 'name' property of the node (fallback)."),
    depth: Optional[int] = Field(1, description="The distance to traverse (1 for immediate neighbors, 2 for extended context). Default 1."),
    backbone_only: bool = Field(False, description="If true, only returns high-level landmarks (Companies, Categories, Hubs)."),
    domain: str = Field("all", description="The domain to filter results by: 'professional', 'podcast', or 'all'. Default 'all'.")
) -> str:
    """
    Fetch the semantic neighbors and relationships for a specific node by its element_id or name.
    Use this for Directed Autonomy to proactively discover related nodes and hidden context.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    user_id = user_id_var.get() or ""
    guest_anchor = guest_share_anchor_var.get() or ""
    allowed_ids = await _get_current_allowed_ids()
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id, guest_share_anchor=guest_anchor, allowed_ids=allowed_ids)
    try:
        return expert.get_cluster_context(node_id=node_id, node_name=node_name, depth=depth, backbone_only=backbone_only, domain=domain)
    except Exception as e:
        print(f"Error in get_cluster_context: {e}")
        return json.dumps({"error": str(e)})
    finally:
        expert.close()

@mcp.tool()
async def connect_knowledge_on_demand(
    source_node_id: Optional[str] = Field(None, description="The unique element_id of the source node."),
    source_node_name: Optional[str] = Field(None, description="The 'name' property of the source node (fallback)."),
    target_domain: str = Field("all", description="Domain to bridge INTO: 'podcast', 'professional', or 'all'."),
    min_anchors: int = Field(1, description="Minimum number of shared concept/technology anchors required for a bridge. Default 1."),
    limit: int = Field(5, description="Maximum number of bridge targets to return. Default 5.")
) -> str:
    """
    Discover virtual cross-domain knowledge bridges for a specific node without writing to Neo4j.
    Finds nodes in another domain that share Technology, Topic, or Concept anchors with the source node.
    Uses Taxonomy Expansion (IS_A/SUB_TOPIC_OF) to resolve semantic gaps (e.g., 'AI Agent' -> 'AI').
    Returns session-only virtual links rendered as gold dashed connections in the graph UI.
    Use this when the user asks how one domain influenced another, e.g.:
      - 'How did this thought leadership influence the Cortex-Drive project?'
      - 'What podcast episodes relate to this career project?'
      - 'Where did this hackathon work show up later?'
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    user_id = user_id_var.get() or ""
    guest_anchor = guest_share_anchor_var.get() or ""
    allowed_ids = await _get_current_allowed_ids()
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id, guest_share_anchor=guest_anchor, allowed_ids=allowed_ids)
    try:
        return expert.connect_knowledge_on_demand(
            source_node_id=source_node_id,
            source_node_name=source_node_name,
            target_domain=target_domain,
            min_anchors=min_anchors,
            limit=limit
        )
    except Exception as e:
        print(f"Error in connect_knowledge_on_demand: {e}")
        return json.dumps({"error": str(e)})
    finally:
        expert.close()

# FastMCP exposes a starlette app for SSE via .sse_app()
app = mcp.sse_app()

from starlette.datastructures import QueryParams, Headers

class TenantASGIMiddleware:
    """ASGI middleware that extracts tenant_id and user_id from request headers."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        # Use Starlette helpers to parse headers and query params from scope
        headers = Headers(scope=scope)
        query_params = QueryParams(scope.get("query_string", b"").decode())

        # Extract tenant (org) identity
        tenant_id = (
            headers.get("x-clerk-org-id") or
            headers.get("x-tenant-id") or
            query_params.get("org_id") or
            query_params.get("tenant_id")
        )

        # Extract 'Schema Readable' permission header (set by Gateway for Admins)
        schema_readable = headers.get("x-schema-readable", "").lower() == "true"

        # Extract user identity
        user_id = (
            headers.get("x-user-id") or
            headers.get("x-clerk-user-id") or
            query_params.get("user_id")
        )

        # Extract guest share anchor for URL-based stateless discovery
        guest_share_anchor = (
            headers.get("x-guest-share-anchor") or
            query_params.get("share_anchor")
        )

        # Resolve permissions from Redis (or OpenFGA on cache miss)
        resolved_allowed_ids, perm_version = await _resolve_allowed_ids(
            (user_id or ""), (tenant_id or "")
        )

        tenant_token = tenant_id_var.set(tenant_id) if tenant_id else None
        user_token = user_id_var.set(user_id) if user_id else None
        schema_token = schema_readable_var.set(schema_readable)
        guest_anchor_token = guest_share_anchor_var.set(guest_share_anchor) if guest_share_anchor else None
        allowed_ids_token = allowed_ids_var.set(resolved_allowed_ids)
        perm_version_token = perm_version_var.set(perm_version)

        try:
            await self.app(scope, receive, send)
        finally:
            if tenant_token:
                tenant_id_var.reset(tenant_token)
            if user_token:
                user_id_var.reset(user_token)
            if guest_anchor_token:
                guest_share_anchor_var.reset(guest_anchor_token)
            allowed_ids_var.reset(allowed_ids_token)
            perm_version_var.reset(perm_version_token)
            schema_readable_var.reset(schema_token)

app.add_middleware(TenantASGIMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port)
