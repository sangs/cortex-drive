# CortexDrive: Database Status Quo Snapshot
**Captured at:** 2026-03-10T16:59:21.278209

## 📊 General Statistics
### Nodes
| Labels | Count |
| --- | --- |
| ['Chunk'] | 208 |
| ['ReferenceLink'] | 132 |
| ['Technology'] | 98 |
| ['Person'] | 23 |
| ['Project'] | 18 |
| ['Company'] | 16 |
| ['Organization'] | 10 |
| ['Field'] | 10 |
| ['Engine'] | 9 |
| ['MethodStep'] | 9 |
| ['Programming language'] | 7 |
| ['Tool'] | 7 |
| ['Episode'] | 6 |
| ['Topic'] | 6 |
| ['Concept'] | 6 |
| ['Task'] | 6 |
| ['Application'] | 5 |
| ['Objective'] | 5 |
| ['Library'] | 5 |
| ['Framework'] | 5 |
| ['Benefit'] | 5 |
| ['SuccessCriteria'] | 5 |
| ['Podcast'] | 4 |
| ['Database'] | 4 |
| ['Deliverable'] | 4 |
| ['Method'] | 3 |
| ['Milestone'] | 3 |
| ['TeamMember'] | 3 |
| ['Version control system'] | 2 |
| ['Model'] | 2 |
| ['Purpose'] | 2 |
| ['University'] | 2 |
| ['Format'] | 2 |
| ['Concepts'] | 2 |
| ['Value'] | 2 |
| ['Metric'] | 2 |
| ['Outcome'] | 2 |
| ['MeasurableResult'] | 2 |
| ['Approach'] | 2 |
| ['Plan'] | 2 |
| ['Team'] | 2 |
| ['Responsibility'] | 2 |
| ['Product'] | 1 |
| ['Protocol'] | 1 |
| ['__MetaContext__'] | 1 |
| ['Language'] | 1 |
| ['Storage'] | 1 |
| ['File format'] | 1 |
| ['Platform'] | 1 |
| ['Domain-specific language'] | 1 |
| ['Ide extension'] | 1 |
| ['Document'] | 1 |
| ['Book'] | 1 |
| ['Ecosystem'] | 1 |
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
| INTEGRATES_WITH | 15 |
| SEMANTICALLY_SIMILAR_KNN | 12 |
| USES_TECH | 10 |
| APPLIES_TO | 10 |
| IS_A_HOST | 10 |
| USES | 9 |
| HAS_STEP | 9 |
| MENTIONED | 7 |
| IS_A_GUEST | 7 |
| CONTRIBUTED_TO | 6 |
| HAS_EPISODE | 6 |
| HAS_TOPIC | 6 |
| COVERS_CONCEPT | 6 |
| COVERED_BY_EPISODE | 6 |
| LISTENS_TO_EPISODE | 6 |
| LEARNING_FROM | 6 |
| CONNECTS_WITH | 6 |
| USES_TOOL | 6 |
| HAS_TASK | 6 |
| HAS_OBJECTIVE | 5 |
| REPLACES | 5 |
| HAS_BENEFIT | 5 |
| HAS_CRITERIA | 5 |
| WORKED_AT | 4 |
| CREATOR | 4 |
| RELATED_TO | 4 |
| COMPETITOR | 4 |
| SUBSCRIBES_TO | 4 |
| LISTENS_TO | 4 |
| INCLUDES | 4 |
| HAS_DELIVERABLE | 4 |
| WORKED_ON | 3 |
| USED | 3 |
| SUPPORTS | 3 |
| ADOPTED_BY | 3 |
| USES_METHOD | 3 |
| HAS_MILESTONES | 3 |
| HAS_PURPOSE | 2 |
| DELIVERS | 2 |
| USES_APPROACH | 2 |
| INVOLVES | 2 |
| DEFINES_OUTCOMES | 2 |
| EDUCATED_AT | 2 |
| CREATED_BY | 2 |
| MEASURED_BY | 2 |
| HAS_RESULTS | 2 |
| HAS_PLAN | 2 |
| HAS_ROLE | 2 |
| RESPONSIBLE_FOR | 2 |
| MEMBER_OF | 1 |
| STARTED_CAREER_AS | 1 |
| INFLUENCED_BY | 1 |
| GUEST_ON | 1 |
| HOSTS | 1 |
| WORKS_AT | 1 |
| DEVELOPS | 1 |
| WORKS_ON | 1 |
| INTERVIEWED_BY | 1 |
| USED_IN | 1 |
| INTERACTS_WITH | 1 |
| SIMILAR_TO | 1 |
| CREATES | 1 |
| CREATES_KNOWLEDGE_GRAPH_FROM | 1 |
| STARTED_AT | 1 |
| DONATED_TO | 1 |
| CEO_OF | 1 |
| AUTHORED | 1 |
| HAS_TIMELINE | 1 |

