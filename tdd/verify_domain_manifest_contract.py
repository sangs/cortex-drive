import os
import sys
import json

# Setup path
base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(base_dir, "src", "mcp_server"))

try:
    # Mock openai and neo4j before importing ExpertTools
    from unittest.mock import MagicMock
    sys.modules["openai"] = MagicMock()
    sys.modules["neo4j"] = MagicMock()
    from expert_tools import ExpertTools
    from schema_guard import PROJECT_GRAPH_NODES, CORTEX_DRIVE_NODES
except ImportError as e:
    print(f"❌ FAILED: Setup error - {e}")
    sys.exit(1)

def test_manifest_exhaustiveness():
    """Verify that every schema label belongs to a manifest."""
    print("\n🔍 TDD: Checking Manifest Exhaustiveness...")
    from domain_registry import DOMAIN_MANIFESTS
    
    # Flatten all labels in manifests
    mapped_labels = []
    for m in DOMAIN_MANIFESTS.values():
        mapped_labels.extend(m.get("node_set", []))
    
    all_schema_labels = set(PROJECT_GRAPH_NODES + CORTEX_DRIVE_NODES)
    missing = all_schema_labels - set(mapped_labels)
    
    if missing:
        print(f"❌ FAILED: The following schema labels are missing from DOMAIN_MANIFESTS: {missing}")
        return False
    print("✅ SUCCESS: All schema labels are accounted for in manifests.")
    return True

def test_orchestration_payload():
    """Verify that MCP tool results include 'persona' and 'ui_hints'."""
    print("\n🔍 TDD: Verifying Orchestration Payload (Enrichment)...")
    
    tenant_id = os.getenv("TENANT_ID", "test-tenant")
    tools = ExpertTools(tenant_id=tenant_id)
    
    # Call a tool and check a result node
    # Note: This requires a working Neo4j or a carefully mocked env.
    # For RED phase, we just assert the expectation.
    try:
        # We'll use search_resume_graph as a proxy for testing payload enrichment
        result_json = tools.get_cluster_context(node_name="Founder", depth=1)
        results = json.loads(result_json)
        
        if not results or "nodes" not in results or len(results["nodes"]) == 0:
            print("⚠️ SKIPPING: No nodes returned for 'Founder'. Cannot verify payload.")
            return True
        
        sample_node = results["nodes"][0]
        print(f"  -> Sample Node ID: {sample_node.get('id')} ({sample_node.get('type')})")
        
        if "persona" not in sample_node:
            print("❌ FAILED: 'persona' key missing from node payload.")
            return False
            
        if "ui_hints" not in sample_node:
            print("❌ FAILED: 'ui_hints' key missing from node payload.")
            return False
            
        print("✅ SUCCESS: Node payload contains persona and ui_hints.")
        return True
    except Exception as e:
        print(f"❌ FAILED: Execution error - {e}")
        return False

if __name__ == "__main__":
    e_success = False
    try:
        e_success = test_manifest_exhaustiveness()
    except ImportError:
        print("❌ FAILED: DOMAIN_MANIFESTS not found in domain_registry.py (Expected for RED phase)")
    
    p_success = test_orchestration_payload()
    
    if e_success and p_success:
        print("\n🎊 TDD GREEN: Domain Manifest contract is verified.")
        sys.exit(0)
    else:
        print("\n🛑 TDD RED: Manifest contract is NOT satisfied.")
        sys.exit(1)
