import os
import sys
from unittest.mock import MagicMock, patch
from dotenv import load_dotenv

# Add src/mcp_server to path for imports
sys.path.append(os.path.join(os.getcwd(), "src", "mcp_server"))

load_dotenv()

from ingestion_engine import IngestionEngine

def test_full_baml_ingestion():
    tenant_id = "org_test_123"
    
    # Path to the sample transcript
    transcript_path = os.path.join(os.getcwd(), "input-podcast-episodes-data", "AnthropicAndModelContextProtocol-MCP-WithDavidSoriaParra-ep1836.txt")
    
    with open(transcript_path, 'r') as f:
        transcript_text = f.read()
    
    metadata = {
        "number": 1836,
        "name": "Anthropic and Model Context Protocol (MCP) with David Soria Parra",
        "link": "https://softwareengineeringdaily.com/ep1836"
    }
    
    print("\n🚀 Starting Full BAML Ingestion Test...")
    
    with patch('neo4j.GraphDatabase.driver') as mock_driver:
        engine = IngestionEngine(tenant_id=tenant_id)
        
        # Mock the session and queries
        mock_session = MagicMock()
        engine.driver.session.return_value.__enter__.return_value = mock_session
        
        # Mock ExpertTools for embeddings
        with patch('ingestion_engine.ExpertTools') as mock_expert_tools:
            mock_expert = mock_expert_tools.return_value
            mock_expert.get_embedding.return_value = [0.1] * 1536
            
            engine.process_transcript(transcript_text, metadata)
            
    print("\n✅ Ingestion Processed.")
    
    # Verify captured queries
    queries = [call.args[0] for call in mock_session.run.call_args_list]
    
    print(f"\n📊 Extraction Results (Captured {len(queries)} Neo4j Queries):")
    
    # Check for specific relationship types
    rel_types = ["INTERVIEWED_BY", "LEARNING_FROM", "COVERS_TECHNOLOGY", "GUEST_ON", "HOSTS"]
    found_rels = []
    for q in queries:
        for rt in rel_types:
            if f":{rt}" in q:
                found_rels.append(rt)
    
    if found_rels:
        print(f"✅ Found semantic relationships in queries: {list(set(found_rels))}")
    else:
        print("⚠️ No specific semantic relationships found in captured queries.")
        
    # Check for nodes
    nodes = ["Topic", "Person", "Technology", "ReferenceLink", "Podcast"]
    found_nodes = []
    for q in queries:
        for n in nodes:
            if f":{n}" in q:
                found_nodes.append(n)
                
    print(f"✅ Found node types in queries: {list(set(found_nodes))}")

    # Print a few samples of the relationship queries
    rel_queries = [q for q in queries if "MERGE (s)-[r:" in q]
    if rel_queries:
        print("\n📝 Sample Relationship Queries:")
        for rq in rel_queries[:5]:
            print(f"  - {rq.split('MERGE')[1].strip()}")

if __name__ == "__main__":
    test_full_baml_ingestion()
