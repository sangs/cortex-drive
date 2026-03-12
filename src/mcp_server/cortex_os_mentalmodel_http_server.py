"""
HTTP server for cortex-os-mentalmodel tool
Exposes search_episodes_gds_by_question_tool via HTTP endpoint for Toolbox
"""

import json
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from expert_tools import ExpertTools


class ToolHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        """Handle POST requests to /search_episodes_gds_by_question_tool"""
        if self.path == "/search_episodes_gds_by_question_tool":
            try:
                # Read request body
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length).decode("utf-8")
                params = json.loads(body)
                
                # Extract parameters
                question = params.get("question")
                k = params.get("k", 5)
                limit = params.get("limit", 10)
                
                if not question:
                    self.send_error(400, "Missing required parameter: question")
                    return
                
                # Call the tool
                expert = ExpertTools()
                try:
                    result = expert.search_episodes_gds_by_question(question, k=k, limit=limit)
                    
                    # Return JSON response
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"result": result}).encode("utf-8"))
                finally:
                    expert.close()
                    
            except json.JSONDecodeError:
                self.send_error(400, "Invalid JSON in request body")
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

