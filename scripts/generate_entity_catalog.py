#!/usr/bin/env python3
"""
generate_entity_catalog.py — Build the entity catalog for gateway intent classification.

Queries Neo4j for all node names grouped by domain signal and writes
cortex-gateway/config/entity_catalog.json.

The gateway loads this file at startup for Phase E (entity catalog lookup) of the
multi-phase intent classifier. Phase E is free and runs before the paid embedding
tier (Phase S).

Also writes a "bridge_entities" section (added 2026-08-24, see
documents/architecture/website-domain-cross-domain-routing-design-2026-08-24.md §2.2):
Concept/Technology names that are EMPIRICALLY connected to more than one domain's real
data (not a blanket re-inclusion of shared-label types — see the CAREER_LABELS/
PODCAST_LABELS/WEBSITE_LABELS comment below for why shared labels stay excluded from the
main per-domain lists). Consumed by intent_classifier.js's new pre-regex bridge check.

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
# 'website' domain (added 2026-08-24) — WebsiteSource is exclusive to it, same pattern
# as PODCAST_LABELS/CAREER_LABELS above. SourceSnapshot deliberately excluded — its
# `name`-equivalent content isn't a meaningful classification signal the way a page
# title is.
WEBSITE_LABELS = frozenset({'WebsiteSource'})

# Relationship types connecting a Concept/Technology bridge candidate back to each
# domain's anchors. Bounded variable-length (*1..2) because the actual hop shape is
# LLM-extraction-dependent for podcast (BAML's prompt says "link via Topic where
# possible," not rigidly enforced) — see the design doc §2.2 for the full rationale.
# NEEDS LIVE VERIFICATION against real graph data once Neo4j is reachable — this
# pattern is reasoned from the write-path code (ingestion_engine.py), not yet run.
BRIDGE_REL_TYPES_WEBSITE = ['COVERS_TECHNOLOGY', 'DISCUSSES']
BRIDGE_REL_TYPES_PODCAST = ['COVERS_TECHNOLOGY', 'COVERS_CONCEPT', 'HAS_TOPIC']


def main():
    if not all([NEO4J_URI, NEO4J_PASSWORD, TENANT_ID]):
        print("ERROR: NEO4J_URI, NEO4J_PASSWORD, TENANT_ID must be set in .env", file=sys.stderr)
        sys.exit(1)

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USERNAME, NEO4J_PASSWORD))
    print(f"Connecting to Neo4j at {NEO4J_URI}...")

    career_names  = set()
    podcast_names = set()
    website_names = set()
    bridge_entities: dict[str, list[str]] = {}

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
                elif labels & WEBSITE_LABELS:
                    website_names.add(name)
                # Shared/SYSTEM labels (Topic, Concept, Technology, Person, Community,
                # Publication): intentionally skipped from the per-domain lists above —
                # see the module docstring / WEBSITE_LABELS comment for why. They're
                # handled separately below, only when empirically bridging two domains.

            # Bridge-entity detection (added 2026-08-24, corrected 2026-08-25 after live
            # testing) — see design doc §2.2. Only Concept/Technology NAMES actually
            # connected to both a website anchor and a podcast anchor are included — not
            # every Concept/Technology node.
            #
            # Matches by NAME, not node identity, across the two MATCH clauses —
            # required because live testing found the same real-world concept (e.g.
            # "Apache Iceberg") can exist as TWO separate physical Technology nodes: a
            # pre-existing SYSTEM-tenant landmark (from the podcast pipeline's ontology)
            # and a newly-MERGEd org-tenant node (from this pipeline's
            # _upsert_web_entities, which follows the podcast pipeline's OWN existing
            # _upsert_baml_entities MERGE pattern faithfully — this fragmentation is a
            # pre-existing characteristic of that pattern, not introduced here). An
            # identity-based match (same query, but requiring ONE node to satisfy both
            # MATCH clauses) found zero results live despite a real, correct connection
            # existing on each side — this name-based version is the fix, verified live.
            website_rels = '|'.join(BRIDGE_REL_TYPES_WEBSITE)
            podcast_rels = '|'.join(BRIDGE_REL_TYPES_PODCAST)
            bridge_result = session.run(
                f"""
                MATCH (website_bridge) WHERE (website_bridge:Technology OR website_bridge:Concept)
                  AND website_bridge.tenant_id IN [$tenant_id, 'SYSTEM', 'PUBLIC']
                MATCH (website_bridge)-[:{website_rels}*1..2]-(:WebsiteSource)
                WITH DISTINCT website_bridge.name AS candidate_name
                MATCH (podcast_bridge) WHERE (podcast_bridge:Technology OR podcast_bridge:Concept)
                  AND podcast_bridge.name = candidate_name
                  AND podcast_bridge.tenant_id IN [$tenant_id, 'SYSTEM', 'PUBLIC']
                MATCH (podcast_bridge)-[:{podcast_rels}*1..2]-(podcast_anchor)
                WHERE podcast_anchor:Episode OR podcast_anchor:Topic OR podcast_anchor:Podcast
                RETURN DISTINCT candidate_name AS entity_name
                """,
                tenant_id=TENANT_ID
            )
            for record in bridge_result:
                name = (record['entity_name'] or '').strip()
                if name:
                    bridge_entities[name.lower()] = ['website', 'podcast']
    finally:
        driver.close()

    catalog = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "node_count": len(career_names) + len(podcast_names) + len(website_names),
        "domains": {
            "career":  sorted(career_names),
            "podcast": sorted(podcast_names),
            "website": sorted(website_names)
        },
        "bridge_entities": bridge_entities
    }

    OUTPUT_PATH.write_text(json.dumps(catalog, indent=2))
    print(f"✓ Entity catalog written to {OUTPUT_PATH}")
    print(f"  career:  {len(career_names)} entities")
    print(f"  podcast: {len(podcast_names)} entities")
    print(f"  website: {len(website_names)} entities")
    print(f"  bridge_entities (website<->podcast): {len(bridge_entities)}")
    if bridge_entities:
        for name, domains in sorted(bridge_entities.items()):
            print(f"    - {name}: {domains}")


if __name__ == '__main__':
    main()
