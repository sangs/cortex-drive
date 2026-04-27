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

def verify_label_priority():
    print("\n🔍 Verifying Cypher Node Category Resolution Priority (Hackathon vs Project)...")
    
    tenant_id = os.getenv("TENANT_ID")
    if not tenant_id:
        print("❌ FAILED: TENANT_ID environment variable is missing.")
        sys.exit(1)
        
    try:
        tools = ExpertTools(tenant_id=tenant_id)
    except Exception as e:
        print(f"❌ FAILED: Could not instantiate ExpertTools. Check credentials. ({e})")
        sys.exit(1)

    query_str = "Humanless Autocode"
    print(f"  -> Executing search_resume_graph('{query_str}')...")
    
    try:
        result_json = tools.search_resume_graph(keyword=query_str)
        results = json.loads(result_json)
        
        if "error" in results and isinstance(results, dict):
            print(f"❌ FAILED: Query returned an error: {results['error']}")
            sys.exit(1)
            
        if not results or len(results) == 0:
            print("❌ FAILED: Could not find 'Humanless Autocode' node. Verify the seeder ran successfully.")
            sys.exit(1)
            
        # Verify the top result or any matching result has the correct type
        found_target = False
        for node in results:
            if "humanless" in node.get("name", "").lower():
                found_target = True
                extracted_type = node.get("type", "")
                
                print(f"  -> Found target node. Resolved Type: '{extracted_type}'")
                if extracted_type != "Hackathon":
                    print(f"❌ FAILED: Node resolution bug is present! It was resolved as '{extracted_type}' instead of 'Hackathon'.")
                    sys.exit(1)
                break
                
        if not found_target:
            print(f"❌ FAILED: 'Humanless' was not present in the results. Cannot verify label.")
            sys.exit(1)
            
        print("  -> ✅ CASE evaluation mathematically enforced specific label 'Hackathon' over 'Project'.")
        print("\n🎊 TDD SUCCESS: Label Priority is mathematically locked in Cypher.")
        sys.exit(0)
        
    except Exception as e:
        print(f"❌ FAILED: Crash during label priority verification: {e}")
        sys.exit(1)

if __name__ == "__main__":
    verify_label_priority()
