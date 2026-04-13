import os
import sys
import json

# Ensure we can import the MCP tools
base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(base_dir, "src", "mcp_server"))

try:
    from expert_tools import ExpertTools
except ImportError:
    print("❌ FAILED: Could not import ExpertTools. Ensure you are running from the project root.")
    sys.exit(1)

def verify_hybrid_semantic_routing():
    print("\n🔍 Verifying Hybrid Semantic Routing (RRF + Vector Fallback)...")
    
    tenant_id = os.getenv("TENANT_ID")
    if not tenant_id:
        print("❌ FAILED: TENANT_ID environment variable is missing.")
        sys.exit(1)
        
    try:
        tools = ExpertTools(tenant_id=tenant_id)
    except Exception as e:
        print(f"❌ FAILED: Could not instantiate ExpertTools. Check Neo4j/OpenAI credentials. ({e})")
        sys.exit(1)

    # 1. Test Semantic Fallback
    # The string "enterprise data systems" does not have an exact matching node name. 
    # Cypher keyword match will likely fail. The vector fallback (Cosine > 0.45) MUST hit DataMesh.
    abstract_query = "enterprise data systems"
    
    try:
        print(f"  -> Executing search_resume_graph('{abstract_query}')...")
        result_json = tools.search_resume_graph(keyword=abstract_query)
        results = json.loads(result_json)
        
        if "error" in results and isinstance(results, dict):
            print(f"❌ FAILED: Query returned an error: {results['error']}")
            sys.exit(1)
            
        if not results or len(results) == 0:
            print(f"❌ FAILED: Hybrid search found 0 results for '{abstract_query}'. Vector fallback failed.")
            sys.exit(1)
            
        # Verify that DataMesh or a structurally relevant JPMC project is found.
        names = [r.get("name", "").lower() for r in results]
        found_data = any("data" in name or "jpmc" in name or "mesh" in name for name in names)
        
        if not found_data:
            print(f"❌ FAILED: Semantic routing did not retrieve DataMesh or JPMC data nodes.")
            print("Received names:", names)
            sys.exit(1)
            
        print(f"  -> ✅ Semantic Vector fallback successfully brought back {len(results)} nodes.")
        print(f"  -> ✅ Data validation passed: Retrieved {names[0]}")
        print("\n🎊 TDD SUCCESS: Native Semantic Hybrid Search is active!")
        sys.exit(0)
        
    except Exception as e:
        print(f"❌ FAILED: Crash during semantic routing verification: {e}")
        sys.exit(1)

if __name__ == "__main__":
    verify_hybrid_semantic_routing()
