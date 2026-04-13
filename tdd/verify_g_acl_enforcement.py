import os
import unittest
import json
import sys

# Add the mcp_server path to sys.path so we can import ExpertTools and its local modules correctly
MODULE_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'src', 'mcp_server'))
sys.path.insert(0, MODULE_PATH)

from expert_tools import ExpertTools
from dotenv import load_dotenv

load_dotenv()

class TestGACLEnforcement(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Configuration
        cls.mismatched_tenant = "org_mismatched_test"
        cls.owner_id = os.getenv("OWNER_USER_ID")
        cls.real_tenant = os.getenv("TENANT_ID")
        
        if not cls.owner_id:
            raise ValueError("OWNER_USER_ID not found in env")

    def test_persona_a_owner_visibility_green(self):
        """
        GREEN STAGE: Verify that the owner sees results via G-ACL even if tenant_id is mismatched.
        """
        print(f"\n[GREEN] Testing Persona A (Owner) with mismatched tenant and valid user_id.")
        
        # Instantiate tools with mismatched tenant but CORRECT owner_id
        tools = ExpertTools(tenant_id=self.mismatched_tenant, requesting_user_id=self.owner_id)
        
        # Search for a term that definitely exists in the owner's graph (resume or podcast)
        results = tools.query_relevant_chunks_hybrid(question="Model Context Protocol")
        
        # In the GREEN stage, this should return results because HAS_ACCESS edges exist!
        self.assertGreater(len(results), 0, "G-ACL failed: Owner should have seen results via HAS_ACCESS path.")
        print(f"[SUCCESS] G-ACL Verification: Owner bypassed tenant mismatch via graph reachability. Found {len(results)} chunks.")
        tools.close()

    def test_get_episodes_green(self):
        """
        GREEN STAGE: Verify that listing episodes works for owner via G-ACL.
        """
        tools = ExpertTools(tenant_id=self.mismatched_tenant, requesting_user_id=self.owner_id)
        results = tools.get_episodes_with_cast()
        parsed = json.loads(results)
        
        # Should now find the 6 episodes mentioned by the user
        self.assertGreater(len(parsed), 0, "G-ACL failed: Episode list should be populated for the owner.")
        print(f"[SUCCESS] G-ACL Verification: Found {len(parsed)} episodes via owner identity.")
        tools.close()

    def test_unauthorized_blocking(self):
        """
        SECURITY: Verify that a different user with a mismatched tenant sees ZERO results.
        """
        print(f"\n[SECURITY] Testing Persona C (Unauthorized) with mismatched tenant and random user_id.")
        unauthorized_user = "user_random_123"
        tools = ExpertTools(tenant_id=self.mismatched_tenant, requesting_user_id=unauthorized_user)
        
        results = tools.query_relevant_chunks_hybrid(question="Model Context Protocol")
        self.assertEqual(len(results), 0, "Security Failure: Unauthorized user saw private data!")
        print("[SUCCESS] Security Verification: Unauthorized user was correctly blocked.")
        tools.close()

if __name__ == "__main__":
    unittest.main()
