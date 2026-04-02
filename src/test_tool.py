import asyncio
import json
import os
from dotenv import load_dotenv
from mcp_server.expert_tools import ExpertTools

# Match the tenant ID from the seeder exactly
TEST_TENANT = "org_3AacpFBbt39hPmDKyZyNBQuuM6t"

async def run_test():
    load_dotenv('.env', override=True)
    expert = ExpertTools(tenant_id=TEST_TENANT)
    
    queries = [
        "How has Sangeetha influenced the AI engineering community and open-source agent frameworks?",
        "Show me Sangeetha's high-impact work at JPMorgan Chase. How did she modernize infra while saving costs?",
        "Summarize Sangeetha's academic foundation and specialized AI certifications.",
        "Sangeetha, introduce yourself. What is the vision behind your Cortex-Drive startup?"
    ]
    
    print(f"--- VERIFICATION START (Tenant: {TEST_TENANT}) ---")
    for q in queries:
        print(f"\nQUERY: {q}")
        
        # Verify keywords extracted by our logic
        keywords = q.lower().replace('.', '').replace(',', '').replace('?', '').split(' ')
        print(f"EXTRACTED KEYWORDS: {keywords}")
        
        res_json = expert.search_resume_graph(keyword=q)
        res = json.loads(res_json)
        
        print(f"RESULT COUNT: {len(res)}")
        if res:
            print(f"NODES FOUND: {[node['name'] for node in res]}")
        
        # Check for 'STAR' or 'Interview Note' leaks in JSON
        leaks = [node['name'] for node in res if "STAR" in node['name'] or "Interview Note" in node['name']]
        if leaks:
            print(f"❌ LEAK DETECTED in Node Names: {leaks}")
        else:
            print("✓ No 'STAR' or 'Interview' labels in node names.")
            
        # Check for key content in Query 2 (JPMC Infra)
        if "JPMorgan Chase" in q and "infra" in q:
            found_datamesh = any("DataMesh" in node['name'] or "DataMesh" in node['Details'].get('description', '') for node in res)
            if found_datamesh:
                print("✓ Found 'DataMesh' impact in JPMC results.")
            else:
                print("❌ 'DataMesh' not found in JPMC results.")

        # Check for key content in Query 3 (Education)
        if "academic" in q:
            found_edu = any(any(label in ["Degree", "Institution", "Certification"] for label in node['EntityTypes']) for node in res)
            if found_edu:
                print("✓ Found Education/Certification nodes in academic results.")
            else:
                print("❌ No Education/Certification nodes found in academic results.")

        # Print top result detail for token check
        if res:
            top = res[0]
            print(f"TOP RESULT: {top['name']} ({top['type']})")
            # print(f"DETAIL KEYS: {list(top['Details'].keys())}")
            # print(f"RELATIONSHIP COUNT: {len(top.get('relationships', []))}")
    
    expert.close()
    print("\n--- VERIFICATION COMPLETE ---")

if __name__ == "__main__":
    asyncio.run(run_test())
