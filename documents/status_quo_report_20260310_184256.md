# CortexDrive: Database Status Quo Snapshot
**Captured at:** 2026-03-10T18:42:56.768889

## 📊 General Statistics
### Nodes
| Labels | Count |
| --- | --- |
| ['Chunk'] | 208 |
| ['ReferenceLink'] | 132 |
| ['Technology'] | 98 |
| ['Person'] | 23 |
| ['Project'] | 18 |
| ['MethodStep'] | 9 |
| ['Tool'] | 7 |
| ['Episode'] | 6 |
| ['Topic'] | 6 |
| ['Concept'] | 6 |
| ['Task'] | 6 |
| ['Objective'] | 5 |
| ['Benefit'] | 5 |
| ['SuccessCriteria'] | 5 |
| ['Podcast'] | 4 |
| ['Deliverable'] | 4 |
| ['Method'] | 3 |
| ['Milestone'] | 3 |
| ['TeamMember'] | 3 |
| ['Purpose'] | 2 |
| ['Value'] | 2 |
| ['Metric'] | 2 |
| ['Outcome'] | 2 |
| ['MeasurableResult'] | 2 |
| ['Approach'] | 2 |
| ['Plan'] | 2 |
| ['Team'] | 2 |
| ['Responsibility'] | 2 |
| ['__MetaContext__'] | 1 |
| ['Timeline'] | 1 |
| ['Role'] | 1 |

### Relationships
| Type | Count |
| --- | --- |
| SIMILAR | 4420 |
| IS_SIMILAR | 4416 |
| HAS_CHUNK | 208 |
| BELONGS_TO_EPISODE | 208 |
| HAS_REFERENCE_LINK | 145 |
| COVERS_TECHNOLOGY | 97 |
| SEMANTICALLY_SIMILAR_KNN | 12 |
| USES_TECH | 10 |
| IS_A_HOST | 10 |
| HAS_STEP | 9 |
| MENTIONED | 7 |
| IS_A_GUEST | 7 |
| HAS_EPISODE | 6 |
| HAS_TOPIC | 6 |
| COVERS_CONCEPT | 6 |
| COVERED_BY_EPISODE | 6 |
| LISTENS_TO_EPISODE | 6 |
| LEARNING_FROM | 6 |
| USES_TOOL | 6 |
| HAS_TASK | 6 |
| HAS_OBJECTIVE | 5 |
| HAS_BENEFIT | 5 |
| HAS_CRITERIA | 5 |
| SUBSCRIBES_TO | 4 |
| LISTENS_TO | 4 |
| HAS_DELIVERABLE | 4 |
| USES_METHOD | 3 |
| HAS_MILESTONES | 3 |
| INCLUDES | 3 |
| HAS_PURPOSE | 2 |
| DELIVERS | 2 |
| USES_APPROACH | 2 |
| INVOLVES | 2 |
| DEFINES_OUTCOMES | 2 |
| MEASURED_BY | 2 |
| HAS_RESULTS | 2 |
| HAS_PLAN | 2 |
| HAS_ROLE | 2 |
| RESPONSIBLE_FOR | 2 |
| GUEST_ON | 1 |
| HOSTS | 1 |
| INTERVIEWED_BY | 1 |
| HAS_TIMELINE | 1 |

## ⚠️ Schema Violations (Nodes to be Cleaned)
| Labels | Count | Sample Data (First 3) |
| --- | --- | --- |

## 🔗 Illegal Connections (To be Deleted)
| Rel Type | Count | Source | Target |
| --- | --- | --- | --- |

## ✅ Valid Schema Integrity
The following relationships exist between valid nodes and will be preserved:

