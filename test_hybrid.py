import sys
import os
sys.path.append(os.path.join(os.getcwd(), 'src/mcp_server'))
from dotenv import load_dotenv
load_dotenv('.env', override=True)
from expert_tools import ExpertTools
import json
import traceback

print("Initializing ExpertTools...")
try:
    expert = ExpertTools(tenant_id="org_3AacpFBbt39hPmDKyZyNBQuuM6t", requesting_user_id="trial-user")
    print("Calling hybrid search for BAML...")
    res = expert.query_relevant_chunks_hybrid("BAML", top_k=10)
    print("RESULT TYPE:", type(res))
    print("RESULT CONTENT:", res[:500] if isinstance(res, str) else res)
    expert.close()
except Exception as e:
    print("CAUGHT EXCEPTION:")
    traceback.print_exc()
