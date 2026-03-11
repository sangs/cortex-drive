import os
import uvicorn
from starlette.middleware.base import BaseHTTPMiddleware
import contextvars
from mcp.server.fastmcp import FastMCP

# Local dependency
from expert_tools import ExpertTools

# Contextvar to hold the tenant_id extracted from the request headers
tenant_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("tenant_id", default="")

mcp = FastMCP("cortex-os-mentalmodel")

@mcp.tool()
async def search_episodes_gds_by_question_tool(question: str, k: int, limit: int) -> str:
    """Extended search combining vector index with GDS KNN. Wraps ExpertTools.search_episodes_gds_by_question.

    Parameters
    ----------
    question: str
        The user's natural-language question.
    k: int
        Number of nearest neighbor chunks to retrieve for initial search.
    limit: int
        Total number of results to return.
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
    to the episode (e.g., IS_A_HOST, IS_A_GUEST, LISTENS_TO_EPISODE, etc.).
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

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port)
