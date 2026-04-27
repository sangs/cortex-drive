
import asyncio
import os
import unittest
from unittest.mock import MagicMock, patch
import contextvars

# Mock the contextvars before importing the server
from mcp_server.cortex_os_mentalmodel_server_sse import tenant_id_var, user_id_var, mcp

# Mock ExpertTools to verify constructor calls
class TestMCPPropagation(unittest.TestCase):

    def setUp(self):
        # Reset context vars
        tenant_id_var.set("test-tenant-123")
        user_id_var.set("user-owner-456")

    @patch('mcp_server.cortex_os_mentalmodel_server_sse.ExpertTools')
    def test_get_episodes_propagation(self, MockExpert):
        # Simulate LLM calling get_episodes_with_cast_tool
        from mcp_server.cortex_os_mentalmodel_server_sse import get_episodes_with_cast_tool
        
        # We need to run the async tool in an event loop
        loop = asyncio.get_event_loop()
        loop.run_until_complete(get_episodes_with_cast_tool())
        
        # Verify ExpertTools was instantiated with the correct ID
        MockExpert.assert_called_with(
            tenant_id="test-tenant-123", 
            requesting_user_id="user-owner-456"
        )
        print("✓ get_episodes_with_cast_tool propagated identity correctly.")

    @patch('mcp_server.cortex_os_mentalmodel_server_sse.ExpertTools')
    def test_hybrid_discovery_propagation(self, MockExpert):
        from mcp_server.cortex_os_mentalmodel_server_sse import hybrid_discovery_tool
        
        loop = asyncio.get_event_loop()
        loop.run_until_complete(hybrid_discovery_tool(question="test"))
        
        MockExpert.assert_called_with(
            tenant_id="test-tenant-123", 
            requesting_user_id="user-owner-456"
        )
        print("✓ hybrid_discovery_tool propagated identity correctly.")

    @patch('mcp_server.cortex_os_mentalmodel_server_sse.ExpertTools')
    def test_get_node_details_propagation(self, MockExpert):
        from mcp_server.cortex_os_mentalmodel_server_sse import get_node_details
        
        loop = asyncio.get_event_loop()
        loop.run_until_complete(get_node_details(node_name="test-node"))
        
        MockExpert.assert_called_with(
            tenant_id="test-tenant-123", 
            requesting_user_id="user-owner-456"
        )
        print("✓ get_node_details propagated identity correctly.")

    @patch('mcp_server.cortex_os_mentalmodel_server_sse.ExpertTools')
    def test_gds_search_propagation(self, MockExpert):
        from mcp_server.cortex_os_mentalmodel_server_sse import search_episodes_gds_by_question_tool
        
        loop = asyncio.get_event_loop()
        loop.run_until_complete(search_episodes_gds_by_question_tool(question="test"))
        
        # Verify both identity AND the fix for the NameError (tenant_id)
        MockExpert.assert_called_with(
            tenant_id="test-tenant-123", 
            requesting_user_id="user-owner-456"
        )
        print("✓ search_episodes_gds_by_question_tool fixed and propagated identity correctly.")

if __name__ == "__main__":
    # Add src/mcp_server to path
    import sys
    sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'src')))
    unittest.main()
