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
