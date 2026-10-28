#!/usr/bin/env python3
"""
generate_entity_catalog.py — write the static entity catalog baked into the gateway image.

The catalog itself is built by src/mcp_server/entity_catalog.py (build_entity_catalog), the same function
Bento's POST /entity_catalog uses, so there is one query (S2-60). Since S2-60 the gateway fetches a fresh,
per-tenant catalog when a source is added; this file is only its cold-start fallback.

Run manually:
    .venv/bin/python scripts/generate_entity_catalog.py

Called automatically by:
    scripts/build-deploy-gateway.sh  (before Docker build, non-blocking)

See: documents/architecture/entity-catalog-freshness-design-2026-10-27.md
"""
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from neo4j import GraphDatabase

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT / "src" / "mcp_server"))
load_dotenv(REPO_ROOT / ".env", override=True)

from entity_catalog import build_entity_catalog  # noqa: E402

OUTPUT_PATH = REPO_ROOT / "cortex-gateway" / "config" / "entity_catalog.json"


def main():
    uri, user, password, tenant_id = (os.getenv("NEO4J_URI"), os.getenv("NEO4J_USERNAME", "neo4j"),
                                      os.getenv("NEO4J_PASSWORD"), os.getenv("TENANT_ID"))
    if not all([uri, password, tenant_id]):
        print("ERROR: NEO4J_URI, NEO4J_PASSWORD, TENANT_ID must be set in .env", file=sys.stderr)
        sys.exit(1)
    driver = GraphDatabase.driver(uri, auth=(user, password))
    try:
        catalog = build_entity_catalog(driver, tenant_id)
    finally:
        driver.close()
    OUTPUT_PATH.write_text(json.dumps(catalog, indent=2))
    print(f"✓ Entity catalog written to {OUTPUT_PATH}")
    for domain, names in catalog["domains"].items():
        print(f"  {domain}: {len(names)} entities")
    print(f"  persons: {len(catalog['persons'])} entities")
    print(f"  bridge_entities (website<->podcast): {len(catalog['bridge_entities'])}")
    print(f"  short names: {[e['short_name'] for e in catalog['entries'] if e.get('short_name')]}")


if __name__ == "__main__":
    main()
