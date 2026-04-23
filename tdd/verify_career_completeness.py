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
    
    print("--- 🌍 FINAL FIDELITY DIAGNOSTIC: Career Completeness ---")
    
    # 1. Test Search for Map (Is Cortex-Drive there?)
    search_res = tools.get_cluster_context(node_name="Sangeetha Ramadurai")
    data = json.loads(search_res)
    
    if "nodes" in data:
        nodes = data["nodes"]
        names = [n["name"] for n in nodes]
        print(f"📦 Total Nodes in Map: {len(nodes)}")
        
        # Check Cortex-Drive
        cortex = next((n for n in nodes if n.get("name") and "Cortex-Drive" in n["name"]), None)
        if cortex:
            print(f"✅ Cortex-Drive Found: {cortex.get('display_date', 'No Date')}")
        else:
            print("❌ FAILURE: Cortex-Drive is MISSING from the map.")
            
        # Check Volarisation
        volar = next((n for n in nodes if n.get("name") and "Volarisation" in n["name"]), None)
        if volar:
            print(f"✅ Volarisation Found: {volar.get('display_date', 'No Date')} (Year: {volar.get('year', 'No Year')})")
        else:
            print("❌ FAILURE: Volarisation Engine is MISSING from the map.")
            
        # Check JPMC VP
        vp = next((n for n in nodes if n.get("name") and "VP" in n["name"]), None)
        if vp:
            print(f"✅ JPMC VP Found: {vp.get('display_date', 'No Date')}")
            
    else:
        print(f"❌ ERROR: Cluster Context failed to return nodes.")

except Exception as e:
    print(f"🛑 CRITICAL ERROR: {str(e)}")