## ⚠️ Schema Violations (Nodes to be Cleaned)
| Labels | Count | Sample Data (First 3) |
| --- | --- | --- |
| ['Organization'] | 10 | <pre>[
  {
    "id": "Anthropic"
  },
  {
    "id": "Sutter Hill"
  },
  {
    "id": "Meta"
  }
]</pre> |
| ['Programming language'] | 7 | <pre>[
  {
    "id": "Php"
  },
  {
    "id": "Python"
  },
  {
    "id": "C#"
  }
]</pre> |
| ['Version control system'] | 2 | <pre>[
  {
    "id": "Mercurial"
  },
  {
    "id": "Git"
  }
]</pre> |
| ['Product'] | 1 | <pre>[
  {
    "id": "Oculus"
  }
]</pre> |
| ['Application'] | 5 | <pre>[
  {
    "id": "Cloud Desktop"
  },
  {
    "id": "Zed"
  },
  {
    "id": "Cursor"
  }
]</pre> |
| ['Protocol'] | 1 | <pre>[
  {
    "id": "Lsp"
  }
]</pre> |
| ['Model'] | 2 | <pre>[
  {
    "id": "Claude"
  },
  {
    "id": "Lava Agent Model"
  }
]</pre> |
| ['__MetaContext__'] | 1 | <pre>[
  {
    "useCase": "podcastEpisodeAssistant",
    "context": "\nThis knowledge graph, and corresponding tools, provide all the information you need to act as a podcast episode assistant who helps with finding and analyzing podcast episodes from the Data Engineering Podcast.\n\nCorresponding tools retrieve data from internal knowledge on podcast episodes based on their topics, people, concepts, technologies, and reference links.\n\nTry to prioritize expert tools (those other than `read_neo4j_cypher`) as appropriate since they have expert approved logic for accessing data. Though you may need to directly access data afterwards to pull more details.\n\nWhen you need more flexible logic for aggregations, follow-up or anything else, you can access the knowledge (in a graph database) directly. ALWAYS get the schema first with `get_schema` and keep it in memory. Only use node labels, relationship types, and property names, and patterns in that schema to generate valid Cypher queries using the `read_neo4j_cypher` tool with proper parameter syntax ($parameter). If you get errors or empty results check the schema and try again at least up to 3 times.\n\nAlso never return embedding properties in Cypher queries. This will result in delays and errors.\n\nWhen responding to the user:\n- if your response includes episodes, include their names, numbers, and links. Never just their IDs.\n- You must explain your retrieval logic and where the data came from. You must say exactly how relevance, similarity, etc. was inferred during search\n\nUse information from previous queries when possible instead of asking the user again.\n\nThe graph contains the following node types:\n- Episode: Individual podcast episodes with name, number, link, and description\n- Topic: Topics discussed in episodes\n- Person: People who appear in episodes (hosts, guests, listeners)\n- Concept: Concepts covered in episodes\n- Technology: Technologies mentioned in episodes\n- ReferenceLink: Reference links from episodes\n- Chunk: Transcript chunks from episodes\n\nThe graph contains the following relationship types:\n- HAS_TOPIC: Episode -> Topic\n- COVERED_BY_EPISODE: Topic -> Episode\n- COVERS_CONCEPT: Topic -> Concept\n- COVERS_TECHNOLOGY: Topic -> Technology\n- HAS_REFERENCE_LINK: Episode -> ReferenceLink\n- HAS_CHUNK: Episode -> Chunk\n- BELONGS_TO_EPISODE: Chunk -> Episode\n- Various person relationships: IS_A_HOST, IS_A_GUEST, LISTENS_TO_EPISODE, etc.\n",
    "version": 1
  }
]</pre> |
| ['Company'] | 16 | <pre>[
  {
    "id": "Datafold"
  },
  {
    "id": "Snowflake"
  },
  {
    "id": "Cash App"
  }
]</pre> |
| ['Library'] | 5 | <pre>[
  {
    "id": "Numpy"
  },
  {
    "id": "Ipython"
  },
  {
    "id": "Mathematica"
  }
]</pre> |
| ['Language'] | 1 | <pre>[
  {
    "id": "Sql"
  }
]</pre> |
| ['Database'] | 4 | <pre>[
  {
    "id": "Mysql"
  },
  {
    "id": "Postgres"
  },
  {
    "id": "Sqlite"
  }
]</pre> |
| ['Storage'] | 1 | <pre>[
  {
    "id": "S3"
  }
]</pre> |
| ['File format'] | 1 | <pre>[
  {
    "id": "Parquet"
  }
]</pre> |
| ['University'] | 2 | <pre>[
  {
    "id": "University Of Michigan"
  },
  {
    "id": "Simon Fraser University"
  }
]</pre> |
| ['Format'] | 2 | <pre>[
  {
    "id": "Iceberg"
  },
  {
    "id": "Parquet"
  }
]</pre> |
| ['Platform'] | 1 | <pre>[
  {
    "id": "Bowplan"
  }
]</pre> |
| ['Field'] | 10 | <pre>[
  {
    "id": "Ai"
  },
  {
    "id": "Nlp"
  },
  {
    "id": "Machine Learning"
  }
]</pre> |
| ['Domain-specific language'] | 1 | <pre>[
  {
    "id": "Baml"
  }
]</pre> |
| ['Framework'] | 5 | <pre>[
  {
    "id": "Langchain"
  },
  {
    "id": "Llamaindex"
  },
  {
    "id": "Haystack"
  }
]</pre> |
| ['Ide extension'] | 1 | <pre>[
  {
    "id": "Playground"
  }
]</pre> |
| ['Concepts'] | 2 | <pre>[
  {
    "id": "Agentic Systems"
  },
  {
    "id": "Ontologies"
  }
]</pre> |
| ['Document'] | 1 | <pre>[
  {
    "id": "Pdfs"
  }
]</pre> |
| ['Book'] | 1 | <pre>[
  {
    "id": "Architecting For Scale"
  }
]</pre> |
| ['Ecosystem'] | 1 | <pre>[
  {
    "id": "Hadoop"
  }
]</pre> |
| ['Engine'] | 9 | <pre>[
  {
    "id": "Spark"
  },
  {
    "id": "Hive"
  },
  {
    "id": "Trino"
  }
]</pre> |

