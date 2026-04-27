# How to Run TDD Tests

To run the core discovery and integrity tests manually from the project root:

## 1. MCP Standard Verification
Verifies that node types are dynamically resolved based on the schema priority list.
```bash
export PYTHONPATH=$PYTHONPATH:$(pwd)/src && python3 tdd/verify_mcp_label_priority_dynamic.py
```

## 2. UI Persona Alignment Verification
Verifies that the frontend persona categories (Knowledge vs. Portfolio) are correctly mapped to backend domains.
```bash
export PYTHONPATH=$PYTHONPATH:$(pwd)/src && python3 tdd/verify_ui_domain_grouping.py
```

## 3. General Implementation Tracking
Refer to `documents/cortex_master_implementation_tracker.md` for overall project status and phase-specific TDD checkpoints.