| Source | Relationship | Target | Count |
| --- | --- | --- | --- |
| ['Chunk'] | BELONGS_TO_EPISODE | ['Episode'] | 208 |
| ['Topic'] | COVERED_BY_EPISODE | ['Episode'] | 6 |
| ['Topic'] | COVERS_CONCEPT | ['Concept'] | 6 |
| ['Topic'] | COVERS_TECHNOLOGY | ['Technology'] | 97 |
| ['Purpose'] | DEFINES_OUTCOMES | ['Outcome'] | 2 |
| ['Project'] | DELIVERS | ['Value'] | 2 |
| ['Person'] | GUEST_ON | ['Podcast'] | 1 |
| ['Value'] | HAS_BENEFIT | ['Benefit'] | 5 |
| ['Episode'] | HAS_CHUNK | ['Chunk'] | 208 |
| ['Outcome'] | HAS_CRITERIA | ['SuccessCriteria'] | 5 |
| ['Responsibility'] | HAS_DELIVERABLE | ['Deliverable'] | 4 |
| ['Podcast'] | HAS_EPISODE | ['Episode'] | 6 |
| ['Plan'] | HAS_MILESTONES | ['Milestone'] | 3 |
| ['Purpose'] | HAS_OBJECTIVE | ['Objective'] | 5 |
| ['Approach'] | HAS_PLAN | ['Plan'] | 2 |
| ['Project'] | HAS_PURPOSE | ['Purpose'] | 2 |
| ['Episode'] | HAS_REFERENCE_LINK | ['ReferenceLink'] | 145 |
| ['Outcome'] | HAS_RESULTS | ['MeasurableResult'] | 2 |
| ['Team'] | HAS_ROLE | ['Role'] | 2 |
| ['Method'] | HAS_STEP | ['MethodStep'] | 9 |
| ['Responsibility'] | HAS_TASK | ['Task'] | 6 |
| ['Plan'] | HAS_TIMELINE | ['Timeline'] | 1 |
| ['Episode'] | HAS_TOPIC | ['Topic'] | 6 |
| ['Person'] | HOSTS | ['Podcast'] | 1 |
| ['Team'] | INCLUDES | ['TeamMember'] | 3 |
| ['Person'] | INTERVIEWED_BY | ['Person'] | 1 |
| ['Project'] | INVOLVES | ['Team'] | 2 |
| ['Person'] | IS_A_GUEST | ['Episode'] | 7 |
| ['Person'] | IS_A_HOST | ['Episode'] | 6 |
| ['Person'] | IS_A_HOST | ['Podcast'] | 4 |
| ['Episode'] | IS_SIMILAR | ['Technology'] | 49 |
| ['Episode'] | IS_SIMILAR | ['Episode'] | 6 |
| ['Chunk'] | IS_SIMILAR | ['Chunk'] | 2056 |
| ['Episode'] | IS_SIMILAR | ['Concept'] | 5 |
| ['ReferenceLink'] | IS_SIMILAR | ['Chunk'] | 1234 |
| ['ReferenceLink'] | IS_SIMILAR | ['ReferenceLink'] | 86 |
| ['Topic'] | IS_SIMILAR | ['Chunk'] | 50 |
| ['Topic'] | IS_SIMILAR | ['Topic'] | 9 |
| ['Concept'] | IS_SIMILAR | ['Technology'] | 57 |
| ['Technology'] | IS_SIMILAR | ['Concept'] | 86 |
| ['Technology'] | IS_SIMILAR | ['Technology'] | 740 |
| ['Concept'] | IS_SIMILAR | ['Episode'] | 2 |
| ['Technology'] | IS_SIMILAR | ['Episode'] | 11 |
| ['Chunk'] | IS_SIMILAR | ['ReferenceLink'] | 24 |
| ['Topic'] | IS_SIMILAR | ['ReferenceLink'] | 1 |
| ['Person'] | LEARNING_FROM | ['Episode'] | 6 |
| ['Person'] | LISTENS_TO | ['Podcast'] | 4 |
| ['Person'] | LISTENS_TO_EPISODE | ['Episode'] | 6 |
| ['Value'] | MEASURED_BY | ['Metric'] | 2 |
| ['Person'] | MENTIONED | ['Technology'] | 6 |
| ['Person'] | MENTIONED | ['Tool'] | 1 |
| ['Role'] | RESPONSIBLE_FOR | ['Responsibility'] | 2 |
| ['Episode'] | SEMANTICALLY_SIMILAR_KNN | ['Episode'] | 12 |
| ['Episode'] | SIMILAR | ['ReferenceLink'] | 40 |
| ['Episode'] | SIMILAR | ['Topic'] | 6 |
| ['Chunk'] | SIMILAR | ['Chunk'] | 2056 |
| ['Episode'] | SIMILAR | ['Concept'] | 1 |
| ['Episode'] | SIMILAR | ['Technology'] | 13 |
| ['ReferenceLink'] | SIMILAR | ['ReferenceLink'] | 1292 |
| ['Topic'] | SIMILAR | ['Concept'] | 4 |
| ['Topic'] | SIMILAR | ['Technology'] | 30 |
| ['Concept'] | SIMILAR | ['Technology'] | 57 |
| ['Technology'] | SIMILAR | ['Concept'] | 53 |
| ['Technology'] | SIMILAR | ['Technology'] | 768 |
| ['Technology'] | SIMILAR | ['Topic'] | 19 |
| ['Topic'] | SIMILAR | ['ReferenceLink'] | 19 |
| ['Concept'] | SIMILAR | ['Topic'] | 3 |
| ['ReferenceLink'] | SIMILAR | ['Chunk'] | 28 |
| ['Topic'] | SIMILAR | ['Chunk'] | 6 |
| ['Chunk'] | SIMILAR | ['ReferenceLink'] | 24 |
| ['Topic'] | SIMILAR | ['Episode'] | 1 |
| ['Person'] | SUBSCRIBES_TO | ['Podcast'] | 4 |
| ['Project'] | USES_APPROACH | ['Approach'] | 2 |
| ['Plan'] | USES_METHOD | ['Method'] | 3 |
| ['Project'] | USES_TECH | ['Technology'] | 10 |
| ['Plan'] | USES_TOOL | ['Tool'] | 6 |
