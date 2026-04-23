import sys
import os
sys.path.append(os.path.join(os.getcwd(), 'src/mcp_server'))
from dotenv import load_dotenv
load_dotenv('.env', override=True)
from expert_tools import ExpertTools
import json

expert = ExpertTools(tenant_id="org_3AacpFBbt39hPmDKyZyNBQuuM6t", requesting_user_id="trial-user")
query = "CALL db.index.vector.queryNodes('chunkIndex', 1, $embedding) YIELD node, score RETURN node.text LIMIT 1"
emb = expert.get_embedding("test")

print("Testing query WITHOUT keywords...")
try:
    expert.driver.execute_query(query, embedding=emb)
    print("SUCCESS")
except Exception as e:
    print(f"FAILED: {e}")

print("\nTesting query WITH keywords=[]...")
try:
    expert.driver.execute_query(query, embedding=emb, keywords=[])
    print("SUCCESS")
except Exception as e:
    print(f"FAILED: {e}")

expert.close()
