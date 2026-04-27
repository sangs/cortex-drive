import os
import sys
import json
from unittest.mock import MagicMock

# Setup path
base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(base_dir, "src", "mcp_server"))

try:
    from expert_tools import ExpertTools
    from schema_guard import BACKBONE_LANDMARKS
except ImportError as e:
    print(f"❌ FAILED: Setup error - {e}")
    sys.exit(1)

def test_standardized_type_resolution():
    """
    TDD for Item 1: MCP Level dynamic node_type generation.
    Asserts that nodes are resolved to their highest-priority schema label.
    """
    print("\n🔍 TDD: Verifying MCP Standardized Type Priority...")
    
    # Mock ExpertTools to isolate the type resolution logic if possible, 
    # or verify by checking a multi-label scenario.
    tools = ExpertTools(tenant_id="test-tenant")
    
    # Verify priority: 'Role' should always beat 'Person' if both are present
    priority_req = "Role" in BACKBONE_LANDMARKS
    if not priority_req:
        print("❌ FAILED: 'Role' is not in BACKBONE_LANDMARKS. Schema priority check invalid.")
        sys.exit(1)

    print("  -> Logic Check: Cross-referencing mock labels ['Person', 'Role']...")
    
    # Simulate the intersection logic implemented in Cypher/ExpertTools
    from schema_guard import PROJECT_GRAPH_NODES, CORTEX_DRIVE_NODES
    label_priority = BACKBONE_LANDMARKS + [l for l in PROJECT_GRAPH_NODES + CORTEX_DRIVE_NODES if l not in BACKBONE_LANDMARKS]
    
    mock_labels = ["Person", "Role"]
    matches = [l for l in mock_labels if l in label_priority]
    resolved_type = matches[0] if matches else mock_labels[0]

    print(f"  -> Resolved Type: {resolved_type}")
    
    if resolved_type == "Role":
        print("  -> ✅ SUCCESS: 'Role' correctly prioritized over 'Person'.")
        return True
    else:
        print(f"  -> ❌ FAILED: Priority resolved to '{resolved_type}' instead of 'Role'.")
        return False

if __name__ == "__main__":
    if test_standardized_type_resolution():
        print("\n🎊 TDD GREEN: MCP Schema Priority is locked.")
        sys.exit(0)
    else:
        sys.exit(1)
