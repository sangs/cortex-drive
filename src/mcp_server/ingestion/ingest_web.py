import os
import sys
from dotenv import load_dotenv

# Add mcp_server root to PYTHONPATH
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ingestion_engine import IngestionEngine
from ingestion.adapters.web_url import WebUrlAdapter


def main():
    load_dotenv('.env', override=True)

    if len(sys.argv) < 2:
        print("Usage: python ingestion/ingest_web.py <url>")
        sys.exit(1)
    url = sys.argv[1]

    tenant_id = os.environ.get("DEFAULT_TENANT_ID", "test_org_123")
    owner_id = os.environ.get("OWNER_USER_ID", "")
    uri = os.environ.get("NEO4J_URI")
    user = os.environ.get("NEO4J_USERNAME")
    password = os.environ.get("NEO4J_PASSWORD")

    if not uri or not user or not password:
        print("Error: Missing Neo4j credentials. Please set NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD.")
        sys.exit(1)
    if not owner_id:
        print("Error: Missing OWNER_USER_ID. WebsiteSource nodes require an owner_id.")
        sys.exit(1)

    print(f"Registering web source: {url}")
    adapter = WebUrlAdapter(url, uri, user, password, tenant_id=tenant_id, owner_id=owner_id)

    # Fetches the URL and compares against the current SourceSnapshot's content hash —
    # returns [url] on first registration or if content changed, [] if unchanged
    # (the Iceberg-style freshness skip — see phase-a-web-url-adapter-design-2026-08-19.md).
    unprocessed = adapter.get_unprocessed_items()

    if not unprocessed:
        print("Content unchanged since last fetch — skipping re-ingestion.")
        sys.exit(0)

    engine = IngestionEngine(tenant_id=tenant_id)
    try:
        adapter.process_item(url, engine)
    except Exception as e:
        print(f"Fatal error during ingestion: {e}")
        sys.exit(1)
    finally:
        engine.close()

    print("Web ingestion complete.")


if __name__ == "__main__":
    main()
