import asyncio
import json
from mcp_server.expert_tools import CortexGraphExpert

async def run_test():
    # Hardcode test tenant to match seed script exactly
    expert = CortexGraphExpert(tenant_id="test-tenant", schema_readable=True)
    res = await expert.search_resume_graph(keyword="education")
    print(res)
    expert.close()

if __name__ == "__main__":
    asyncio.run(run_test())