## 🔗 Illegal Connections (To be Deleted)
| Rel Type | Count | Source | Target |
| --- | --- | --- | --- |
| APPLIES_TO | 10 | ['Project'] | ['Field'] |
| REPLACES | 5 | ['Domain-specific language'] | ['Framework'] |
| INTEGRATES_WITH | 5 | ['Project'] | ['Engine'] |
| CONNECTS_WITH | 5 | ['Company'] | ['Engine'] |
| CREATOR | 4 | ['Person'] | ['Project'] |
| COMPETITOR | 4 | ['Project'] | ['Project'] |
| INTEGRATES_WITH | 4 | ['Project'] | ['Project'] |
| CONTRIBUTED_TO | 4 | ['Project'] | ['Company'] |
| WORKED_AT | 3 | ['Person'] | ['Organization'] |
| USED | 3 | ['Person'] | ['Library'] |
| RELATED_TO | 3 | ['Project'] | ['Project'] |
| ADOPTED_BY | 3 | ['Project'] | ['Company'] |
| CONTRIBUTED_TO | 2 | ['Person'] | ['Version control system'] |
| WORKED_ON | 2 | ['Person'] | ['Application'] |
| USES | 2 | ['Project'] | ['Database'] |
| USES | 2 | ['Project'] | ['Storage'] |
| INTEGRATES_WITH | 2 | ['Project'] | ['Company'] |
| USES | 2 | ['Company'] | ['Company'] |
| EDUCATED_AT | 2 | ['Person'] | ['University'] |
| INTEGRATES_WITH | 2 | ['Project'] | ['Format'] |
| INTEGRATES_WITH | 2 | ['Domain-specific language'] | ['Application'] |
| SUPPORTS | 2 | ['Domain-specific language'] | ['Programming language'] |
| CREATED_BY | 2 | ['Project'] | ['Person'] |
| MEMBER_OF | 1 | ['Person'] | ['Organization'] |
| STARTED_CAREER_AS | 1 | ['Person'] | ['Programming language'] |
| WORKED_ON | 1 | ['Person'] | ['Product'] |
| INFLUENCED_BY | 1 | ['Person'] | ['Protocol'] |
| WORKS_AT | 1 | ['Person'] | ['Company'] |
| DEVELOPS | 1 | ['Project'] | ['Project'] |
| USES | 1 | ['Project'] | ['Language'] |
| USES | 1 | ['Project'] | ['File format'] |
| WORKED_AT | 1 | ['Person'] | ['Company'] |
| WORKS_ON | 1 | ['Person'] | ['Project'] |
| USED_IN | 1 | ['Project'] | ['Platform'] |
| INTERACTS_WITH | 1 | ['Domain-specific language'] | ['Database'] |
| USES | 1 | ['Domain-specific language'] | ['Model'] |
| SIMILAR_TO | 1 | ['Domain-specific language'] | ['Library'] |
| INCLUDES | 1 | ['Domain-specific language'] | ['Ide extension'] |
| SUPPORTS | 1 | ['Domain-specific language'] | ['Concepts'] |
| CREATES | 1 | ['Domain-specific language'] | ['Concepts'] |
| CREATES_KNOWLEDGE_GRAPH_FROM | 1 | ['Domain-specific language'] | ['Document'] |
| RELATED_TO | 1 | ['Project'] | ['Ecosystem'] |
| STARTED_AT | 1 | ['Project'] | ['Company'] |
| DONATED_TO | 1 | ['Project'] | ['Organization'] |
| CEO_OF | 1 | ['Person'] | ['Company'] |
| AUTHORED | 1 | ['Person'] | ['Book'] |
| CONNECTS_WITH | 1 | ['Company'] | ['Company'] |

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
