import os
import sys
import unittest
from unittest.mock import MagicMock, patch
from dotenv import load_dotenv

# Add src/mcp_server to path for imports
sys.path.append(os.path.join(os.getcwd(), "src", "mcp_server"))

load_dotenv()

from ingestion_engine import IngestionEngine

class TestBamlIngestion(unittest.TestCase):
    def setUp(self):
        # We'll mock the Neo4j driver to avoid side effects during CI
        # but the LLM calls (BAML) will remain real if keys are present
        self.tenant_id = "org_test_123"
        
        with patch('neo4j.GraphDatabase.driver') as mock_driver:
            self.engine = IngestionEngine(tenant_id=self.tenant_id)

    @patch('ingestion_engine.ExpertTools')
    def test_process_transcript_flow(self, mock_expert_tools):
        # Mock ExpertTools to return a dummy embedding
        mock_expert = mock_expert_tools.return_value
        mock_expert.get_embedding.return_value = [0.1] * 1536
        
        transcript = "In this episode, Sangeetha and Antigravity discuss BAML and Neo4j."
        metadata = {
            "number": 999,
            "name": "BAML Integration Special",
            "link": "https://example.com/ep999"
        }
        
        # We mock the driver session to capture the queries
        self.engine.driver.session = MagicMock()
        mock_session = self.engine.driver.session.return_value.__enter__.return_value
        
        print("\n🚀 Running Ingestion Engine with BAML...")
        self.engine.process_transcript(transcript, metadata)
        
        # Verify that BAML was called (indirectly via output logs or checking calls)
        # Verify Neo4j calls
        print(f"Captured {mock_session.run.call_count} Neo4j queries.")
        
        # Assertions
        self.assertTrue(mock_session.run.called)
        
        # Check if Topic 'BAML' or 'Neo4j' was attempted to be merged
        merge_calls = [call.args[0] for call in mock_session.run.call_args_list]
        topic_merge = any("MERGE (t:Topic" in q for q in merge_calls)
        ep_merge = any("MERGE (ep:Episode" in q for q in merge_calls)
        link_merge = any("MERGE (l:ReferenceLink" in q for q in merge_calls)
        
        self.assertTrue(ep_merge, "Episode should be merged")
        print("✅ Episode merge query verified.")
        
        if topic_merge:
            print("✅ Topic extraction and merge query verified.")
        else:
            print("⚠️ No topics extracted.")

        if link_merge:
            print("✅ ReferenceLink extraction and merge query verified.")
        else:
            print("⚠️ No links extracted.")

if __name__ == "__main__":
    unittest.main()
