import os
import sys
import json

# Add workspace to path
# We assume this script is run from the workspace root or from the tdd directory
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src", "mcp_server")))

from expert_tools import ExpertTools

def test_current_work():
    # Use the definitive tenant ID
    tenant_id = os.getenv("TENANT_ID", "org_3AacpFBbt39hPmDKyZyNBQuuM6t")
    expert = ExpertTools(tenant_id=tenant_id)
    
    # Test query that should trigger temporal boost
    query = "What is sangeetha currently working on?"
    print(f"--- 🔍 TDD: Deterministic Search Priority ---")
    print(f"Testing Query: {query}")
    
    res_json = expert.search_resume_graph(query)
    results = json.loads(res_json)
    
    if not results:
        print("❌ No results found!")
        return

    print(f"\nTop 5 Results (Deterministic Order):")
    for i, res in enumerate(results[:5]):
        name = res.get('name')
        boost = res.get('temporal_boost', 0)
        date = res.get('display_date', 'N/A')
        print(f"{i+1}. {name} [Boost: {boost}] [Date: {date}]")

    first_node = results[0].get('name')
    if "Cortex-Drive" in first_node:
        print("\n✅ SUCCESS: Cortex-Drive is prioritized!")
    else:
        print(f"\n❌ FAILURE: {first_node} is prioritized instead of Cortex-Drive.")

if __name__ == "__main__":
    test_current_work()
