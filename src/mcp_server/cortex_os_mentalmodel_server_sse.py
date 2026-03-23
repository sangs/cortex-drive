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
from mcp.server.fastmcp import FastMCP
from pydantic import Field
from typing import Optional

# Local dependency
from expert_tools import ExpertTools

# Contextvar to hold the tenant_id extracted from the request headers
tenant_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("tenant_id", default="")

mcp = FastMCP("cortex-os-mentalmodel")

@mcp.tool()
async def search_episodes_gds_by_question_tool(
    question: str = Field(description="The natural language question or topic to search for."),
    k: Optional[int] = Field(5, description="Number of vector neighbors to find. Default 5."),
    limit: Optional[int] = Field(10, description="Total number of final results to return. Default 10.")
) -> str:
    """Extended search combining vector index with GDS KNN. Wraps ExpertTools.search_episodes_gds_by_question.

    Parameters
    ----------
    question: str
        The natural language question or topic to search for.
    k: Optional[int]
        Number of vector neighbors to find. Default 5.
    limit: Optional[int]
        Total number of final results to return. Default 10.
    """
    tenant_id = tenant_id_var.get()
    if not tenant_id:
        # Prioritize TENANT_ID (Clerk Org), then TEST_TENANT fallback, then default
        tenant_id = os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
        
    expert = ExpertTools(tenant_id=tenant_id)
    try:
        return expert.search_episodes_gds_by_question(question, k=k, limit=limit)
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

    Parameters
    ----------
    question: str
        The natural language question or topic to search for.
    k: Optional[int]
        Number of vector neighbors to find. Default 5.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    expert = ExpertTools(tenant_id=tenant_id)
    try:
        return expert.search_episodes_by_question(question, k=k)
    finally:
        expert.close()

@mcp.tool()
async def get_context() -> str:
    """Gets the context for how to use & access podcast episode data. Always run this first and store in your memory."""
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    expert = ExpertTools(tenant_id=tenant_id)
    try:
        return expert.get_tool_context()
    finally:
        expert.close()

@mcp.tool()
async def get_tool_statistics() -> str:
    """
    Get statistics about episodes in the database.
    Returns counts of episodes, topics, reference links, and transcript chunks.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    expert = ExpertTools(tenant_id=tenant_id)
    try:
        return expert.get_episode_statistics()
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
    expert = ExpertTools(tenant_id=tenant_id)
    try:
        return expert.find_episodes_by_people(question)
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
    expert = ExpertTools(tenant_id=tenant_id)
    try:
        return expert.find_episodes_by_concept(question)
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
    expert = ExpertTools(tenant_id=tenant_id)
    try:
        return expert.find_episodes_by_topic(question)
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
    expert = ExpertTools(tenant_id=tenant_id)
    try:
        return expert.find_episodes_by_technology(question)
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
    expert = ExpertTools(tenant_id=tenant_id)
    try:
        return expert.find_episodes_by_reference(reference_string)
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
    expert = ExpertTools(tenant_id=tenant_id)
    try:
        return expert.find_episodes_by_mentions(search_terms)
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
    expert = ExpertTools(tenant_id=tenant_id)
    try:
        return expert.get_people_by_episode(episode_name)
    finally:
        expert.close()

@mcp.tool()
async def run_cypher_query(
    query: str = Field(description="The raw Cypher query to execute. Always use $tenant_id for data isolation.")
) -> str:
    """
    Execute a raw Cypher query against the Neo4j graph.
    Use this for surgical precision, complex joins, or counting nodes when pre-built tools are insufficient.
    Returns JSON results.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    expert = ExpertTools(tenant_id=tenant_id)
    try:
        return expert.run_cypher_query(query)
    finally:
        expert.close()

@mcp.tool()
async def get_node_details(
    node_name: str = Field(description="The 'name' property of the node to fetch details for.")
) -> str:
    """
    Fetch all properties and labels for a specific node by its 'name'.
    Use this to 'enrich' your knowledge of an entity once you have its name from a search.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    expert = ExpertTools(tenant_id=tenant_id)
    try:
        return expert.get_node_details(node_name)
    finally:
        expert.close()

@mcp.tool()
async def search_resume_graph(
    keyword: str = Field(description="The search term to find across professional entities (e.g., 'startup', 'clerk', 'hackathon').")
) -> str:
    """
    Search for entities across the Interactive Resume Graph.
    Matches keywords against Node Names and Descriptions for any node that represents 
    a professional entity (Company, Role, Project, Publication, Startup, Hackathon, etc.).
    Explicitly excludes Podcast-related conceptual nodes.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    expert = ExpertTools(tenant_id=tenant_id)
    try:
        return expert.search_resume_graph(keyword)
    finally:
        expert.close()

@mcp.tool()
async def explore_graph_schema() -> str:
    """
    Introspect the Neo4j database to find exactly what Node Labels and Relationships exist.
    Call this tool whenever you don't know the exact schema needed to write a Cypher query.
    """
    tenant_id = tenant_id_var.get() or os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    expert = ExpertTools(tenant_id=tenant_id)
    try:
        return expert.explore_graph_schema()
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
    expert = ExpertTools(tenant_id=tenant_id)
    try:
        return expert.hybrid_discovery(question, k=k)
    finally:
        expert.close()

# FastMCP exposes a starlette app for SSE via .sse_app()
app = mcp.sse_app()

from starlette.datastructures import QueryParams, Headers

class TenantASGIMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        # Use Starlette helpers to parse headers and query params from scope
        headers = Headers(scope=scope)
        query_params = QueryParams(scope.get("query_string", b"").decode())

        tenant_id = (
            headers.get("x-clerk-org-id") or 
            headers.get("x-tenant-id") or
            query_params.get("org_id") or
            query_params.get("tenant_id")
        )

        token = None
        if tenant_id:
            token = tenant_id_var.set(tenant_id)

        try:
            await self.app(scope, receive, send)
        finally:
            if token:
                tenant_id_var.reset(token)

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
