import os
import json
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'src', 'mcp_server')))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.mcp_server.expert_tools import ExpertTools
from neo4j import GraphDatabase

def main():
    tenant_id = os.getenv('TENANT_ID')
    if not tenant_id:
        print("❌ TENANT_ID not set. Check your .env file.")
        sys.exit(1)

    tools = ExpertTools(tenant_id)

    print("Running verify_progressive_hydration_TDD...")
    
    # Test DataMesh (We know it has Tool/URL/Note)
    node_name = "DataMesh"
    result_str = tools.get_node_details(node_name)
    result = json.loads(result_str)

    if 'message' in result and 'not found' in result['message']:
        print(f"❌ Failed to find node {node_name}")
        sys.exit(1)
    
    techs = result.get('technologies', [])
    notes = result.get('narratives', [])
    
    if len(techs) == 0:
        print("❌ TDD Failed: No technologies extracted for DataMesh by get_node_details.")
        sys.exit(1)
        
    if len(notes) == 0 or len(notes[0]) < 10:
        print("❌ TDD Failed: No extensive PreparatoryNote extracted for DataMesh by get_node_details.")
        sys.exit(1)
        
    print("✅ TDD Passed: Tech stack and deep notes successfully extracted via progressive hydration query.")
    print(f"   -> Found {len(techs)} technologies (e.g., {techs[:3]})")
    print(f"   -> Found narrative note length: {len(notes[0])}")
    
if __name__ == "__main__":
    main()
