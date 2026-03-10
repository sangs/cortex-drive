import asyncio
import json
import os
from typing import Any, Dict

# Local dependency
from expert_tools import ExpertTools

# Minimal MCP stdio server using the reference Python SDK
try:
    from mcp.server import Server
    from mcp.server.stdio import stdio_server
except Exception as exc:  # pragma: no cover
    raise RuntimeError(
        "The 'mcp' Python package is required. Install it in this environment."
    ) from exc


server = Server("cortex-os-mentalmodel")


@server.tool()
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
    # For stdio testing, we use a default tenant if not specified in env
    # Prioritize TENANT_ID (Clerk Org), then TEST_TENANT fallback, then default
    tenant_id = os.environ.get("TENANT_ID") or os.environ.get("TEST_TENANT") or "test-tenant"
    expert = ExpertTools(tenant_id=tenant_id)
    try:
        return expert.search_episodes_gds_by_question(question, k=k, limit=limit)
    finally:
        expert.close()


async def main() -> None:
    # Ensure required environment variables are present for ExpertTools
    missing = [
        name
        for name in ("NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD", "OPENAI_API_KEY")
        if not os.environ.get(name)
    ]
    if missing:
        raise RuntimeError(
            f"Missing required environment variables: {', '.join(missing)}"
        )

    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream)


if __name__ == "__main__":
    asyncio.run(main())


