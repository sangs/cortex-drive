
import json
import os
import sys

# Ensure the project source is in the path
sys.path.append(os.path.join(os.getcwd(), 'src'))
from mcp_server.expert_tools import ExpertTools

def test_domain_siloing():
    tenant_id = "test-tenant"
    # User ID that has access to both domains
    user_id = "user_3AadvqIme5F12afWwde9nv92T5R"
    
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=user_id)
    
    print("--- Test 1: Professional Domain Silo ---")
    # Expanding 'Sangeetha' in the 'professional' domain
    cluster_json = expert.get_cluster_context(node_name="Sangeetha Ramadurai", depth=2, domain="professional")
    cluster = json.loads(cluster_json)
    
    nodes = cluster.get("nodes", [])
    episodes = [n for n in nodes if n.get("type") == "Episode"]
    topics = [n for n in nodes if n.get("type") == "Topic"]
    roles = [n for n in nodes if n.get("type") == "Role"]
    
    print(f"Nodes returned: {len(nodes)}")
    print(f"Episodes found: {len(episodes)}")
    print(f"Topics found: {len(topics)}")
    print(f"Roles found: {len(roles)}")
    
    assert len(episodes) == 0, "ERROR: Business logic failure - Podcasts leaked into Professional domain!"
    assert len(topics) == 0, "ERROR: Business logic failure - Media topics leaked into Professional domain!"
    assert len(roles) > 0, "ERROR: Professional roles missing from Professional domain!"
    print("✅ SUCCESS: Professional domain is successfully siloed.")
    
    print("\n--- Test 2: Podcast Domain Silo ---")
    # Expanding 'Sangeetha' in the 'podcast' domain
    cluster_json_media = expert.get_cluster_context(node_name="Sangeetha Ramadurai", depth=2, domain="podcast")
    cluster_media = json.loads(cluster_json_media)
    
    nodes_media = cluster_media.get("nodes", [])
    episodes_media = [n for n in nodes_media if n.get("type") == "Episode"]
    
    print(f"Nodes returned: {len(nodes_media)}")
    print(f"Episodes found: {len(episodes_media)}")
    
    assert len(episodes_media) > 0, "ERROR: Media content missing from Podcast domain!"
    print("✅ SUCCESS: Podcast domain is successfully siloed.")

    expert.close()

if __name__ == "__main__":
    try:
        test_domain_siloing()
        print("\n[GREEN] ALL DOMAIN SILO TESTS PASSED.")
    except AssertionError as e:
        print(f"\n[RED] TEST FAILED: {str(e)}")
        sys.exit(1)
    except Exception as e:
        print(f"\n[RED] UNEXPECTED ERROR: {str(e)}")
        sys.exit(1)
