import os
import json
import sys
from dotenv import load_dotenv

# Add src to path for direct testing of expert_tools
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'src'))
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'src', 'mcp_server'))

from expert_tools import ExpertTools

def run_security_test():
    load_dotenv()
    
    # IDs for testing
    OWNER_ID = os.getenv("OWNER_USER_ID", "user_3AadvqIme5F12afWwde9nv92T5R")
    ATTACKER_ID = "user_malicious_attacker_999"
    TENANT_ID = os.getenv("TENANT_ID", "org_3AacpFBbt39hPmDKyZyNBQuuM6t")
    
    print("\n🛡️  STARTING G-ACL SECURITY VALIDATION...")
    
    # 1. OWNER TEST: Can the owner see their own private nodes?
    owner_tools = ExpertTools(tenant_id=TENANT_ID, requesting_user_id=OWNER_ID)
    print(f"\n[TEST 1] Testing OWNER discovery ({OWNER_ID})...")
    # Using a known node that was migrated during bootstrap (Sangeetha Ramadurai)
    owner_result = json.loads(owner_tools.get_cluster_context("Sangeetha Ramadurai"))
    
    if "nodes" in owner_result and len(owner_result["nodes"]) > 0:
        print(f"✅ PASS: Owner successfully discovered their own hub. Nodes: {len(owner_result['nodes'])}")
    else:
        print("❌ FAIL: Owner could not discover their own hub.")
        print("DEBUG OUTPUT:", json.dumps(owner_result, indent=2))
        return False

    # 2. 404 MASKING TEST: Can an attacker see the owner's hub?
    attacker_tools = ExpertTools(tenant_id=TENANT_ID, requesting_user_id=ATTACKER_ID)
    print(f"\n[TEST 2] Testing SHADOW DECEPTION (404 Masking) for attacker ({ATTACKER_ID})...")
    attacker_result = json.loads(attacker_tools.get_cluster_context("Sangeetha Ramadurai"))
    
    if "error" in attacker_result and "No context found" in attacker_result["error"]:
        print(f"✅ PASS: Attacker received generic 404. Masking works. Error: {attacker_result['error']}")
    else:
        print("❌ FAIL: Attacker discovered owner content or received 'Access Denied'.")
        print(json.dumps(attacker_result, indent=2))
        return False

    # 3. PUBLIC REALM TEST: Can both users see a PUBLIC landmark?
    print("\n[TEST 3] Testing PUBLIC REALM visibility (Neo4j)...")
    owner_public = json.loads(owner_tools.get_cluster_context("Neo4j"))
    attacker_public = json.loads(attacker_tools.get_cluster_context("Neo4j"))
    
    if "nodes" in owner_public and "nodes" in attacker_public:
        print("✅ PASS: Both users can see public structural landmarks.")
    else:
        print("❌ FAIL: Public realm nodes are not visible.")
        return False

    # 4. NO-BOUNCE FIREWALL TEST: Can attacker traverse from PUBLIC landmark into PRIVATE node?
    print("\n[TEST 4] Testing NO-BOUNCE Firewall (Landmark -> Private)...")
    # If successful, attacker's get_cluster_context("Neo4j") should NOT contain any of owner's private roles or notes
    # even if those roles are linked to Neo4j.
    attacker_nodes = attacker_public.get("nodes", [])
    private_owner_labels = ["Note", "PreparatoryNote", "Role", "Project"]
    
    unauthorized_discovery = [n for n in attacker_nodes if any(l in n["type"] for l in private_owner_labels)]
    
    if len(unauthorized_discovery) == 0:
        print("✅ PASS: No-Bounce firewall successfully jailed the attacker within the public realm.")
    else:
        print(f"❌ FAIL: NO-BOUNCE breached. Attacker discovered {len(unauthorized_discovery)} private nodes via landmark.")
        for n in unauthorized_discovery:
            print(f"   ! Leaked: {n['name']} ({n['type']})")
        return False

    print("\n⭐️ ALL G-ACL SECURITY TESTS PASSED (RED -> GREEN).")
    return True

if __name__ == "__main__":
    success = run_security_test()
    sys.exit(0 if success else 1)
