import os
import json
import sys

# Add the src/mcp_server to the path
sys.path.append(os.path.join(os.getcwd(), 'src', 'mcp_server'))

try:
    from expert_tools import ExpertTools
    
    # Initialize with environment variables
    tenant_id = os.getenv("TENANT_ID", "org_3AacpFBbt39hPmDKyZyNBQuuM6t")
    tools = ExpertTools(tenant_id=tenant_id)
    
    print("--- 🔍 HIGH-FIDELITY DIAGNOSTIC: Volarisation Engine ---")
    
    # Test Cluster Context (The Graphball View)
    cluster_res = tools.get_cluster_context(node_name="Volarisation")
    cluster_data = json.loads(cluster_res)
    
    if "nodes" in cluster_data:
        volar_node = next((n for n in cluster_data["nodes"] if "Volarisation" in n["name"]), None)
        if volar_node:
            print(f"✅ Found Volarisation Node in Graph View")
            # Assert Links
            links = volar_node.get("links", [])
            print(f"🔗 Resource Links Count: {len(links)}")
            for l in links:
                print(f"   - {l}")
            
            if len(links) > 1:
                print("✨ SUCCESS: Multi-Source Link Fusion is working (node.links + ReferenceLinks).")
            else:
                 print("❌ FAILURE: Only one link found. Target is 3+.")

            # Assert Narrative
            text = volar_node.get("text", "")
            print(f"📝 Narrative Length: {len(text)} characters")
            if len(text) > 50:
                print("✨ SUCCESS: STAR Narrative found and sanitized.")
                print(f"   Preview: {text[:100]}...")
            else:
                print("❌ FAILURE: Narrative is empty or too short.")

    else:
        print(f"❌ ERROR: Could not find Volarisation node in context: {cluster_res}")

except Exception as e:
    print(f"🛑 CRITICAL ERROR: {str(e)}")
