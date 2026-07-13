#!/usr/bin/env python3
"""
generate_entity_catalog.py — Build the entity catalog for gateway intent classification.

Queries Neo4j for all node names grouped by domain signal and writes
cortex-gateway/config/entity_catalog.json.

The gateway loads this file at startup for Phase E (entity catalog lookup) of the
multi-phase intent classifier. Phase E is free and runs before the paid embedding
tier (Phase S).

Run manually:
    python3 scripts/generate_entity_catalog.py

Called automatically by:
    scripts/build-deploy-gateway.sh  (before Docker build, non-blocking)

See: documents/architecture/intent-classification-architecture.md
"""

import os
import sys
import json
from datetime import datetime, timezone
from pathlib import Path
from neo4j import GraphDatabase
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).parent.parent
load_dotenv(REPO_ROOT / '.env', override=True)

NEO4J_URI      = os.getenv("NEO4J_URI")
NEO4J_USERNAME = os.getenv("NEO4J_USERNAME", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD")
TENANT_ID      = os.getenv("TENANT_ID")

OUTPUT_PATH = REPO_ROOT / 'cortex-gateway' / 'config' / 'entity_catalog.json'

# Labels that unambiguously belong to one domain.
# Shared/SYSTEM labels (Topic, Concept, Technology, Person, Community, Publication)
# are intentionally excluded — they appear in multiple domains and would cause
# misclassification. Only labels that are exclusive to one domain are included.
CAREER_LABELS  = frozenset({
    'Company', 'Role', 'Project', 'Startup', 'Hackathon', 'ThoughtLeadership',
    'Degree', 'Institution', 'Certification', 'OpenSource', 'Team'
})
PODCAST_LABELS = frozenset({'Episode', 'Podcast'})


def main():
    if not all([NEO4J_URI, NEO4J_PASSWORD, TENANT_ID]):
        print("ERROR: NEO4J_URI, NEO4J_PASSWORD, TENANT_ID must be set in .env", file=sys.stderr)
        sys.exit(1)

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USERNAME, NEO4J_PASSWORD))
    print(f"Connecting to Neo4j at {NEO4J_URI}...")

    career_names  = set()
    podcast_names = set()

    try:
        with driver.session() as session:
            result = session.run(
                """
                MATCH (n)
                WHERE n.name IS NOT NULL
                  AND n.tenant_id IN [$tenant_id, 'SYSTEM', 'PUBLIC']
                RETURN n.name AS name, labels(n) AS labels
                """,
                tenant_id=TENANT_ID
            )
            for record in result:
                name   = record['name'].strip()
                labels = set(record['labels'])
                if not name:
                    continue
                if labels & CAREER_LABELS:
                    career_names.add(name)
                elif labels & PODCAST_LABELS:
                    podcast_names.add(name)
                # Shared/SYSTEM labels: intentionally skipped
    finally:
        driver.close()

    catalog = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "node_count": len(career_names) + len(podcast_names),
        "domains": {
            "career":  sorted(career_names),
            "podcast": sorted(podcast_names)
        }
    }

    OUTPUT_PATH.write_text(json.dumps(catalog, indent=2))
    print(f"✓ Entity catalog written to {OUTPUT_PATH}")
    print(f"  career:  {len(career_names)} entities")
    print(f"  podcast: {len(podcast_names)} entities")


if __name__ == '__main__':
    main()
