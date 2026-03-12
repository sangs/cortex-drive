# Neo4j Schema Enforcement & Guardrails Plan

This document outlines the strategy for enforcing data integrity in **CortexDrive**, specifically focusing on the `tenant_id` multi-tenancy discriminator and the core graph schema.

## 1. Consulted Documentation
- [Neo4j 5.x Cypher Manual: Constraints](https://neo4j.com/docs/cypher-manual/current/constraints/)
- [Neo4j 5.x APOC Triggers](https://neo4j.com/docs/apoc/current/background-operations/triggers/)
- [Neo4j Enterprise vs. Community Edition Comparison](https://neo4j.com/docs/operations-manual/current/introduction/#edition-details)
- [Neo4j 2026.02 Preview: Graph Types](https://neo4j.com/blog/neo4j-graph-type-preview/)

---

## 2. Relevant Constraints Matrix

| Constraint Type | Relevant Target(s) | Availability | Enforcement Purpose |
| :--- | :--- | :--- | :--- |
| **Property Existence** | `tenant_id`, `Episode.name`, `Chunk.text`, `Podcast.title`, `Person.name` | Enterprise / Aura Pro | Prevents null/missing values. |
| **Uniqueness** | `Episode.number`, `Podcast.id`, `Podcast.title` | Community / Enterprise | Prevents duplicate episodes/podcasts. |
| **Node Key** | `(tenant_id, Episode.number)`, `(tenant_id, Podcast.id)` | Enterprise / Aura Pro | Composite existence + uniqueness. |
| **Property Type** | `tenant_id` (STRING), `SimilarityScore` (FLOAT), `Episode.number` (INT) | Enterprise / Aura Pro | Ensures data type consistency. |

---

## 3. Retroactive Audit Plan
To identify issues in the existing Neo4j database, we will use a "Linter" script approach.

### Audit Queries
1. **Missing Multi-Tenancy**:
   ```cypher
   MATCH (n) 
   WHERE n.tenant_id IS NULL OR n.tenant_id = "" 
   RETURN labels(n) as Label, count(n) as MissingCount
   ```
2. **Schema Violations (Label Audit)**:
   > [!NOTE]
   > The label `Source` has been replaced by the more specific `ReferenceLink` in our implementation.
   ```cypher
   MATCH (n) 
   WHERE NOT any(label IN labels(n) WHERE label IN ['Podcast', 'Episode', 'Chunk', 'Topic', 'Concept', 'ReferenceLink', 'Person', 'Technology'])
   RETURN labels(n) as Labels, count(n) as Count
   ```
3. **Orphaned Chunks**:
   ```cypher
   MATCH (c:Chunk) 
   WHERE NOT (c)-[:BELONGS_TO_EPISODE]->(:Episode) 
   RETURN count(c) as OrphanCount
   ```

### Remediation
- Use `migrate_to_clerk_org.py` for mass tagging.
- Manually review node lists returned by Query #2 to prune test data.

---

## 4. Future Enforcement (Guardrails)

### Level 1: Database Level (Enterprise/Aura Pro)
If running on Enterprise, execute the following commands to hard-block invalid data:
```cypher
CREATE CONSTRAINT tenant_id_exists FOR (n:Episode) REQUIRE n.tenant_id IS NOT NULL;
CREATE CONSTRAINT tenant_id_exists FOR (n:Chunk) REQUIRE n.tenant_id IS NOT NULL;
CREATE CONSTRAINT episode_unique_per_tenant FOR (e:Episode) REQUIRE (e.tenant_id, e.name) IS NODE KEY;
```

### Level 2: Application Level (Community/Aura Free)
Since existence constraints are limited in Free tiers, we will implement a **Python Schema Guard**:

1. **Pre-Upsert Validation**:
   - Create a `GraphNode` Pydantic model in the backend.
   - Every ingestion tool *must* pass data through this model before generating a Cypher `MERGE`.
2. **Cypher Wrappers**:
   - Update `expert_tools.py` to use a generic `safe_merge` method that automatically injects `tenant_id` and raises a `ValueError` if required fields are missing.

### Level 3: CI/CD Guardrails
- Add a GitHub Action that runs the **Audit Queries** against the staging database before any production deployment.
