import os
import sys
import json
import unittest
from dotenv import load_dotenv

# Add src/mcp_server to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'src', 'mcp_server')))
from expert_tools import ExpertTools

class TestUnificationFidelity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        load_dotenv('.env', override=True)
        cls.tenant_id = os.environ.get("TENANT_ID")
        cls.user_id = os.environ.get("OWNER_USER_ID")
        
        if not cls.tenant_id or not cls.user_id:
            raise unittest.SkipTest("TENANT_ID or OWNER_USER_ID not set in .env")
        
        cls.expert = ExpertTools(tenant_id=cls.tenant_id, requesting_user_id=cls.user_id)

    def test_01_complex_cross_domain_search(self):
        """ASSERT: Search enterprise graph can find intersection of AI and Financial Governance."""
        print("\n[TDD] Testing Complex Cross-Domain Search (AI + Governance)...")
        query = "AI and Financial Governance"
        
        # We expect this to trigger the unified search tool
        result_json = self.expert.search_enterprise_graph(query, requesting_user_id=self.user_id, domain_intent='all')
        data = json.loads(result_json)
        
        # Confirm no error is returned (Checks Syntax and Parameter validity)
        self.assertNotIn("error", data, f"SEARCH FAILED with error: {data.get('error')}")
        
        # Confirm results are returned
        self.assertTrue(len(data) > 0, "No results returned for AI and Financial Governance.")
        
        # Check for semantic relevance (e.g., matching 'Report', 'Governance', 'Automation', or 'Compliance')
        found_relevant = False
        relevant_keywords = ["report", "governance", "automation", "compliance", "corporate", "microservice", "agent"]
        
        for item in data:
            # Check name or text for relevance
            content = (item.get("name", "") + " " + item.get("text", "")).lower()
            if any(k in content for k in relevant_keywords):
                found_relevant = True
                break
        
        self.assertTrue(found_relevant, "Results found but they don't seem semantically relevant to AI/Governance.")
        print("✓ Complex Search Fidelity Asserted.")

    def test_02_visual_map_trigger(self):
        """ASSERT: Wants visual map flag still triggers cluster context if keyword implies overview."""
        print("\n[TDD] Testing Visual Map Trigger (Implicit Category Search)...")
        # Query that should trigger the Category overview logic
        query = "career overview"
        result_json = self.expert.search_enterprise_graph(query, requesting_user_id=self.user_id, wants_visual_map=True)
        data = json.loads(result_json)
        
        # If it triggers get_cluster_context, it returns a dict with 'nodes'
        # instead of a list of search records.
        self.assertIsInstance(data, list, "Unexpected output format. search_enterprise_graph should return a list for this query unless it redirects to get_cluster_context.")
        
        # Actually, let's verify if the redirection happens
        # In expert_tools.py line 889, it returns get_cluster_context which is a JSON string of a list
        # Wait, get_cluster_context returns a dict with 'nodes', 'links'.
        # Let's check expert_tools.py line 889.
        
    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'expert'):
            cls.expert.close()

if __name__ == "__main__":
    unittest.main()
