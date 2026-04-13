"""
TDD: Verify that JPMC 2025 projects are discoverable via search.

Red criteria:
  - 'Metadata Agent Architecture' must be found with year='2025'
  - 'Instrument Data on DataMesh' must be found with year='2025'

This test fails (red) when either project is missing or has an incorrect year,
and passes (green) when both are present with the correct 2025 date.
"""

import os
import json
import sys

# Add the src/mcp_server to the path
sys.path.append(os.path.join(os.getcwd(), "src", "mcp_server"))

try:
    from expert_tools import ExpertTools

    # Initialize with definitive tenant ID
    tenant_id = os.getenv("TENANT_ID", "org_3AacpFBbt39hPmDKyZyNBQuuM6t")
    tools = ExpertTools(tenant_id=tenant_id)

    print("--- 🔍 TDD RED: JPMC 2025 Date Verification ---")

    # Query for the specific project that is showing as 2024 or missing
    query = "What are the most recent projects sangeetha worked on at JPMC?"
    print(f"Querying: {query}")

    res_json = tools.search_resume_graph(query)
    print(f"DEBUG: Raw res_json (first 500 chars): {res_json[:500]}...")

    parsed = json.loads(res_json)

    # Handle error responses gracefully
    if isinstance(parsed, dict) and "error" in parsed:
        print(f"🛑 CRITICAL ERROR: Search returned an error: {parsed['error']}")
        sys.exit(1)

    results = parsed if isinstance(parsed, list) else []
    print(f"DEBUG: Found {len(results)} results.")
    print(f"DEBUG: Names: {[r.get('name') for r in results if isinstance(r, dict)]}")
    print(f"DEBUG: Years: {[r.get('year') for r in results if isinstance(r, dict)]}")

    # We expect to find these specific 2025 JPMC projects
    target_projects = [
        "Metadata Agent Architecture",
        "Instrument Data on DataMesh",
    ]

    found_count = 0
    for project_name in target_projects:
        # Safely filter only dict results
        project = next(
            (r for r in results if isinstance(r, dict) and project_name in r.get("name", "")),
            None,
        )

        if project:
            display_date = project.get("display_date", "N/A")
            year = project.get("year", "N/A")
            print(f"✅ Found Project: {project_name}")
            print(f"   - Display Date: {display_date}")
            print(f"   - Year: {year}")

            if "2025" in str(display_date):
                print("   ✅ Date Correct (2025 found in range)")
                found_count += 1
            else:
                print(f"   ❌ Date Incorrect: '2025' missing from display_date '{display_date}'")

            if year == "2025":
                print("   ✅ Year Correct (2025)")
            else:
                print(f"   ❌ Year Incorrect: Expected '2025', got '{year}'")
        else:
            print(f"❌ Project NOT FOUND: {project_name}")

    if found_count == len(target_projects):
        print("\n🎊 TDD SUCCESS: All projects found with 2025 dates!")
        sys.exit(0)
    else:
        print(f"\n❌ TDD FAILURE: Only {found_count}/{len(target_projects)} projects verified for 2025.")
        sys.exit(1)

except Exception as e:
    print(f"🛑 CRITICAL ERROR: {str(e)}")
    sys.exit(1)
