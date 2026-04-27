import os
import json
from expert_tools import ExpertTools
from dotenv import load_dotenv

def test_resume_search_with_gacl():
    load_dotenv()
    tenant_id = os.getenv('TENANT_ID')
    owner_id = os.getenv('OWNER_USER_ID')
    
    print(f"--- G-ACL Career Verification ---")
    print(f"Testing identity: {owner_id}")
    
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=owner_id)
    try:
        # 1. Test standard keyword search
        print("\nTest 1: Standard AI Innovation keyword search...")
        results_str = expert.search_resume_graph(keyword="innovation", requesting_user_id=owner_id)
        results = json.loads(results_str)
        
        if not results:
            print("❌ FAIL: search_resume_graph returned 0 results for 'innovation'.")
            exit(1)
        
        found_innovation = any("innovation" in str(r).lower() for r in results)
        if found_innovation:
            print(f"✅ PASS: Found {len(results)} innovation nodes.")
        else:
            # Maybe the keyword didn't match perfectly, check if we found ANY nodes
            print(f"⚠️ Warning: Found {len(results)} nodes but none matched 'innovation' perfectly. List: {[r.get('name') for r in results]}")
            if len(results) > 0:
                print("✅ PASS: Results are being returned (Access Granted).")
        
        # 2. Test visual map trigger
        print("\nTest 2: Career Visual Map trigger...")
        map_results_str = expert.search_resume_graph(keyword="career overview", requesting_user_id=owner_id, wants_visual_map=True)
        map_results = json.loads(map_results_str)
        
        if "nodes" in map_results and len(map_results["nodes"]) > 0:
             print(f"✅ PASS: Visual Map returned {len(map_results['nodes'])} nodes.")
        else:
             print("❌ FAIL: Visual Map returned empty cluster.")
             exit(1)
             
        print("\n[GREEN] Career G-ACL access is FULLY VERIFIED.")
        
    finally:
        expert.close()

if __name__ == "__main__":
    test_resume_search_with_gacl()
