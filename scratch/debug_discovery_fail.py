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
    query = "AI and Financial Governance"
    print(f"--- TESTING: find_episodes_by_concept('{query}') ---")
    res1 = expert.find_episodes_by_concept(query)
    print(f"Result: {res1}")

    print(f"\n--- TESTING: search_enterprise_graph('{query}', domain_intent='podcast') ---")
    res2 = expert.search_enterprise_graph(query, requesting_user_id=user_id, domain_intent='podcast')
    print(f"Result: {res2}")

    print(f"\n--- TESTING: search_enterprise_graph('{query}', domain_intent='professional') ---")
    res3 = expert.search_enterprise_graph(query, requesting_user_id=user_id, domain_intent='professional')
    print(f"Result: {res3}")

finally:
    expert.close()
