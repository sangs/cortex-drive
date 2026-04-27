"""
TDD: Verify that the career timeline spans 1997-2026.

Red criteria:
  - Earliest career node must be from 1997 (NIT Bhopal education start)
  - Latest career node must be 2025 or 2026 (JPMC current work)

Uses a direct Neo4j driver query for reliable year-range detection, with a
fallback to the search tool. Handles error responses gracefully.
"""

import os
import json
import sys

# Add the src/mcp_server to the path
sys.path.append(os.path.join(os.getcwd(), "src", "mcp_server"))

try:
    from neo4j import GraphDatabase
    from expert_tools import ExpertTools

    # ---- Connection setup ----
    neo4j_uri = os.getenv("NEO4J_URI", "")
    neo4j_user = os.getenv("NEO4J_USERNAME", "neo4j")
    neo4j_pass = os.getenv("NEO4J_PASSWORD", "")
    tenant_id = os.getenv("TENANT_ID", "org_3AacpFBbt39hPmDKyZyNBQuuM6t")

    print("--- 🔍 TDD RED: Timeline Range Verification (1997-2026) ---")

    earliest = None
    latest = None

    # Strategy 1: Direct Cypher for reliable year-range detection
    try:
        driver = GraphDatabase.driver(neo4j_uri, auth=(neo4j_user, neo4j_pass))
        with driver.session() as session:
            result = session.run(
                """
                MATCH (n {tenant_id: $tid})
                WHERE n.startDate IS NOT NULL OR n.date IS NOT NULL OR n.year IS NOT NULL
                WITH coalesce(
                    toString(n.year),
                    left(toString(n.startDate), 4),
                    left(toString(n.date), 4)
                ) AS raw_year
                WHERE raw_year IS NOT NULL AND raw_year =~ '[0-9]{4}'
                WITH toInteger(raw_year) AS yr
                WHERE yr >= 1990 AND yr <= 2030
                RETURN min(yr) AS earliest, max(yr) AS latest
                """,
                tid=tenant_id,
            )
            record = result.single()
            if record:
                earliest = record["earliest"]
                latest = record["latest"]
        driver.close()
        print("📡 Connected to Neo4j directly.")
    except Exception as neo4j_err:
        print(f"⚠️  Direct Neo4j query failed ({neo4j_err}), falling back to search tool...")

    # Strategy 2: Fallback via search tool
    if earliest is None or latest is None:
        tools = ExpertTools(tenant_id=tenant_id)
        res_json = tools.search_resume_graph("career history portfolio overview")
        parsed = json.loads(res_json)

        if isinstance(parsed, dict) and "error" in parsed:
            print(f"🛑 CRITICAL ERROR: Search also failed: {parsed['error']}")
            sys.exit(1)

        results = parsed if isinstance(parsed, list) else []
        years = [
            int(r.get("year"))
            for r in results
            if isinstance(r, dict) and r.get("year") and str(r.get("year")).isdigit()
        ]

        if not years:
            print("❌ FAILURE: No years found in results.")
            sys.exit(1)

        earliest = min(years)
        latest = max(years)
        print("📡 Used search tool fallback for year range.")

    print(f"📊 Detected Year Range in Graph: {earliest} - {latest}")

    issues = 0
    if earliest is None or earliest > 1997:
        print(f"❌ FAILURE: Earliest year is {earliest}, expected 1997 (NIT Bhopal).")
        issues += 1
    else:
        print("✅ Success: 1997 data is discoverable.")

    if latest is None or latest < 2025:
        print(f"❌ FAILURE: Latest year is {latest}, expected at least 2025 (JPMC Modern).")
        issues += 1
    else:
        print(f"✅ Success: {latest} data is discoverable.")

    if latest == 2026:
        print("✅ Success: 2026 (current context) is also supported.")
    else:
        print(f"⚠️  Warning: Latest year is {latest} — 2026 is the target for current context.")

    if issues == 0:
        print("\n🎊 TDD SUCCESS: Full timeline range is supported!")
        sys.exit(0)
    else:
        print("\n❌ TDD FAILURE: Timeline range issues found.")
        sys.exit(1)

except Exception as e:
    print(f"🛑 CRITICAL ERROR: {str(e)}")
    sys.exit(1)
