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
        # Default to a test tenant for local dev if header is missing
        tenant_id = os.environ.get("DEFAULT_TENANT_ID", "default_tenant")
        
    expert = ExpertTools(tenant_id=tenant_id)
    try:
        return expert.search_episodes_gds_by_question(question, k=k, limit=limit)
    finally:
        expert.close()

# FastMCP exposes a starlette app for SSE via .sse_app()
app = mcp.sse_app()

class TenantMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        tenant_id = request.headers.get("x-tenant-id")
        token = None
        if tenant_id:
            token = tenant_id_var.set(tenant_id)
        
        try:
            response = await call_next(request)
            return response
        finally:
            if token:
                tenant_id_var.reset(token)

app.add_middleware(TenantMiddleware)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port)
