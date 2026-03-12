# Neo4j Data Cleanup & Migration Plan

This plan outlines the strategy to align existing Neo4j data with the defined CortexDrive schema (`Podcast`, `Episode`, `Chunk`, `Topic`, `Concept`, `ReferenceLink`, `Person`, `Technology`) without data loss.

## Migration Principles
- **Label Alignment**: Convert legacy labels (like `Source`) to schema-compliant labels.
- **Relational Preservation**: Ensure that when a label changes, existing relationships (like `HAS_TOPIC`) remain intact.
- **Property Consolidation**: Move relevant metadata from "illegal" nodes to their schema-compliant counterparts.
- **Dry-Run First**: Always audit the impact before running destructive `DELETE` or `DETACH DELETE` commands.

## Step 1: Mapping Legacy Data
Based on the project history, the most likely non-compliant nodes are:
- `Source` nodes (should be `ReferenceLink`)
- `Keyword` or `Entity` nodes (should be `Technology` or `Concept`)
- Generic `Metadata` nodes (should be properties on `Episode` or `Chunk`)

## Step 2: Migration Cypher Queries

### A. Migrating `Source` to `ReferenceLink`
If you have nodes labeled `Source` that serve as external links:
```cypher
MATCH (n:Source)
REMOVE n:Source
SET n:ReferenceLink
RETURN count(n) as MigratedCount
```

### B. Consolidating Generic Entities
If LLM extraction created generic `Entity` nodes that should be `Topic`:
```cypher
MATCH (n:Entity)
WHERE n.type = 'topic'
REMOVE n:Entity
SET n:Topic
RETURN count(n) as MigratedCount
```

### C. Merging Redundant Nodes
If you have duplicate info across different labels (requires APOC):
```cypher
MATCH (old:Source), (new:ReferenceLink)
WHERE old.url = new.url
CALL apoc.refactor.mergeNodes([new, old], {properties:"combine", mergeRels:true})
YIELD node
RETURN count(node)
```

## Step 3: Safe Pruning (The Cleanup)

### A. Identify and Review
Run this query to list everything that *doesn't* fit the schema:
```cypher
MATCH (n)
WHERE NOT any(label IN labels(n) WHERE label IN ['Podcast', 'Episode', 'Chunk', 'Topic', 'Concept', 'ReferenceLink', 'Person', 'Technology'])
RETURN labels(n), keys(n), count(n)
```

### B. Delete with Caution
Only once you've verified a label is truly "junk" (e.g., `TestNode`, `OldBackup`):
```cypher
MATCH (n)
WHERE labels(n) = ['JunkLabel']
DETACH DELETE n
```

## Step 4: Final Validation
Run the Audit Script to ensure 100% compliance:
```bash
python3 audit_model.py --mode audit
```
