"""In-band tool error results (S2-90; design documents/architecture/safe-errors-and-alerts-design-2026-11-18.md §2).

MCP tools report failures in-band as {"error": ...} (AP-22). A Neo4j outage must not look like an ordinary failure:
the gateway would answer "No data found" (AP-25) when the truth is "the knowledge graph is unavailable". So an outage
carries error_code "graph_unavailable" (same code as cortex-gateway/config/user_errors.json), which the gateway's
callMcpTool raises as GraphUnavailableError and answers with a fixed safe message. Every other error is unchanged.
"""
import json

from neo4j.exceptions import DatabaseUnavailable, ServiceUnavailable, SessionExpired

GRAPH_UNAVAILABLE = "graph_unavailable"   # must match cortex-gateway/utils/user_errors.js GRAPH_UNAVAILABLE
GRAPH_UNAVAILABLE_TEXT = "knowledge graph unavailable"
# ServiceUnavailable covers RoutingServiceUnavailable / Read- / WriteServiceUnavailable ("Unable to retrieve routing
# information", the 2026-11-18 Aura outage).
_OUTAGE_TYPES = (ServiceUnavailable, SessionExpired, DatabaseUnavailable)


def is_graph_outage(exc: BaseException) -> bool:
    return isinstance(exc, _OUTAGE_TYPES)


def tool_error(exc: BaseException) -> dict:
    """The in-band error for a tool failure: marked when Neo4j is unreachable, otherwise as before."""
    if is_graph_outage(exc):
        return {"error": GRAPH_UNAVAILABLE_TEXT, "error_code": GRAPH_UNAVAILABLE}
    return {"error": str(exc)}


def tool_error_json(exc: BaseException) -> str:
    return json.dumps(tool_error(exc))
