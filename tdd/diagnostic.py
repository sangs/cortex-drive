import os
import json
import sys

# Add the src/mcp_server to the path
sys.path.append(os.path.join(os.getcwd(), 'src', 'mcp_server'))

try:
    from expert_tools import ExpertTools
    
    # Initialize with environment variables
    # (Assuming .env is loaded or vars are in environment)
    tools = ExpertTools()
    
    print("--- DIAGNOSTIC: search_resume_graph('Volarisation') ---")
    search_res = tools.search_resume_graph(keyword="Volarisation")
    search_data = json.loads(search_res)
    if search_data and isinstance(search_data, list):
        node = search_data[0]
        print(f"Node Name: {node.get('name')}")
        print(f"Links found: {node.get('links')}")
        print(f"Text (Narrative) length: {len(node.get('text', ''))}")
        print(f"Text Snippet: {node.get('text', '')[:100]}...")
    
    print("\n--- DIAGNOSTIC: get_cluster_context('Volarisation') ---")
    cluster_res = tools.get_cluster_context(node_name="Volarisation")
    cluster_data = json.loads(cluster_res)
    if cluster_data and 'nodes' in cluster_data:
        # Find the node itself in the cluster
        for n in cluster_data['nodes']:
            if "Volarisation" in n.get('name', ''):
                print(f"Node Name: {n.get('name')}")
                print(f"Links found: {n.get('links')}")
                print(f"Text (Narrative) length: {len(n.get('text', ''))}")
                break

except Exception as e:
    print(f"ERROR: {str(e)}")
