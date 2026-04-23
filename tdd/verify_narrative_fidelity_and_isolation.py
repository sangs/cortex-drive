import os
import sys
import json
import unittest
from dotenv import load_dotenv

# Add src/mcp_server to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'src', 'mcp_server')))
from expert_tools import ExpertTools

class TestNarrativeFidelity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        load_dotenv('.env', override=True)
        cls.tenant_id = os.environ.get("TENANT_ID")
        cls.user_id = os.environ.get("OWNER_USER_ID")
        
        if not cls.tenant_id or not cls.user_id:
            raise unittest.SkipTest("TENANT_ID or OWNER_USER_ID not set in .env")
        
        cls.expert = ExpertTools(tenant_id=cls.tenant_id, requesting_user_id=cls.user_id)

    def test_01_resume_search_isolation(self):
        """ASSERT: Resume search MUST NOT leak podcast domain nodes."""
        print("\n[TDD] Testing Domain Isolation (Resume vs Podcast)...")
        # Query specifically for career overview
        result_json = self.expert.search_enterprise_graph("professional career overview", requesting_user_id=self.user_id, wants_visual_map=True)
        data = json.loads(result_json)
        
        # Check both the direct records and the cluster context if returned
        nodes = data.get("nodes", []) if isinstance(data, dict) else []
        self.assertTrue(len(nodes) > 0 or len(data) > 0, "No nodes returned for career overview.")
        
        # Check for leakage in nodes
        leaked_labels = {"Episode", "Podcast", "Chunk", "Topic"}
        found_leaks = []
        for node in nodes:
            if node.get("type") in leaked_labels:
                found_leaks.append(f"{node['name']} ({node['type']})")
        
        self.assertEqual(len(found_leaks), 0, f"DOMAIN LEAK DETECTED (Resume Search): {found_leaks}")
        print("✓ Domain Isolation Asserted.")

    def test_01b_broad_identity_isolation(self):
        """ASSERT: get_cluster_context MUST filter seed node by domain."""
        print("\n[TDD] Testing Broad Identity Isolation (Seed Node Filter)...")
        # Query for 'Sangeetha' which exists in BOTH silos
        # Domain set to professional should NOT return the Podcast 'Sangeetha' node
        result_json = self.expert.get_cluster_context("Sangeetha", domain="professional", backbone_only=True)
        data = json.loads(result_json)
        
        nodes = data.get("nodes", [])
        self.assertTrue(len(nodes) > 0, "No nodes returned for 'Sangeetha' query.")
        
        leaked_labels = {"Episode", "Podcast", "Chunk"}
        found_leaks = []
        for node in nodes:
            if node.get("type") in leaked_labels:
                found_leaks.append(f"{node['name']} ({node['type']})")
        
        self.assertEqual(len(found_leaks), 0, f"DOMAIN LEAK DETECTED (Broad Identity): {found_leaks}")
        print("✓ Broad Identity Isolation Asserted.")

    def test_02_narrative_fidelity_unjailing(self):
        """ASSERT: Narrative text MUST NOT be truncated (Full STAR support)."""
        print("\n[TDD] Testing Narrative Fidelity (Unjailing)...")
        # Search for a known STAR-rich node: Cortex-Drive
        result_json = self.expert.search_enterprise_graph("Cortex-Drive", requesting_user_id=self.user_id)
        data = json.loads(result_json)
        
        # In search, narrative is often in the 'text' field of the record
        # but let's check the descriptions in 'nodes' if it was a cluster context
        found_star = False
        star_keywords = ["Situation", "Task", "Action", "Result"]
        
        # If it's the recursive search output (list of records)
        if isinstance(data, list):
            print(f"[DEBUG] Search returned {len(data)} records for Cortex-Drive.")
            for record in data:
                text = record.get("text", "")
                name = record.get("name", "Unknown")
                print(f"  - Record: {name}, Text Length: {len(text)}")
                if len(text) > 0:
                    print(f"    Sample: {text[:100]}...")
                if all(word in text for word in star_keywords):
                    found_star = True
                    self.assertTrue(len(text) > 200, f"Narrative truncated! Length: {len(text)}")
        
        self.assertTrue(found_star, "STAR framework missing from narrative response.")
        print("✓ Narrative Fidelity Asserted.")

    def test_03_backbone_presence(self):
        """ASSERT: Discovery MUST return Category nodes (The Spine)."""
        print("\n[TDD] Testing Backbone Presence (Categories)...")
        result_json = self.expert.get_cluster_context("Sangeetha Ramadurai", depth=2)
        data = json.loads(result_json)
        
        nodes = data.get("nodes", [])
        categories = [n['name'] for n in nodes if n.get("type") == "Category"]
        
        self.assertTrue(len(categories) > 0, "Backbone 'Category' nodes missing from discovery.")
        print(f"✓ Backbone Asserted. Found: {categories}")

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'expert'):
            cls.expert.close()

if __name__ == "__main__":
    unittest.main()
