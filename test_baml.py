import sys
import os
sys.path.append(os.path.join(os.getcwd(), 'src/mcp_server'))
from dotenv import load_dotenv
load_dotenv('.env', override=True)
from expert_tools import ExpertTools
import json

expert = ExpertTools(tenant_id="org_3AacpFBbt39hPmDKyZyNBQuuM6t", requesting_user_id="trial-user")
res = expert.search_episodes_by_question("BAML", k=2)
print(res)
expert.close()
