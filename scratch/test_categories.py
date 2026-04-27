import os
import json
import sys
from dotenv import load_dotenv

# Add src/mcp_server to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'src', 'mcp_server')))
from expert_tools import ExpertTools

load_dotenv('.env', override=True)
tenant_id = os.environ.get("TENANT_ID")
user_id = os.environ.get("OWNER_USER_ID")

expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id)
try:
    print(f"Querying for 'Sangeetha Ramadurai' with tenant={tenant_id}, user={user_id}")
    result_json = expert.get_cluster_context("Sangeetha Ramadurai", depth=2)
    data = json.loads(result_json)
    
    if "error" in data:
        print(f"ERROR: {data['error']}")
    else:
        nodes = data.get("nodes", [])
        print(f"Found {len(nodes)} nodes.")
        for node in nodes:
            print(f" - {node['name']} ({node['type']})")
        
        categories = [n['name'] for n in nodes if n.get("type") == "Category"]
        print(f"\nCategories found: {categories}")
finally:
    expert.close()
