# Hybrid Search & GraphRAG Design Discussion

Date: March 11, 2026

## Overview
This document captures the design discussion regarding the optimization of the CortexDrive "Hybrid Search" strategy. The goal is to balance structured Cypher queries, vector semantic search, and graph-native discovery (GDS) to provide the most accurate and context-aware responses.

## 1. Industry Patterns: "Triage & Chain"
Modern GraphRAG systems (e.g., Neo4j, Microsoft) typically avoid a single entry point. Instead, they use an LLM-driven router to triage the user's intent:

*   **Structured Intent**: Handled via Text-to-Cypher (e.g., "How many episodes...?")
*   **Conceptual Intent**: Handled via Global Search or GDS (e.g., "What are the major themes?")
*   **Contextual Intent**: Handled via Vector Search + Graph Grounding (e.g., "What did X say about Y?")

## 2. Proposed Steering Hierarchy (Level 1/2/3)
To guide the Gateway's LLM in selecting the right toolset, we propose the following hierarchy:

### Level 1: Analytic Direct Hit (Text-to-Cypher)
- **Use Case**: Quantitative or strictly structured questions.
- **Action**: Convert NL to precise Cypher queries (e.g., count, sum, filter by property).
- **Benefit**: 100% accuracy for structured data; bypasses vector noise.

### Level 2: Multi-Hop Discovery (Native GraphRAG)
- **Use Case**: Contextual questions like "What was discussed in episode X?" or "Who said Y?".
- **Action**: Use Vector Search as the "Landing Pad" into `Chunk` nodes, then immediately traverse to `Episode` and `Person` nodes.
- **Tool**: `hybrid_discovery_tool` (Single round-trip, enriched context).

### Level 3: Semantic Pivot (GDS & Global Search)
- **Use Case**: Broad discovery where basic vector search is too narrow.
- **Action**: Use GDS-calculated similarities (`SEMANTICALLY_SIMILAR_KNN`) to find related nodes that share semantic structures even if they don't share identical keywords.

## 3. Chaining & Multi-Turn Execution
Single-turn tool calls are often insufficient. The Gateway must support:
1.  **Iterative Discovery**: Executing a discovery tool, then using those results to trigger a content extraction tool.
2.  **History Preservation**: Explicitly including conversation history in *every* step of the orchestration to resolve pronouns ("this episode", "they") correctly.

## 4. Metadata & Node Property Revisions
To support "free-flowing" questions (e.g., "Compare the tone of X and Y"), the current schema may need enrichment:
- **Chunk Enrichment**: `Chunk.summary`, `Chunk.sentiment`, or `Chunk.entities`.
- **Person Enrichment**: `Person.bio`, `Person.expertise_area`.
- **Topic Enrichment**: `Topic.weight` or `Topic.centrality_score`.

## 5. Decision Points
- **Automated Cypher**: Consideration for a `run_query_tool` that generates and runs Cypher safely.
- **Latency vs. Accuracy**: Accepting multiple LLM turns (multi-second delay) in exchange for high-fidelity responses.
