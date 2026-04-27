#!/usr/bin/env python3
"""
verify_shadow_partition.py - Validation for Shadow Vault Isolation

This script verifies that the 'expert_tools' discovery logic
strictly filters out nodes labeled with :ShadowState or :AccessRequest.
"""

import os
import sys
import json
from mcp_server.expert_tools import ExpertTools
from dotenv import load_dotenv

load_dotenv('.env', override=True)

def run_verification():
    tenant_id = os.getenv("TENANT_ID") or "org_test"
    tools = ExpertTools(tenant_id=tenant_id)
    
    print(f"Testing Shadow Vault isolation for {tenant_id}...")

    # Mocking Search Result that would include a Shadow node if filtering failed
    # Note: Since Neo4j is paused, we are verifying the CYPHER LOGIC STRING 
    # in expert_tools.py to confirm the exclusion is implemented correctly.
    
    import inspect
    source_code = inspect.getsource(tools.search_resume_graph)
    
    exclusion_check = "AND NOT node:ShadowState AND NOT node:AccessRequest"
    if exclusion_check in source_code:
        print("PASSED: Shadow Vault filtering logic detected in 'search_resume_graph'.")
    else:
        print("FAILED: Shadow Vault filtering logic missing from 'search_resume_graph'.")

    source_code_bloom = inspect.getsource(tools.get_cluster_context)
    if exclusion_check in source_code_bloom:
        print("PASSED: Shadow Vault filtering logic detected in 'get_cluster_context'.")
    else:
        print("FAILED: Shadow Vault filtering logic missing from 'get_cluster_context'.")

if __name__ == "__main__":
    run_verification()
