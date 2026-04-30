#!/usr/bin/env python3
"""
seed_cortex_drive_project.py — Seeds the Cortex-Drive Project node in Neo4j.

Why this is needed (Fix #8 from gap analysis):
  Q3 ("How did Sangeetha's thought leadership influence Cortex-Drive?") requires a
  Project node named "Cortex-Drive" that is connected to Technology/Concept anchors.
  The virtual bridge discovery (connect_knowledge_on_demand) traverses:

      (ThoughtLeadership)-[:DISCUSSES]->(Technology)<-[:USES_TOOL]-(Project {name: "Cortex-Drive"})

  Without this node, Q3 has no anchor and the bridge query returns empty.
  Seeding it once is sufficient — subsequent runs are idempotent (MERGE).

Reference: federated_memory_architecture.md — "The bridge to ThoughtLeadership comes from
  shared technology nodes. The Project node IS the metadata catalog anchor."
"""

import os
import sys
from neo4j import GraphDatabase
from dotenv import load_dotenv

load_dotenv('.env', override=True)

NEO4J_URI = os.getenv("NEO4J_URI")
NEO4J_USERNAME = os.getenv("NEO4J_USERNAME", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD")
TENANT_ID = os.getenv("TENANT_ID")

if not all([NEO4J_URI, NEO4J_PASSWORD, TENANT_ID]):
    print("ERROR: NEO4J_URI, NEO4J_PASSWORD, and TENANT_ID must be set in .env")
    sys.exit(1)

CYPHER_QUERIES = [
    # 1. Core Project node
    ("""
    MERGE (p:Project {name: "Cortex-Drive", tenant_id: $tenant_id})
    ON CREATE SET
        p.type = "Project",
        p.description = "AI-powered enterprise knowledge graph with zero-trust ReBAC, MCP orchestration, and virtual cross-domain bridge discovery.",
        p.status = "Active",
        p.url = "https://github.com/sangeethavijayl/cortex-drive",
        p.created_at = datetime()
    ON MATCH SET
        p.type = "Project",
        p.status = "Active"
    RETURN p.name AS name
    """, "Cortex-Drive Project node"),

    # 2. Link to Person (identity anchor — enables direct graph traversal from Sangeetha)
    ("""
    MATCH (person:Person {tenant_id: $tenant_id})
    WHERE toLower(person.name) CONTAINS "sangeetha"
    MATCH (p:Project {name: "Cortex-Drive", tenant_id: $tenant_id})
    MERGE (person)-[:CREATED]->(p)
    RETURN person.name AS person, p.name AS project
    """, "Person → Project relationship"),

    # 3. Technology anchor nodes (shared with ThoughtLeadership articles for Q3 bridge)
    # CRITICAL: Do NOT include tenant_id in the MERGE key. Technology nodes are SYSTEM-tier
    # semantic primitives — they must match the globally-visible SYSTEM nodes seeded by
    # seed_resume_graph.py. Adding tenant_id creates org-tenant duplicates that break
    # connect_knowledge_on_demand bridge discovery (sharedAnchor comparison fails).
    ("""
    UNWIND [
        "Neo4j", "Graph Databases", "LLM", "MCP", "Vector Search",
        "AI Agent", "FastAPI", "TypeScript", "Zero Trust Architecture",
        "Knowledge Graph", "Retrieval-Augmented Generation"
    ] AS tech
    MERGE (t:Technology {name: tech})
    ON CREATE SET t.type = "Technology", t.tenant_id = 'SYSTEM', t.owner_id = 'user_SYSTEM_ADMIN'
    WITH t, tech
    MATCH (p:Project {name: "Cortex-Drive", tenant_id: $tenant_id})
    MERGE (p)-[:USES_TOOL]->(t)
    RETURN count(t) AS technologies_linked
    """, "Technology anchor links"),

    # 4. Concept anchor nodes (broader concepts that bridge to InfoQ/ThoughtLeadership content)
    # Same SYSTEM-tier rule as Technology nodes above — name-only MERGE key.
    ("""
    UNWIND [
        "AI Architecture", "Graph UX", "Metadata Orchestration",
        "Enterprise Knowledge Management", "Federated Identity",
        "Progressive Disclosure", "Semantic Search"
    ] AS concept
    MERGE (c:Concept {name: concept})
    ON CREATE SET c.type = "Concept", c.tenant_id = 'SYSTEM', c.owner_id = 'user_SYSTEM_ADMIN'
    WITH c, concept
    MATCH (p:Project {name: "Cortex-Drive", tenant_id: $tenant_id})
    MERGE (p)-[:DISCUSSES]->(c)
    RETURN count(c) AS concepts_linked
    """, "Concept anchor links"),

    # 5. IS_A taxonomy relationships — enables Tier 2 (taxonomy-expanded) bridge discovery.
    #    "AI Agent" IS_A child of "AI Architecture" — resolves the semantic gap where
    #    ThoughtLeadership tags "AI" but Cortex-Drive tags "AI Agent".
    ("""
    UNWIND [
        {child: "AI Agent", parent: "AI Architecture"},
        {child: "Graph UX", parent: "Graph Databases"},
        {child: "Retrieval-Augmented Generation", parent: "AI Architecture"},
        {child: "Semantic Search", parent: "Vector Search"},
        {child: "Federated Identity", parent: "Zero Trust Architecture"}
    ] AS rel
    MERGE (child:Concept {name: rel.child})
    ON CREATE SET child.type = "Concept", child.tenant_id = 'SYSTEM', child.owner_id = 'user_SYSTEM_ADMIN'
    MERGE (parent:Concept {name: rel.parent})
    ON CREATE SET parent.type = "Concept", parent.tenant_id = 'SYSTEM', parent.owner_id = 'user_SYSTEM_ADMIN'
    MERGE (child)-[:IS_A]->(parent)
    RETURN count(*) AS taxonomy_edges_created
    """, "IS_A taxonomy expansion edges"),

    # 6. Verify the bridge path is traversable (dry run)
    ("""
    MATCH path = (tl:ThoughtLeadership {tenant_id: $tenant_id})
                 -[:DISCUSSES|MENTIONS|HAS_TOPIC*1..2]->(anchor)
                 <-[:USES_TOOL|DISCUSSES*1..1]-(p:Project {name: "Cortex-Drive", tenant_id: $tenant_id})
    RETURN tl.name AS thought_leadership, anchor.name AS shared_anchor, p.name AS project
    LIMIT 5
    """, "Bridge path verification"),
]


def run():
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USERNAME, NEO4J_PASSWORD))
    print(f"Connected to Neo4j at {NEO4J_URI}")
    print(f"Tenant: {TENANT_ID}\n")

    with driver.session() as session:
        for cypher, label in CYPHER_QUERIES:
            print(f"  Running: {label}...")
            try:
                result = session.run(cypher, tenant_id=TENANT_ID)
                records = result.data()
                if records:
                    for r in records:
                        print(f"    → {r}")
                else:
                    print("    → (no records returned — MERGE was idempotent)")
            except Exception as e:
                print(f"    ERROR: {e}")
            print()

    driver.close()
    print("Done. Cortex-Drive project node seeded.")
    print("\nNext: ask 'How did Sangeetha thought leadership influence Cortex-Drive?'")
    print("The bridge query will traverse: ThoughtLeadership → Technology ← Project(Cortex-Drive)")


if __name__ == "__main__":
    run()
