import os
import json
import sys

# Ensure we can import from src/mcp_server
sys.path.append(os.path.join(os.getcwd(), 'src', 'mcp_server'))

try:
    from expert_tools import ExpertTools
    from dotenv import load_dotenv
    load_dotenv()

    tenant_id = os.environ.get("TENANT_ID")
    uid = os.environ.get("OWNER_USER_ID")
    
    print(f"--- Trace Starting ---")
    print(f"User: {uid}")
    print(f"Tenant: {tenant_id}")
    
    expert = ExpertTools(tenant_id, uid)
    
    # 1. Search for Cortex-Drive exactly as the TDD does.
    print(f"Triggering search for 'Cortex-Drive'...")
    res = expert.search_resume_graph("Cortex-Drive", uid)
    
    data = json.loads(res)
    if "error" in data:
        print(f"ERROR RETURNED: {data['error']}")
    else:
        print(f"Found {len(data)} records.")
        for i, rec in enumerate(data):
            print(f"[{i}] Name: {rec.get('name')}, Type: {rec.get('type')}")
            text = rec.get("text", "")
            print(f"    Text Length: {len(text)}")
            if "Situation" in text:
                print(f"    ✓ STAR Framework detected in text.")
            else:
                print(f"    ✗ STAR Framework missing.")
            if i == 0:
                print(f"    Full Text Sample: {text[:200]}...")

    expert.close()

except Exception as e:
    print(f"Trace failed with Exception: {e}")
