import os
import json
import time
from typing import List, Dict, Any
from openai import OpenAI
from neo4j import GraphDatabase
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
NEO4J_URI = os.environ.get("NEO4J_URI")
NEO4J_USERNAME = os.environ.get("NEO4J_USERNAME")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD")
TENANT_ID = os.environ.get("TENANT_ID", "org_3AacpFBbt39hPmDKyZyNBQuuM6t")

if not all([OPENAI_API_KEY, NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD]):
    print("Error: Missing required environment variables.")
    exit(1)

client = OpenAI(api_key=OPENAI_API_KEY)
driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USERNAME, NEO4J_PASSWORD))

MODERN_MODEL = "text-embedding-3-small"

def get_embedding(text: str) -> List[float]:
    """Get embedding using text-embedding-3-small."""
    if not text or not isinstance(text, str):
        return []
    try:
        response = client.embeddings.create(
            model=MODERN_MODEL,
            input=text
        )
        return response.data[0].embedding
    except Exception as e:
        print(f"Error getting embedding for text '{text[:50]}...': {e}")
        return []

def reindex_label(label: str, text_property: str):
    """Iterate through all nodes of a label and update their embedding."""
    print(f"\n--- Re-indexing {label} nodes (Property: {text_property}) ---")
    
    with driver.session() as session:
        # 1. Fetch all nodes with the label and tenant_id
        query = f"""
        MATCH (n:{label} {{tenant_id: $tenant_id}})
        WHERE n.{text_property} IS NOT NULL
        RETURN id(n) as id, n.{text_property} as text, size(coalesce(n.embedding, [])) as current_dim
        """
        result = session.run(query, tenant_id=TENANT_ID)
        records = list(result)
        
        print(f"Found {len(records)} nodes to process.")
        
        updated_count = 0
        skipped_count = 0
        
        for record in records:
            node_id = record["id"]
            text = record["text"]
            current_dim = record["current_dim"]
            
            # Optional: Skip if already 1536 but we want to be SURE it's text-embedding-3-small
            # For this migration, we re-embed EVERYTHING to ensure the manifold is unified.
            
            emb = get_embedding(text)
            if emb:
                update_query = "MATCH (n) WHERE id(n) = $id SET n.embedding = $emb"
                session.run(update_query, id=node_id, emb=emb)
                updated_count += 1
                if updated_count % 10 == 0:
                    print(f"  Progress: {updated_count}/{len(records)} updated...")
            else:
                skipped_count += 1
                
        print(f"Finished {label}: {updated_count} updated, {skipped_count} skipped.")

def run_migration():
    """Main migration loop."""
    start_time = time.time()
    
    # Priority 1: Semantic Chunks
    reindex_label("Chunk", "text")
    
    # Priority 2: Professional Entities (for Hybrid Search optimization)
    entities = ["Project", "Hackathon", "ThoughtLeadership", "Role", "Company", "ProfessionalEducation", "Certification"]
    for entity in entities:
        reindex_label(entity, "name")
        
    duration = time.time() - start_time
    print(f"\nMigration Complete! Total duration: {duration:.2f} seconds.")

if __name__ == "__main__":
    run_migration()
    driver.close()
