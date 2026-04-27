import os
import json
from dotenv import load_dotenv

load_dotenv("/Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/.env")

import sys
sys.path.append("/Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/src/mcp_server")
from expert_tools import ExpertTools
from domain_registry import get_anchor_labels, get_authorized_labels

tenant_id = 'org_3AacpFBbt39hPmDKyZyNBQuuM6t'
expert = ExpertTools(tenant_id=tenant_id)

keyword = "graph databases"
domain_intent = "podcast"

print(f"--- Debugging Search for: '{keyword}' (Domain: {domain_intent}) ---")

# 1. Check Anchors
anchors = get_anchor_labels(domain_intent)
print(f"Anchor Labels for {domain_intent}: {anchors}")

# 2. Check Allowed Labels
allowed = get_authorized_labels(domain_intent)
print(f"Allowed Labels for {domain_intent}: {allowed}")

# 3. Run the search and print the raw Cypher result summary
print("\nRunning search_enterprise_graph...")
results_json = expert.search_enterprise_graph(keyword=keyword, domain_intent=domain_intent)
results = json.loads(results_json)

print(f"\nFound {len(results)} results.")
for r in results:
    print(f"- {r.get('display_name')} (Type: {r.get('type')}, ID: {r.get('element_id')})")

expert.close()
