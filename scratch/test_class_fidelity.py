import os
import json
import sys
from dotenv import load_dotenv

# Add src/mcp_server to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'src', 'mcp_server')))

from expert_tools import ExpertTools

def test():
    load_dotenv('.env', override=True)
    tenant_id = os.environ.get("TENANT_ID")
    user_id = os.environ.get("OWNER_USER_ID")
    
    print(f"--- Class Fidelity Test ---")
    print(f"Env Tenant: {tenant_id}")
    print(f"Env User: {user_id}")
    
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id)
    
    # Test discovery
    print("\nRunning get_cluster_context('Sangeetha Ramadurai')...")
    result_json = expert.get_cluster_context("Sangeetha Ramadurai")
    data = json.loads(result_json)
    
    if "error" in data:
        print(f"!!! Error Returned: {data['error']} !!!")
    
    nodes = data.get("nodes", [])
    print(f"Found {len(nodes)} nodes.")
    if len(nodes) == 0:
        print(f"Full JSON response: {result_json}")
    for n in nodes[:5]:
        print(f" - {n.get('name')} ({n.get('type')})")
        
    expert.close()

if __name__ == "__main__":
    test()
