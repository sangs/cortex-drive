"""
HTTP server for cortex-os-mentalmodel tool
Exposes search_episodes_gds_by_question_tool via HTTP endpoint for Toolbox
"""

import json
import os
import asyncio
import redis as redis_lib
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from expert_tools import ExpertTools
from dotenv import load_dotenv

load_dotenv()

# Log prefix for all permission cache operations (Redis hit/miss/error)
LOG_PERM_CACHE = "[PERM-CACHE/BENTO]"

# Sync Redis client — Bento uses BaseHTTPRequestHandler (no event loop)
_redis = redis_lib.Redis.from_url(
    os.environ.get("REDIS_URL", "redis://localhost:6379"),
    decode_responses=True,
    socket_connect_timeout=1,
    socket_timeout=1,
)


def _resolve_allowed_ids_sync(user_id: str, tenant_id: str) -> list | None:
    """Resolve allowed node IDs for Bento (sync path).

    Returns None when OpenFGA is unconfigured → legacy tenant_id-only mode.
    Redis hit avoids an OpenFGA round-trip on every node-details request.
    """
    if not user_id:
        return None
    perm_key = f"perm:{user_id}"
    try:
        cached = _redis.get(perm_key)
        if cached is not None:
            return json.loads(cached)
    except Exception as e:
        print(f"{LOG_PERM_CACHE} Redis read failed: {e}")
    # Cache miss — call Permify via asyncio.run (safe: Bento has no running event loop)
    try:
        from permify_utils import list_viewable_node_ids
        allowed_ids = asyncio.run(list_viewable_node_ids(user_id))
        if allowed_ids is not None:
            _redis.setex(perm_key, 300, json.dumps(allowed_ids))
            print(f"{LOG_PERM_CACHE} miss — resolved {len(allowed_ids)} ids for user={user_id}, cached 300s")
        return allowed_ids
    except Exception as e:
        print(f"{LOG_PERM_CACHE} OpenFGA fallback failed (non-fatal): {e}")
        return None


class ToolHandler(BaseHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        """Handle POST requests to tools"""
        if self.path == "/search_episodes_gds_by_question_tool":
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length).decode("utf-8")
                params = json.loads(body)
                question = params.get("question")
                k = params.get("k", 5)
                limit = params.get("limit", 10)
                
                if not question:
                    self.send_error(400, "Missing required parameter: question")
                    return
                
                tenant_id = os.environ.get("TENANT_ID", "org_3AacpFBbt39hPmDKyZyNBQuuM6t")
                expert = ExpertTools(tenant_id=tenant_id)
                try:
                    result = expert.search_episodes_gds_by_question(question, k=k, limit=limit)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"result": result}).encode("utf-8"))
                finally:
                    expert.close()
            except Exception as e:
                self.send_error(500, f"Internal server error: {str(e)}")

        elif self.path == "/get_node_details":
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length).decode("utf-8")
                params = json.loads(body)
                # Handle both node_id and element_id for cross-compatibility
                node_id = params.get("node_id") or params.get("element_id")
                node_name = params.get("node_name")
                
                tenant_id = self.headers.get("x-tenant-id") or os.environ.get("TENANT_ID", "org_3AacpFBbt39hPmDKyZyNBQuuM6t")
                user_id = self.headers.get("x-user-id") or ""
                guest_share_anchor = self.headers.get("x-guest-share-anchor") or ""
                allowed_ids = _resolve_allowed_ids_sync(user_id, tenant_id)

                expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id,
                                     guest_share_anchor=guest_share_anchor, allowed_ids=allowed_ids)
                try:
                    result_str = expert.get_node_details(node_id=node_id, node_name=node_name)
                    result = json.loads(result_str)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps(result).encode("utf-8"))
                finally:
                    expert.close()
            except Exception as e:
                self.send_error(500, f"Internal server error: {str(e)}")
        elif self.path == "/get_composition_subtree":
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length).decode("utf-8")
                params = json.loads(body)
                root_node_id = params.get("root_node_id")
                max_depth    = int(params.get("max_depth", 5))
                if not root_node_id:
                    self.send_error(400, "root_node_id required")
                    return

                tenant_id = self.headers.get("x-tenant-id") or os.environ.get("TENANT_ID", "org_3AacpFBbt39hPmDKyZyNBQuuM6t")
                expert = ExpertTools(tenant_id=tenant_id)
                try:
                    result = expert.get_composition_subtree(root_node_id, max_depth)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps(result).encode("utf-8"))
                finally:
                    expert.close()
            except Exception as e:
                self.send_error(500, f"Internal server error: {str(e)}")

        else:
            self.send_error(404, "Not Found")
    def do_GET(self):
        """Handle GET requests (for health check)"""
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok"}).encode("utf-8"))
        else:
            self.send_error(404, "Not Found")
    
    def log_message(self, format, *args):
        """Suppress default logging"""
        pass


def main():
    # Ensure required environment variables are present
    missing = [
        name
        for name in ("NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD", "OPENAI_API_KEY")
        if not os.environ.get(name)
    ]
    if missing:
        raise RuntimeError(
            f"Missing required environment variables: {', '.join(missing)}"
        )
    
    # Default port, can be overridden by PORT environment variable
    port = int(os.environ.get("PORT", "8000"))
    server_address = ("", port)
    httpd = HTTPServer(server_address, ToolHandler)
    
    print(f"Starting cortex-os-mentalmodel HTTP server on port {port}...")
    print(f"Endpoint: http://localhost:{port}/search_episodes_gds_by_question_tool")
    httpd.serve_forever()


if __name__ == "__main__":
    main()

