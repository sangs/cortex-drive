import json
import os
import sys

# Add src to path
sys.path.append(os.path.join(os.getcwd(), 'src'))
sys.path.append(os.path.join(os.getcwd(), 'src/mcp_server'))

from expert_tools import ExpertTools

def verify():
    tenant_id = "org_3AacpFBbt39hPmDKyZyNBQuuM6t"
    tools = ExpertTools(tenant_id=tenant_id)
    tenant_id = "org_3AacpFBbt39hPmDKyZyNBQuuM6t"
    user_id = os.environ.get("OWNER_USER_ID")
    
    print("--- Verification 1: Taxonomy Recall ---")
    res1 = tools.search_enterprise_graph(
        keyword="graph databases",
        domain_intent="podcast",
        requesting_user_id=user_id,
        is_discovery_request=False
    )
    data1 = json.loads(res1)
    print(f"Found {len(data1)} results.")
    for d in data1[:3]:
        print(f"- {d.get('name')} (Type: {d.get('type')})")

    print("\n--- Verification 2: Backbone Integrity ---")
    res2 = tools.search_enterprise_graph(
        keyword="Sangeetha Ramadurai career map",
        domain_intent="professional",
        requesting_user_id=user_id,
        is_discovery_request=True
    )
    data2 = json.loads(res2)
    backbone_types = ["Company", "Startup", "Institution", "Project", "ThoughtLeadership", "Certification", "Person"]
    all_backbone = all(d.get('type') in backbone_types for d in data2)
    print(f"Backbone Integrity: {all_backbone}")
    if not all_backbone:
        offenders = [d.get('type') for d in data2 if d.get('type') not in backbone_types]
        print(f"Offending types: {set(offenders)}")
    
    print("\n--- Verification 3: The 'Aha!' Bridge ---")
    res3 = tools.search_enterprise_graph(
        keyword="influence of thought leadership on Cortex-Drive",
        domain_intent="all",
        requesting_user_id=user_id,
        is_discovery_request=False,
        is_contextual_fusion_on=True
    )
    data3 = json.loads(res3)
    cortex_node = next((d for d in data3 if d.get('name') == "Cortex-Drive"), None)
    if cortex_node and cortex_node.get('has_federated_bridge'):
        print(f"Bridge Found! Reason: {cortex_node.get('bridge_reason')}")
    else:
        print("Bridge NOT found.")

if __name__ == "__main__":
    verify()
