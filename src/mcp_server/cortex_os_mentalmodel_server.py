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


server = Server[dict[str, Any], RequestT]("cortex-os-mentalmodel")

# Global ExpertTools instance - instantiated once at server startup
expert: ExpertTools | None = None


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
    if expert is None:
        raise RuntimeError("ExpertTools instance not initialized. Server may not have started properly.")
    return expert.search_episodes_gds_by_question(question, k=k, limit=limit)


async def main() -> None:
    global expert
    
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

    # Instantiate ExpertTools once at server startup
    expert = ExpertTools()
    
    try:
        async with stdio_server() as (read_stream, write_stream):
            await server.run(read_stream, write_stream)
    finally:
        # Close ExpertTools when server shuts down
        if expert is not None:
            expert.close()


if __name__ == "__main__":
    asyncio.run(main())


