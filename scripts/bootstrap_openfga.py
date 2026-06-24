"""
Bootstrap OpenFGA tuples for existing Neo4j nodes.

Run once after deploying OpenFGA and uploading the authorization model.
Reads all private (Tier 3) nodes from Neo4j and writes OpenFGA tuples.

Usage:
  .venv/bin/python scripts/bootstrap_openfga.py \\
      --tenant-id org_XXXX \\
      --visibility tenant-wide \\
      --owner-sub user_XXXX \\
      --openfga-url http://localhost:8082

  --visibility tenant-wide  : owner tuple + tenant_viewer tuple (TENANT_A)
  --visibility owner-private : owner tuple only (TENANT_B)
"""

import argparse
import asyncio
import os
import sys

from dotenv import load_dotenv
from neo4j import GraphDatabase

# Allow importing openfga_utils from src/mcp_server
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "mcp_server"))

load_dotenv()


def fetch_private_node_ids(tenant_id: str) -> list[str]:
    """Return n.node_id (stable UUID) for all Tier-3 nodes belonging to tenant_id."""
    driver = GraphDatabase.driver(
        os.environ["NEO4J_URI"],
        auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"]),
    )
    try:
        result = driver.execute_query(
            "MATCH (n) WHERE n.tenant_id = $tenant_id AND n.node_id IS NOT NULL RETURN n.node_id AS eid",
            tenant_id=tenant_id,
        )
        return [r["eid"] for r in result.records]
    finally:
        driver.close()


async def bootstrap(tenant_id: str, owner_sub: str, visibility: str, openfga_url: str) -> None:
    os.environ["OPENFGA_API_URL"] = openfga_url

    # Import after setting env var so _get_client() picks up the URL
    from openfga_utils import register_node_owner, make_tenant_wide

    print(f"Fetching nodes for tenant_id={tenant_id} ...")
    node_ids = fetch_private_node_ids(tenant_id)
    print(f"Found {len(node_ids)} nodes. Writing OpenFGA tuples ...")

    for i, eid in enumerate(node_ids, 1):
        await register_node_owner(eid, owner_sub)
        if visibility == "tenant-wide":
            await make_tenant_wide(eid, tenant_id)
        if i % 100 == 0:
            print(f"  {i}/{len(node_ids)} done ...")

    print(f"Bootstrap complete. {len(node_ids)} nodes processed.")
    if visibility == "tenant-wide":
        print(f"  Each node: owner tuple + tenant_viewer tuple for org:{tenant_id}#member")
    else:
        print(f"  Each node: owner tuple only (owner-private)")


def main():
    parser = argparse.ArgumentParser(description="Bootstrap OpenFGA tuples from Neo4j")
    parser.add_argument("--tenant-id", required=True, help="Clerk org_id (TENANT_A or TENANT_B)")
    parser.add_argument("--owner-sub", required=True, help="Clerk user sub (OWNER_USER_ID)")
    parser.add_argument(
        "--visibility",
        choices=["tenant-wide", "owner-private"],
        default="tenant-wide",
        help="tenant-wide for TENANT_A, owner-private for TENANT_B",
    )
    parser.add_argument(
        "--openfga-url",
        default="http://localhost:8082",
        help="OpenFGA API URL (default: http://localhost:8082)",
    )
    args = parser.parse_args()

    asyncio.run(bootstrap(args.tenant_id, args.owner_sub, args.visibility, args.openfga_url))


if __name__ == "__main__":
    main()
