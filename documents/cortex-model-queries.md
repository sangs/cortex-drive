# CortexModel Cypher Query Reference

This document compiles the Cypher queries used across the CortexModel project for auditing, ingestion, analysis, and retrieval. These queries can be used for manual verification in the Neo4j Browser or for building new tools.

## 🛠 Administrative & Schema Queries

### Check Database Schema
```cypher
CALL db.schema.visualization()
```

### Protect MetaContext Infrastructure
```cypher
MATCH (n:__MetaContext__)
RETURN n.name, n.description
```

### Audit Inconsistent Tenant IDs
```cypher
MATCH (n) 
WHERE n.tenant_id IS NULL AND NOT n:__MetaContext__
RETURN labels(n) as Type, count(*) as Count
```

### Cleanup: Purge Non-Schema Nodes
```cypher
MATCH (n)
WHERE NOT labels(n)[0] IN ['Episode', 'Topic', 'Concept', 'Technology', 'Chunk', 'ReferenceLink', 'Person', '__MetaContext__']
DETACH DELETE n
```

---

## 📥 Ingestion & Data Population

### Upsert Episode
```cypher
MERGE (ep:Episode {tenant_id: $tenant_id, number: $number})
SET ep += $props
```

### Atomic Chunk Injection
```cypher
MATCH (ep:Episode {tenant_id: $tenant_id, number: $ep_num})
MERGE (c:Chunk {tenant_id: $tenant_id, order: $order, fileName: $fileName})
SET c.text = $text, c.embedding = $embedding, c.fileSource = $fileSource
MERGE (ep)-[:HAS_CHUNK]->(c)
MERGE (c)-[:BELONGS_TO_EPISODE]->(ep)
```

---

## 📊 Graph Analysis (GDS)

### Check GDS Availability
```cypher
RETURN gds.version()
```

### Project Graph for Similarity Analysis
```cypher
CALL gds.graph.project(
    'topicGraph',
    ['Episode', 'Topic'],
    ['HAS_TOPIC']
)
YIELD graphName, nodeCount, relationshipCount
```

### Compute Episode Similarity (Node Similarity)
```cypher
CALL gds.nodeSimilarity.stream('topicGraph')
YIELD node1, node2, similarity
WITH gds.util.asNode(node1) AS ep1, gds.util.asNode(node2) AS ep2, similarity
WHERE ep1.number = $episode_number
RETURN ep2.number AS similar_episode_number, ep2.name AS similar_episode_name, similarity
ORDER BY similarity DESC
LIMIT 5
```

---

## 🔍 Vector & Semantic Search

### List Vector Indexes
```cypher
SHOW VECTOR INDEXES
```

### Vector Search (Standard)
```cypher
CALL db.index.vector.queryNodes(
    'chunkIndex',
    $k,
    $questionEmbedding
)
YIELD node AS chunk, score
MATCH (episode:Episode)<-[:BELONGS_TO_EPISODE]-(chunk)
RETURN episode.name AS EpisodeTitle, chunk.text AS Content, score
ORDER BY score DESC
```

### Hybrid Vector Search + KNN Relationships
```cypher
CALL db.index.vector.queryNodes('chunkIndex', $k, $questionEmbedding)
YIELD node AS chunk, score AS indexScore
MATCH (seedEpisode:Episode {tenant_id: $tenant_id})<-[:BELONGS_TO_EPISODE]-(chunk)
OPTIONAL MATCH (seedEpisode)-[r:SEMANTICALLY_SIMILAR_KNN]->(similarEpisode:Episode)
RETURN seedEpisode.name AS Seed, similarEpisode.name AS Similar, r.knn_score AS KnnScore
ORDER BY indexScore DESC, KnnScore DESC
LIMIT 10
```

---

## 🧠 Business Logic Tools (Expert Tools)

### Find Episodes by Topic/Keywords
```cypher
MATCH (e:Episode {tenant_id: $tenant_id})-[:HAS_TOPIC]->(t:Topic)
WHERE toLower(t.name) CONTAINS toLower($question) OR 
      toLower(e.name) CONTAINS toLower($question)
RETURN DISTINCT e.name, e.number, collect(t.name) AS topics
ORDER BY e.number DESC
```

### Find Episodes by People & Roles
```cypher
MATCH (p:Person)-[r]-(e:Episode {tenant_id: $tenant_id})
WHERE toLower(p.name) CONTAINS toLower($question)
RETURN DISTINCT p.name, type(r) AS Role, e.name AS Episode, e.number AS EpisodeNumber
ORDER BY EpisodeNumber DESC
```

### Find Episodes by Concept
```cypher
MATCH (e:Episode {tenant_id: $tenant_id})-[:HAS_TOPIC]->(t:Topic)-[:COVERS_CONCEPT]->(c:Concept)
WHERE toLower(c.name) CONTAINS toLower($question)
RETURN DISTINCT e.name, e.number AS EpisodeNumber, t.name AS Topic, c.name AS Concept
ORDER BY EpisodeNumber DESC
```
