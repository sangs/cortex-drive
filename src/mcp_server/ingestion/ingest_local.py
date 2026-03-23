import os
import sys
from dotenv import load_dotenv

# Add mcp_server root to PYTHONPATH
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ingestion_engine import IngestionEngine
from ingestion.adapters.local_file import LocalFileAdapter

def main():
    # Attempt to load the standard Neo4j env vars
    load_dotenv('.env', override=True)
    
    # Defaults to creating a folder in the project root if missing
    project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    default_dir = os.path.join(project_root, "episode_data")
    
    transcript_dir = os.environ.get("TRANSCRIPT_DIR", default_dir)
    tenant_id = os.environ.get("DEFAULT_TENANT_ID", "test_org_123")
    uri = os.environ.get("NEO4J_URI")
    user = os.environ.get("NEO4J_USERNAME")
    password = os.environ.get("NEO4J_PASSWORD")
    
    if not uri or not user or not password:
        print("Error: Missing Neo4j credentials. Please set NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD.")
        sys.exit(1)
        
    print(f"Scanning directory: {transcript_dir}")
    adapter = LocalFileAdapter(transcript_dir, uri, user, password, tenant_id=tenant_id)
    
    # Filter out files that already have Source nodes
    unprocessed = adapter.get_unprocessed_items()
    
    if not unprocessed:
        print("Everything is up to date! No new .txt files found.")
        sys.exit(0)
        
    print(f"Found {len(unprocessed)} new files to ingest.")
    
    # Boot up the heavy ingestion engine
    engine = IngestionEngine(tenant_id=tenant_id)
    try:
        for file_path in unprocessed:
            print(f"--- Enqueuing: {os.path.basename(file_path)}")
            adapter.process_item(file_path, engine)
    except Exception as e:
        print(f"Fatal error during ingestion: {e}")
        sys.exit(1)
    finally:
        engine.close()
        
    print("Ingestion batch complete.")

if __name__ == "__main__":
    main()
