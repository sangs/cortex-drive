"""
Expert Tools for Neo4j Podcast Episode Graph
"""

from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()
from neo4j import GraphDatabase
import os
import json
import numpy as np
import re
from typing import List, Dict, Any, Optional, cast, LiteralString
from neo4j_serialization import neo4j_default, neo4j_json_dumps


class ExpertTools:
    """Expert tools for querying the Neo4j podcast episode graph"""
    
    def __init__(self, tenant_id: str, requesting_user_id: str = "", guest_share_anchor: str = "", allowed_ids: list = None):
        self.tenant_id = tenant_id
        self.requesting_user_id = requesting_user_id
        self.guest_share_anchor = guest_share_anchor
        # None = OpenFGA not configured; use tenant_id fallback. [] = configured but empty (restricted).
        self.allowed_ids = allowed_ids
        # Initialize clients
        self.client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        self.driver = GraphDatabase.driver(
            os.environ["NEO4J_URI"],
            auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"])
        )
    
    def _get_security_clause(self, node_var: str) -> str:
        """
        Authorization clause. OpenFGA mode when allowed_ids list is provided by gateway.
        Falls back to tenant_id filtering when OpenFGA is not configured (allowed_ids=None).
        """
        if self.allowed_ids is None:
            return f"({node_var}.tenant_id IN ['SYSTEM', 'PUBLIC', $tenant_id])"
        # Guest/share mode: strictly bounded to the granted node_id list (no tenant fallback).
        if self.guest_share_anchor:
            return f"({node_var}.node_id IN $allowed_ids OR {node_var}.tenant_id IN ['SYSTEM', 'PUBLIC'])"
        # Org-member OpenFGA mode: node_id list + tenant_id fallback (defense-in-depth).
        # Fallback guards against missing bootstrap node_ids silently excluding org-owned nodes.
        return f"({node_var}.node_id IN $allowed_ids OR {node_var}.tenant_id IN ['SYSTEM', 'PUBLIC', $tenant_id])"

    def _security_params(self) -> dict:
        """Returns the kwargs for _exec_query matched to _get_security_clause."""
        if self.allowed_ids is None:
            return {"tenant_id": self.tenant_id}
        if not self.guest_share_anchor:
            # Non-guest OpenFGA: pass both so $tenant_id in the dual-check clause is bound.
            return {"allowed_ids": self.allowed_ids, "tenant_id": self.tenant_id}
        return {"allowed_ids": self.allowed_ids}

    def _apply_security(self, query: str, *node_vars: str) -> str:
        """Replace hardcoded OpenFGA $allowed_ids clauses with the dual-mode security clause.
        Used for inline query strings that were written with the OpenFGA clause hardcoded.
        """
        result = query
        for nv in node_vars:
            old = f"(elementId({nv}) IN $allowed_ids OR {nv}.tenant_id IN ['SYSTEM', 'PUBLIC'])"
            result = result.replace(old, self._get_security_clause(nv))
        return result

    # Node variables that may appear in inline security clauses.
    _INLINE_NODE_VARS = (
        "e", "n", "c", "chunk", "seedEpisode", "similarEpisode",
        "episode", "anchor", "expandedNode", "parentEpisode"
    )

    def _exec_query(self, query: str, **kwargs: Any):
        """Execute a parameterized Cypher query with dual-mode security substitution.
        cast() satisfies Pylance's LiteralString requirement — all user values are $params.
        """
        q = self._apply_security(query, *self._INLINE_NODE_VARS)
        return self.driver.execute_query(cast(LiteralString, q), **kwargs)

    def _fragment_taxonomy_expansion(self) -> str:
        query = """
        // Step 0: Taxonomy Expansion (Identify Anchor Topics from keywords)
        OPTIONAL MATCH (anchor)
        WHERE any(label IN labels(anchor) WHERE label IN $anchorLabels)
          AND any(word IN $keywords WHERE toLower(anchor.name) CONTAINS word)
          AND ({sec_anchor})
        
        // Find children/related entities AND their parent Episodes - Relaxed traversal
        OPTIONAL MATCH (anchor)-[*0..2]-(expandedNode)
        WHERE ({sec_expanded})
          AND NOT expandedNode:ReferenceLink
        
        OPTIONAL MATCH (expandedNode)<-[:CONTAINS|HAS_SOURCE|MENTIONS*1..3]-(parentEpisode:Episode)
        WHERE ({sec_parent})
        
        // expandedNode fan-out capped via $expansion_limit — same query text for every caller,
        // only the parameter value differs (SEARCH_EXPANSION_LIMIT_DEFAULT vs _SCOPED in
        // domain_registry.py). anchor/parentEpisode aren't capped: in practice they're already
        // small (anchor = literal keyword-name matches; parentEpisode is reached only via a
        // further, naturally-bounded hop from expandedNode).
        WITH collect(DISTINCT elementId(anchor)) + collect(DISTINCT elementId(expandedNode))[0..$expansion_limit] + collect(DISTINCT elementId(parentEpisode)) AS expanded_ids
        """
        return query.replace("{sec_anchor}", self._get_security_clause("anchor")).replace("{sec_expanded}", self._get_security_clause("expandedNode")).replace("{sec_parent}", self._get_security_clause("parentEpisode"))

    def _fragment_neighbor_aggregation(self) -> str:
        import json
        from domain_registry import get_bridge_label_string
        from schema_guard import TRAVERSAL_RELATIONSHIPS
        bridge_labels = get_bridge_label_string()
        whitelist = json.dumps(TRAVERSAL_RELATIONSHIPS)
        
        query = """
        OPTIONAL MATCH (node)-[r]-(neighbor)
        WHERE neighbor IS NOT NULL
          AND type(r) IN {whitelist}
          AND ({security_clause})
          AND NOT neighbor:{bridge_labels}
          AND ($allowed_labels IS NULL OR any(label IN labels(neighbor) WHERE label IN $allowed_labels))

        OPTIONAL MATCH (node)-[:USES_TOOL]->(tech:Technology)

        // Prefer content-bearing neighbors (real description/text) before the per-anchor cap
        // below truncates — otherwise the cap keeps whatever Neo4j happened to match first,
        // which can silently drop the most relevant neighbor (see SEARCH_NEIGHBOR_LIMIT_DEFAULT/_SCOPED).
        WITH node, expanded_ids, neighbor, r, tech
        ORDER BY CASE WHEN coalesce(neighbor.description, neighbor.text, "") <> "" THEN 0 ELSE 1 END

        WITH node, expanded_ids,
             collect(DISTINCT neighbor)[0..$neighbor_limit] AS neighbors,
             collect(DISTINCT r)[0..$neighbor_limit] AS rels,
             collect(DISTINCT {
                id: neighbor.node_id,
                name: neighbor.name,
                type: labels(neighbor)[0],
                relationship: type(r),
                target_id: neighbor.node_id
             })[0..$neighbor_limit] AS relationships,
             collect(DISTINCT tech.name) AS technologies,
             collect(DISTINCT (CASE WHEN r.start IS NOT NULL OR r.end IS NOT NULL OR r.date IS NOT NULL THEN {rel_start: r.start, rel_end: r.end, rel_date: r.date, rel_title: coalesce(r.title, r.role)} ELSE null END)) AS relDates
        """
        return query.replace("{whitelist}", whitelist).replace("{security_clause}", self._get_security_clause("neighbor")).replace("{bridge_labels}", bridge_labels)

    def _fragment_narrative_aggregation(self) -> str:
        # NOTE (2026-08-03): `:Note`/`HAS_NOTE` are never created anywhere in this codebase —
        # this OPTIONAL MATCH always returns an empty `narratives` collection today. Confirmed
        # non-load-bearing: the real narrative consumer, fetchNodeNarratives() in the gateway,
        # calls get_node_details directly (which correctly uses HAS_PRIVATE_NOTE/PreparatoryNote),
        # not this field. Left intentionally untouched rather than "fixed" to alias
        # PreparatoryNote — investigation (see documents/cortex_master_implementation_tracker.md
        # and documents/security/permission-graph-design.md §"Annotations & Private Context")
        # suggests this is likely inert scaffolding for a different, broader, never-built
        # feature — any user annotating any node — not a typo for the single-author STAR-note
        # PreparatoryNote system that actually shipped. Do not alias the two; if the annotation
        # feature is ever built, it deserves its own node type and its own Permify-based
        # security design (the superseded doc's topological security model doesn't survive the
        # OpenFGA/Permify migration).
        query = """
        // 2. Narrative Enrichment (Notes & Transcripts)
        OPTIONAL MATCH (node)-[:HAS_NOTE]->(note:Note)
        WHERE ({sec_note})

        WITH node, expanded_ids, neighbors, rels, relationships, technologies, relDates,
             collect(DISTINCT note.text) AS narratives,
             apoc.coll.toSet(coalesce(node.links, []) + [node.url, node.link]) AS fused_links
        """
        return query.replace("{sec_note}", self._get_security_clause("note"))

    def _fragment_ranking_and_return(self) -> str:
        return """
        WITH node, narratives, fused_links, relationships, technologies, relDates, expanded_ids,
             CASE 
                WHEN $embedding IS NOT NULL AND node.embedding IS NOT NULL 
                THEN vector.similarity.cosine($embedding, node.embedding)
                ELSE 0.0 
             END AS semantic_score

        WITH node, narratives, fused_links, relationships, technologies, relDates, expanded_ids, semantic_score,
             (CASE 
                WHEN size(relDates) = 0 THEN {rel_start: null, rel_end: null, rel_date: null}
                ELSE apoc.coll.sortMaps([rd IN relDates WHERE rd IS NOT NULL], "^rel_end")[size([rd IN relDates WHERE rd IS NOT NULL])-1]
             END) AS bestDate

        WITH node, narratives, fused_links, technologies, bestDate, semantic_score, expanded_ids,
             (CASE 
                WHEN node.name CONTAINS "1997" OR node.name CONTAINS "NIT Bhopal" THEN 500
                WHEN node.name CONTAINS "JPMC" OR node.name CONTAINS "2025" THEN 200
                WHEN 'ExternalSilo' IN labels(node) AND any(w IN $keywords WHERE w IN ['silo', 'silos', 'external', 'lakehouse', 'iceberg', 'data', 'sentiment']) THEN 2000
                ELSE 0 
             END) AS range_boost,
             (size(narratives) > 0 OR size(technologies) > 0 OR size(fused_links) > 0) AS is_bento_eligible

        RETURN DISTINCT
            node { 
                name: node.name,
                title: node.title,
                description: node.description,
                text: node.text,
                url: node.url,
                link: node.link,
                number: node.number,
                aired_date: node.aired_date,
                published_date: node.published_date,
                year: node.year,
                startDate: node.startDate,
                endDate: node.endDate,
                displayDate: CASE WHEN 'Episode' IN labels(node) THEN null ELSE node.displayDate END,
                startYear:   CASE WHEN 'Episode' IN labels(node) THEN null ELSE node.startYear END,
                endYear:     CASE WHEN 'Episode' IN labels(node) THEN null ELSE node.endYear END,
                isPresent: coalesce(node.isPresent, bestDate.rel_end = 'Present', node.endDate = 'Present', false),
                role: coalesce(bestDate.rel_title, node.role),
                labels: labels(node),
                display_name: coalesce(node.name, node.title, node.text, node.url, labels(node)[0]),
                type: CASE
                    WHEN 'Category' IN labels(node) THEN 'Category'
                    WHEN 'Role' IN labels(node) THEN 'Role'
                    WHEN 'Hackathon' IN labels(node) THEN 'Hackathon'
                    WHEN 'ThoughtLeadership' IN labels(node) THEN 'ThoughtLeadership'
                    WHEN 'Startup' IN labels(node) AND 'Project' IN labels(node) THEN 'Startup'
                    WHEN 'Startup' IN labels(node) THEN 'Startup'
                    WHEN 'Company' IN labels(node) THEN 'Company'
                    WHEN 'Degree' IN labels(node) THEN 'Degree'
                    WHEN 'ProfessionalEducation' IN labels(node) THEN 'ProfessionalEducation'
                    WHEN 'Certification' IN labels(node) THEN 'Certification'
                    WHEN 'Project' IN labels(node) THEN 'Project'
                    WHEN 'Episode' IN labels(node) THEN 'Episode'
                    WHEN 'Technology' IN labels(node) THEN 'Technology'
                    WHEN 'Topic' IN labels(node) THEN 'Topic'
                    ELSE labels(node)[0]
                END,
                is_bento_eligible: is_bento_eligible,
                is_expandable: EXISTS { (node)-[]-(n2) WHERE NOT labels(n2)[0] IN ['ReferenceLink', 'Chunk'] },
                temporal_boost: (CASE
                    WHEN bestDate.rel_end = 'Present' OR node.endDate = 'Present' THEN 150 + (CASE WHEN node:Project THEN 10 ELSE 0 END)
                    WHEN bestDate.rel_end IS NOT NULL OR node.endDate IS NOT NULL THEN 100 + (CASE WHEN node:Project THEN 10 ELSE 0 END)
                    WHEN bestDate.rel_start IS NOT NULL OR node.startDate IS NOT NULL THEN 50 + (CASE WHEN node:Project THEN 10 ELSE 0 END)
                    WHEN node:Episode THEN 300
                    ELSE 0
                END) + (CASE WHEN node.isPresent = true THEN 100 ELSE 0 END) + range_boost + toInteger((semantic_score * 100)) + (CASE WHEN elementId(node) IN expanded_ids THEN 1000 ELSE 0 END),

                year: coalesce(
                    (CASE WHEN node:Project AND bestDate.rel_end = 'Present' THEN '2026'
                          WHEN node:Project AND bestDate.rel_end IS NOT NULL THEN right(toString(bestDate.rel_end), 4)
                          ELSE null END),
                    toString(node.year),
                    toString(node.aired_date),
                    (CASE WHEN bestDate.rel_end = 'Present' THEN '2026' WHEN bestDate.rel_end IS NOT NULL THEN right(toString(bestDate.rel_end), 4) ELSE null END),
                    (CASE WHEN node.endDate = 'Present' THEN '2026' WHEN node.endDate IS NOT NULL THEN right(toString(node.endDate), 4) ELSE null END),
                    right(toString(bestDate.rel_start), 4),
                    right(toString(node.startDate), 4),
                    right(toString(bestDate.rel_date), 4),
                    right(toString(node.date), 4),
                    left(toString(node.published_at), 4),
                    null
                ),
                relationships: [rel IN relationships WHERE rel.name <> "Unknown"], 
                technologies: [t IN technologies WHERE t IS NOT NULL], 
                links: [l IN fused_links WHERE l IS NOT NULL AND l <> ""],
                text: apoc.text.join(narratives, "\n---\n"),
                start_time: node.startTime,
                end_time: node.endTime,
                aired_date: node.aired_date
            } AS details
        ORDER BY details.temporal_boost DESC
        LIMIT 40
        """

    def _sanitize_narrative(self, text: str) -> str:
        """
        Strips internal STAR framework headers (Situation/Task/Action/Result) from text.
        Returns a clean narrative-first string.
        """
        if not text:
            return ""
        # Regex to strip headers (Case-insensitive, handles optional colon/space)
        headers = [r"(?i)Situation:?\s*", r"(?i)Task:?\s*", r"(?i)Action:?\s*", r"(?i)Result:?\s*"]
        clean_text = text
        for h in headers:
            clean_text = re.sub(h, "", clean_text)
        return clean_text.strip()

    def get_embedding(self, question: str, model: str = "text-embedding-3-small") -> List[float]:
        """Get embedding vector for the input question"""
        response = self.client.embeddings.create(
            model=model,
            input=question
        )
        return response.data[0].embedding

    def cosine_similarity(self, vec1: List[float], vec2: List[float]) -> float:
        """Calculate cosine similarity between two vectors"""
        vec1_np = np.array(vec1)
        vec2_np = np.array(vec2)
        
        # Check for dimension mismatch
        if vec1_np.shape != vec2_np.shape:
            raise ValueError(f"Dimension mismatch: vectors have shapes {vec1_np.shape} and {vec2_np.shape}. "
                           f"Both vectors must have the same dimensions for cosine similarity calculation. "
                           f"This usually means the embedding models used for the question and chunks are different.")
        
        dot_product = np.dot(vec1_np, vec2_np)
        norm1 = np.linalg.norm(vec1_np)
        norm2 = np.linalg.norm(vec2_np)
        
        if norm1 == 0 or norm2 == 0:
            return 0
        
        return dot_product / (norm1 * norm2)

    def query_relevant_chunks_gds(self, embedding: List[float], top_k: int = 5) -> List[Dict[str, Any]]:
        """Run vector search + graph query in Neo4j using GDS (requires Aura Professional+)"""
        query = """
        CALL gds.alpha.knn.stream({
            nodeProjection: 'Chunk',
            vectorProperty: 'embedding',
            topK: $top_k,
            queryVector: $embedding
        })
        YIELD nodeId, similarity
        MATCH (chunk:Chunk)-[:BELONGS_TO_SOURCE]->(s:Source)<-[:HAS_SOURCE]-(ep:Episode)
        WHERE id(chunk) = nodeId 
        WHERE (""" + self._get_security_clause("ep") + """)
        RETURN ep.name AS episode_name, 
               ep.number AS episode_number,
               ep.link AS episode_link,
               chunk.text AS text, 
               chunk.startTime AS start_time,
               chunk.endTime AS end_time,
               similarity
        ORDER BY similarity DESC
        LIMIT $top_k
        """
        
        result = self._exec_query(
            query,
            **self._security_params(),
            embedding=embedding,
            top_k=top_k
        )

        # Convert result to list of dictionaries
        chunks = []
        for record in result.records:
            chunks.append({
                'episode_name': record['episode_name'],
                'episode_number': record['episode_number'],
                'episode_link': record['episode_link'],
                'text': record['text'],
                'start_time': record['start_time'],
                'end_time': record['end_time'],
                'similarity': record['similarity']
            })
        
        return chunks

    def query_relevant_chunks_hybrid(self, question: str, top_k: int = 10) -> List[Dict[str, Any]]:
        """
        High-Fidelity Hybrid Search (BM25 + Vector) with Reciprocal Rank Fusion (RRF).
        This eliminates 'Top-K noise' by merging conceptual depth with keyword precision.
        """
        # 1. Get embedding for Vector Search
        embedding = self.get_embedding(question)
        
        # 2. Vector Search (Semantic)
        vector_query = """
        WITH split($question, ' ') AS keywords
        CALL db.index.vector.queryNodes('chunkIndex', $top_k * 2, $embedding)
        YIELD node, score
        RETURN node.text AS text, node.startTime AS start_time, node.endTime AS end_time, score, 'vector' as source
        """
        
        # 3. Keyword Search (BM25)
        keyword_query = """
        WITH split($question, ' ') AS keywords
        CALL db.index.fulltext.queryNodes('chunkTextIndex', $question)
        YIELD node, score
        RETURN node.text AS text, node.startTime AS start_time, node.endTime AS end_time, score, 'keyword' as source
        LIMIT $top_k * 2
        """
        
        try:
            v_res = self._exec_query(
                vector_query,
                embedding=embedding,
                top_k=top_k,
                question=question,
                **self._security_params(),
            )
            k_res = self._exec_query(
                keyword_query,
                question=question,
                top_k=top_k,
                **self._security_params(),
            )
            
            # Reciprocal Rank Fusion (RRF)
            # RRF Score = 1 / (rank + k)
            k_rrf = 60
            fused_scores = {}
            
            # Process Vector Results
            for i, record in enumerate(v_res.records):
                text = record['text']
                fused_scores[text] = fused_scores.get(text, 0) + (1.0 / (i + 1 + k_rrf))
                
            # Process Keyword Results
            for i, record in enumerate(k_res.records):
                text = record['text']
                fused_scores[text] = fused_scores.get(text, 0) + (1.0 / (i + 1 + k_rrf))
            
            # Sort and Get Metadata
            sorted_texts = sorted(fused_scores.items(), key=lambda x: x[1], reverse=True)[:top_k]
            
            # Enhance with Episode Metadata
            final_chunks = []
            for text, rrf_score in sorted_texts:
                meta_query = """
                MATCH (ep:Episode)
                WHERE (""" + self._get_security_clause("ep") + """)
                MATCH (ep)-[:HAS_SOURCE]->(s:Source)-[:CONTAINS]->(chunk:Chunk {text: $text})
                RETURN ep.name AS episode_name, ep.number AS episode_number, ep.link AS episode_link
                LIMIT 1
                """
                meta_res = self._exec_query(
                    meta_query,
                    text=text,
                    **self._security_params(),
                )
                if meta_res.records:
                    meta = meta_res.records[0]
                    final_chunks.append({
                        'episode_name': meta['episode_name'],
                        'episode_number': meta['episode_number'],
                        'episode_link': meta['episode_link'],
                        'text': text,
                        'rrf_score': rrf_score
                    })
            return final_chunks
            
        except Exception as e:
            print(f"Hybrid Search Error: {e}")
            return self.query_relevant_chunks(question, top_k)

    def query_relevant_chunks(self, question: str, top_k: int = 5) -> List[Dict[str, Any]]:
        """Standard Vector Search on Transcript Chunks using the unified 3-small manifold."""
        embedding = self.get_embedding(question)
        
        query = """
        CALL db.index.vector.queryNodes('chunkIndex', $top_k, $embedding)
        YIELD node, score
        MATCH (node)-[:BELONGS_TO_SOURCE]->(s:Source)<-[:HAS_SOURCE]-(ep:Episode)
        WHERE (""" + self._get_security_clause("ep") + """)
        RETURN ep.name AS episode_name, 
               ep.number AS episode_number,
               ep.link AS episode_link,
               node.text AS text, 
               score
        LIMIT $top_k
        """
        
        result = self._exec_query(
            query,
            **self._security_params(),
            embedding=embedding,
            top_k=top_k
        )

        chunks = []
        for record in result.records:
            chunks.append({
                'episode_name': record['episode_name'],
                'episode_number': record['episode_number'],
                'episode_link': record['episode_link'],
                'text': record['text'],
                'similarity': record['score']
            })
        
        return chunks

    def find_episodes_by_topic(self, question: str) -> str:
        """
        Search for episodes that contain specific topics or keywords.
        """
        query = self._apply_security("""
        MATCH (e:Episode)
        WHERE (elementId(e) IN $allowed_ids OR e.tenant_id IN ['SYSTEM', 'PUBLIC'])
        MATCH (e)-[:HAS_TOPIC]->(t:Topic)
        WHERE toLower(t.name) CONTAINS toLower($question) OR
              toLower(e.name) CONTAINS toLower($question) OR
              toLower(e.description) CONTAINS toLower($question)
        RETURN DISTINCT e.name AS episode_name,
               e.number AS episode_number,
               e.link AS episode_link,
               e.description AS description,
               collect(t.name) AS topics,
               $question AS matched_term
        ORDER BY e.number DESC
        LIMIT 10
        """, "e")

        result = self._exec_query(
            query,
            **self._security_params(),
            question=question,
        )
        
        episodes = []
        for record in result.records:
            episodes.append({
                'episode_name': record['episode_name'],
                'episode_number': record['episode_number'],
                'episode_link': record['episode_link'],
                'description': record['description'],
                'topics': record['topics'],
                'matched_term': record['matched_term']
            })
        
        return json.dumps(episodes, indent=2)

    def get_tool_context(self, use_case: Optional[str] = None) -> str:
        """
        Gets the behavior context for how to use & access graph data.
        """
        if use_case:
            query = self._apply_security("MATCH (n:__MetaContext__ {useCase: $use_case}) WHERE (elementId(n) IN $allowed_ids OR n.tenant_id IN ['SYSTEM', 'PUBLIC']) RETURN n.context AS context", "n")
            result = self._exec_query(query, **self._security_params(), use_case=use_case)
        else:
            query = self._apply_security("MATCH (n:__MetaContext__) WHERE (elementId(n) IN $allowed_ids OR n.tenant_id IN ['SYSTEM', 'PUBLIC']) RETURN n.context AS context", "n")
            result = self._exec_query(query, **self._security_params())
            
        if result.records:
            return "\n\n".join([r['context'] for r in result.records if r['context']])
        return "No behavioral instructions found for this graph context."

    def find_episodes_by_people(self, question: str) -> str:
        """
        Search for episodes that feature specific people.
        """
        query = """
        MATCH (p:Person)-[r]-(e:Episode)
        WHERE (""" + self._get_security_clause("e") + """)
          AND toLower(p.name) CONTAINS toLower($question)
        RETURN DISTINCT p.name AS person_name,
               type(r) AS relationship_type,
               e.name AS episode_name,
               e.number AS episode_number,
               e.link AS episode_link,
               $question AS matched_term
        ORDER BY e.number DESC
        LIMIT 10
        """
        
        result = self._exec_query(
            query,
            **self._security_params(),
            question=question,
        )

        people = []
        for record in result.records:
            people.append({
                'person_name': record['person_name'],
                'relationship_type': record['relationship_type'],
                'episode_name': record['episode_name'],
                'episode_number': record['episode_number'],
                'episode_link': record['episode_link'],
                'matched_term': record['matched_term']
            })
        
        return json.dumps(people, indent=2)

    def find_episodes_by_concept(self, question: str) -> str:
        """
        Search for episodes that discuss specific concepts or ideas.
        """
        query = """
        WITH split(toLower($question), ' ') AS keywords
        MATCH (e:Episode)
        WHERE (elementId(e) IN $allowed_ids OR e.tenant_id IN ['SYSTEM', 'PUBLIC'])
        MATCH (e)-[:HAS_TOPIC|SIMILAR|IS_SIMILAR|DISCUSSES|COVERS_CONCEPT|COVERS_TECHNOLOGY*1..2]-(c)
        WHERE any(label IN labels(c) WHERE label IN ["Concept", "Technology", "Topic"])
          AND (
            any(word IN keywords WHERE toLower(c.name) CONTAINS word) OR
            any(word IN keywords WHERE toLower(c.description) CONTAINS word)
          )
        RETURN DISTINCT e.name AS episode_name,
               e.number AS episode_number,
               e.link AS episode_link,
               coalesce(c.name, "") AS concept_name,
               left(coalesce(c.description, ""), 300) AS concept_description,
               $question AS matched_term
        ORDER BY e.number DESC
        LIMIT 10
        """

        result = self._exec_query(
            query,
            **self._security_params(),
            question=question,
        )

        concepts = []
        for record in result.records:
            concepts.append({
                'episode_name': record['episode_name'],
                'episode_number': record['episode_number'],
                'episode_link': record['episode_link'],
                'concept_name': record['concept_name'],
                'concept_description': record['concept_description'],
                'matched_term': record['matched_term']
            })
        
        return json.dumps(concepts, indent=2)

    def find_episodes_by_technology(self, question: str) -> str:
        """
        Search for episodes that discuss specific technologies or tools.
        """
        query = """
        WITH split(toLower($question), ' ') AS keywords
        MATCH (e:Episode)
        WHERE (elementId(e) IN $allowed_ids OR e.tenant_id IN ['SYSTEM', 'PUBLIC'])
        MATCH (e)-[:HAS_TOPIC|SIMILAR|IS_SIMILAR|DISCUSSES|COVERS_TECHNOLOGY*1..2]-(tech:Technology)
        WHERE any(word IN keywords WHERE toLower(tech.name) CONTAINS word)
        RETURN DISTINCT e.name AS episode_name,
               e.number AS episode_number,
               e.link AS episode_link,
               tech.name AS technology_name,
               $question AS matched_term
        ORDER BY e.number DESC
        LIMIT 10
        """

        result = self._exec_query(
            query,
            **self._security_params(),
            question=question,
        )
        
        technologies = []
        for record in result.records:
            technologies.append({
                'episode_name': record['episode_name'],
                'episode_number': record['episode_number'],
                'episode_link': record['episode_link'],
                'technology_name': record['technology_name'],
                'matched_term': record['matched_term']
            })
        
        return json.dumps(technologies, indent=2)

    def get_episode_statistics(self) -> str:
        """
        Get statistics about episodes in the database.
        """
        query = """
        MATCH (e:Episode)
        WHERE (elementId(e) IN $allowed_ids OR e.tenant_id IN ['SYSTEM', 'PUBLIC'])
        OPTIONAL MATCH (e)-[:HAS_TOPIC]->(t:Topic)
        OPTIONAL MATCH (e)-[:HAS_REFERENCE_LINK]->(r:ReferenceLink)
        OPTIONAL MATCH (e)-[:HAS_SOURCE]->(s:Source)-[:CONTAINS]->(c:Chunk)
        RETURN count(DISTINCT e) AS total_episodes,
               count(DISTINCT t) AS total_topics,
               count(DISTINCT r) AS total_reference_links,
               count(DISTINCT c) AS total_chunks
        """

        result = self._exec_query(query, **self._security_params())
        record = result.records[0]
        
        stats = {
            'total_episodes': record['total_episodes'],
            'total_topics': record['total_topics'],
            'total_reference_links': record['total_reference_links'],
            'total_chunks': record['total_chunks']
        }
        
        return json.dumps(stats, indent=2)

    def find_episodes_by_reference(self, reference_string: str) -> str:
        """
        Find episodes that have reference links containing the input string.
        """
        query = """
        MATCH (e:Episode)
        WHERE (elementId(e) IN $allowed_ids OR e.tenant_id IN ['SYSTEM', 'PUBLIC'])
        MATCH (e)-[:HAS_REFERENCE_LINK]->(r:ReferenceLink)
        WHERE toLower(r.url) CONTAINS toLower($reference_string) OR
              toLower(r.text) CONTAINS toLower($reference_string)
        RETURN e.name AS episode_name,
               e.number AS episode_number,
               e.link AS episode_link,
               e.description AS description,
               r.url AS reference_url,
               r.text AS reference_text,
               $reference_string AS matched_term
        ORDER BY e.number DESC
        """

        result = self._exec_query(
            query,
            **self._security_params(),
            reference_string=reference_string,
        )
        
        episodes = []
        for record in result.records:
            episodes.append({
                'episode_name': record['episode_name'],
                'episode_number': record['episode_number'],
                'episode_link': record['episode_link'],
                'description': record['description'],
                'reference_url': record['reference_url'],
                'reference_text': record['reference_text'],
                'matched_term': record['matched_term']
            })
        
        return json.dumps(episodes, indent=2)

    def detect_embedding_model(self) -> str:
        """Detect which embedding model was used for chunks by checking dimensions"""
        query = """
        MATCH (c:Chunk)
        WHERE (elementId(c) IN $allowed_ids OR c.tenant_id IN ['SYSTEM', 'PUBLIC'])
          AND c.embedding IS NOT NULL
        RETURN c.embedding AS embedding
        LIMIT 1
        """

        result = self._exec_query(query, **self._security_params())
        if result.records:
            embedding = result.records[0]['embedding']
            if embedding:
                dimension = len(embedding)
                if dimension == 1536:
                    return "text-embedding-3-small"
                elif dimension == 3072:
                    return "text-embedding-3-large"
        return "text-embedding-3-small"

    def search_episodes_gds_by_question(
        self, question: str, k: Optional[int] = 5, limit: Optional[int] = 10
    ) -> str:
        """
        Extended search that combines vector search with GDS KNN relationships.
        """
        question_embedding = self.get_embedding(question, model="text-embedding-3-small")
        
        with self.driver.session() as session:
            _gds_query = self._apply_security("""
                WITH split($question, ' ') AS keywords
                CALL db.index.vector.queryNodes(
                    'chunkIndex',
                    $k,
                    $questionEmbedding
                )
                YIELD node AS chunk, score AS indexScore

                MATCH (seedEpisode:Episode)-[:HAS_SOURCE]->(s:Source)-[:CONTAINS]->(chunk)
                WHERE (elementId(seedEpisode) IN $allowed_ids OR seedEpisode.tenant_id IN ['SYSTEM', 'PUBLIC'])
                OPTIONAL MATCH (seedEpisode)-[r:SEMANTICALLY_SIMILAR_KNN]->(similarEpisode:Episode)
                WHERE (elementId(similarEpisode) IN $allowed_ids OR similarEpisode.tenant_id IN ['SYSTEM', 'PUBLIC'])

                RETURN DISTINCT
                    seedEpisode.name AS SeedEpisode,
                    seedEpisode.number AS SeedEpisodeNumber,
                    indexScore AS SeedEpisode_IndexScore,
                    similarEpisode.name AS SimilarEpisode,
                    similarEpisode.number AS SimilarEpisodeNumber,
                    r.knn_score AS KNN_Similarity_Score
                ORDER BY
                    SeedEpisode_IndexScore DESC,
                    KNN_Similarity_Score DESC
                LIMIT $limit
            """, "seedEpisode", "similarEpisode")
            result = session.run(_gds_query, questionEmbedding=question_embedding, k=k, limit=limit, **self._security_params(), question=question)
            
            results = []
            for record in result:
                results.append({
                    'SeedEpisode': record['SeedEpisode'],
                    'SeedEpisodeNumber': record['SeedEpisodeNumber'],
                    'SeedEpisode_IndexScore': float(record['SeedEpisode_IndexScore']) if record['SeedEpisode_IndexScore'] else None,
                    'SimilarEpisode': record.get('SimilarEpisode'),
                    'SimilarEpisodeNumber': record.get('SimilarEpisodeNumber'),
                    'KNN_Similarity_Score': float(record['KNN_Similarity_Score']) if record.get('KNN_Similarity_Score') else None
                })
            
            return json.dumps(results, indent=2)

    def search_episodes_by_question(self, question: str, k: int = 5) -> str:
        """
        Search for relevant episodes using vector similarity search on chunk embeddings.
        """
        question_embedding = self.get_embedding(question, model="text-embedding-3-small")
        
        with self.driver.session() as session:
            _vec_query = self._apply_security("""
                WITH split($question, ' ') AS keywords
                CALL db.index.vector.queryNodes(
                    'chunkIndex',
                    $k,
                    $questionEmbedding
                )
                YIELD node AS chunk, score
                MATCH (episode:Episode)-[:HAS_SOURCE]->(s:Source)-[:CONTAINS]->(chunk)
                WHERE (elementId(episode) IN $allowed_ids OR episode.tenant_id IN ['SYSTEM', 'PUBLIC'])
                OPTIONAL MATCH (episode)-[:HAS_TOPIC]->(t:Topic)
                OPTIONAL MATCH (p:Person)-[]-(episode)
                RETURN
                    episode.name AS EpisodeTitle,
                    episode.number AS EpisodeNumber,
                    chunk.text AS ChunkContent,
                    score AS SimilarityScore,
                    collect(DISTINCT t.name) AS Topics,
                    collect(DISTINCT p.name) AS People
                ORDER BY
                    SimilarityScore DESC
            """, "episode")
            result = session.run(_vec_query, questionEmbedding=question_embedding, k=k, **self._security_params(), question=question)
            
            results = []
            for record in result:
                results.append({
                    'EpisodeTitle': record['EpisodeTitle'],
                    'EpisodeNumber': record['EpisodeNumber'],
                    'ChunkContent': record['ChunkContent'],
                    'Topics': record['Topics'],
                    'People': record['People'],
                    'SimilarityScore': float(record['SimilarityScore']) if record['SimilarityScore'] else None
                })
            
            return json.dumps(results, indent=2)

    def get_people_by_episode(self, episode_name: str) -> str:
        """
        Find all people associated with a specific episode.
        """
        query = """
        MATCH (e:Episode)-[r]-(p:Person)
        WHERE (elementId(e) IN $allowed_ids OR e.tenant_id IN ['SYSTEM', 'PUBLIC'])
          AND toLower(e.name) CONTAINS toLower($episode_name)
        RETURN p.name AS person_name,
               type(r) AS relationship,
               e.name AS episode_title,
               e.number AS episode_number
        LIMIT 20
        """
        result = self._exec_query(
            query,
            **self._security_params(),
            episode_name=episode_name,
        )

        people = []
        for record in result.records:
            people.append({
                'person_name': record['person_name'],
                'relationship': record['relationship'],
                'episode_title': record['episode_title'],
                'episode_number': record['episode_number']
            })
            
        return json.dumps(people, indent=2)

    def get_episodes_with_cast(self) -> str:
        """
        List all available podcast episodes along with their hosts and guests.
        Use this for broad discovery of the podcast catalog.
        """
        query = """
        MATCH (e:Episode)
        WHERE (elementId(e) IN $allowed_ids OR e.tenant_id IN ['SYSTEM', 'PUBLIC'])
        OPTIONAL MATCH (p:Person)-[r:HOSTS|GUEST_ON]->(e)
        RETURN e.name AS episode_name,
               e.number AS episode_number,
               e.link AS episode_link,
               e.description AS description,
               collect({name: p.name, role: type(r)}) AS cast
        ORDER BY e.number DESC
        """
        result = self._exec_query(query, **self._security_params())
        
        episodes = []
        for record in result.records:
            episodes.append({
                'episode_name': record['episode_name'],
                'episode_number': record['episode_number'],
                'episode_link': record['episode_link'],
                'description': record['description'],
                'cast': record['cast']
            })
            
        return json.dumps(episodes, indent=2)

    def hybrid_discovery(self, question: str, k: int = 5) -> str:
        """
        Native Hybrid Search (GraphRAG): Performs RRF hybrid search on chunks and 
        immediately traverses to parent Episode and related nodes.
        """
        # 1. Get hybrid chunks via RRF
        chunks = self.query_relevant_chunks_hybrid(question, top_k=k)
        
        enriched_results = []
        for chunk_data in chunks:
            # For each chunk, enrich with graph metadata
            episode_name = chunk_data.get('episode_name')
            if not episode_name:
                continue

            query = """
            MATCH (e:Episode {name: $episode_name})
            WHERE (elementId(e) IN $allowed_ids OR e.tenant_id IN ['SYSTEM', 'PUBLIC'])

            OPTIONAL MATCH (p:Person)-[r]-(e)
            WHERE type(r) IN ['HOSTS', 'GUEST_ON']

            OPTIONAL MATCH (e)-[:HAS_TOPIC]->(t:Topic)
            OPTIONAL MATCH (t)-[:COVERS_TECHNOLOGY]->(tech:Technology)

            RETURN e.name AS episode_title,
                   e.number AS episode_number,
                   e.description AS episode_description,
                   e.link AS link,
                   collect(DISTINCT {name: p.name, role: type(r)}) AS participants,
                   collect(DISTINCT t.name) AS topics,
                   collect(DISTINCT tech.name) AS technologies
            LIMIT 1
            """

            try:
                result = self._exec_query(
                    query,
                    **self._security_params(),
                    episode_name=episode_name,
                )
                
                if not result.records:
                    continue
                    
                record = result.records[0]
                relationships = []
                
                for p in (record['participants'] or []):
                    if p and p.get('name'):
                        relationships.append({"target_name": p['name'], "target_type": "Person", "rel_type": p['role']})
                
                for t in (record['topics'] or []):
                    if t:
                        relationships.append({"target_name": t, "target_type": "Topic", "rel_type": "HAS_TOPIC"})
                        
                for tech in (record['technologies'] or []):
                    if tech:
                        relationships.append({"target_name": tech, "target_type": "Technology", "rel_type": "COVERS_TECHNOLOGY"})
                
                enriched_results.append({
                    'name': record['episode_title'],
                    'type': 'Episode',
                    'link': record['link'],
                    'episode_title': record['episode_title'],
                    'episode_number': record['episode_number'],
                    'episode_description': record['episode_description'],
                    'chunk_content': chunk_data['text'],
                    'similarity_score': chunk_data.get('similarity', 0),
                    'rrf_score': chunk_data.get('rrf_score', 0),
                    'relationships': relationships
                })
            except Exception as e:
                print(f"Error enriching chunk {episode_name}: {e}")
                continue
            
        return json.dumps(enriched_results, indent=2)

    def run_cypher_query(self, query: str, requesting_user_id: str = "", schema_readable: bool = False) -> str:
        """
        Execute a raw Cypher query against the Neo4j graph.
        """
        owner_user_id = os.environ.get("OWNER_USER_ID", "")
        is_owner = bool(owner_user_id and requesting_user_id == owner_user_id)

        if not is_owner and not schema_readable:
            INTRO_KEYWORDS = ["CALL", "db.labels", "db.schema", "SHOW", "db.relationshipTypes", "introspection"]
            if any(k.lower() in query.lower() for k in INTRO_KEYWORDS):
                return json.dumps({"error": "Access Denied: Schema Readable permission required for introspection."})

        if not is_owner:
            FORBIDDEN_PATTERNS = [
                (r"<-\s*\[\s*:CONTAINS", "Backward traversal into Chunk"),
                (r"<-\s*\[\s*:HAS_SOURCE", "Backward traversal into Source"),
                (r"\(\s*\w*\s*:PreparatoryNote", "Direct access to PreparatoryNote"),
                (r":HAS_PRIVATE_NOTE", "Traversal via HAS_PRIVATE_NOTE"),
                (r"\(\s*\w*\s*:Chunk\b", "Direct access to Chunk"),
                (r"\(\s*\w*\s*:ResumeChunk", "Direct access to ResumeChunk"),
            ]

            for pattern, reason in FORBIDDEN_PATTERNS:
                if re.search(pattern, query, re.IGNORECASE):
                    return json.dumps({"error": f"Query blocked by security policy: {reason}"})

        try:
            result = self._exec_query(
                query,
                **self._security_params(),
            )
            output = [record.data() for record in result.records]
            return json.dumps(output, indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})

    def get_node_details(self, node_id: Optional[str] = None, node_name: Optional[str] = None) -> str:
        """
        Fetch all properties and labels for a specific node by its stable node_id UUID or name.

        Also populates `combined_narrative` (2026-08-03; merge behavior reversed 2026-08-06 —
        see documents/architecture/node-context-inference-2026-08-03.md §5 addendum): authored
        PreparatoryNote content (`narratives`) and inferred structural context (via
        infer_context_on_demand's helpers) are composed into one narrative string with inline
        "Authored:"/"Inferred from graph:" labels, so a downstream consumer (e.g. the
        career-domain biographer LLM prompt) can still tell directly-stated fact from
        graph-derived inference apart even though they're now combined. When no authored
        narrative exists, `combined_narrative` is inferred-content-only — it becomes the
        narrative itself rather than being suppressed. `narratives`/`context_summary`/
        `context_facts` remain separately populated too, unchanged, for consumers that want the
        raw fields (e.g. a future "Explain this node" button). Category nodes get none of this
        (structural nodes don't have a distinct narrative — same guard already applied to the
        PreparatoryNote traversal below).
        """
        from domain_registry import get_bridge_label_string
        bridge_labels = get_bridge_label_string()
        sec_m = self._get_security_clause("m")

        query = """
        MATCH (n)
        WHERE (n.node_id = $node_id OR toLower(n.name) = toLower($node_name))
          AND (""" + self._get_security_clause("n") + """)

        OPTIONAL MATCH (n)-[:HAS_REFERENCE]->(ref:ReferenceLink)
        OPTIONAL MATCH (n)-[:USES_TOOL]->(tech:Technology)
        OPTIONAL MATCH (n)-[:HAS_PRIVATE_NOTE|CONTAINS|CONTRIBUTED_TO*1..2]-(note:PreparatoryNote)
        WHERE (""" + self._get_security_clause("note") + """) AND NOT 'Category' IN labels(n)
        OPTIONAL MATCH (person:Person)-[gRel:GUEST_ON|HOSTS|FEATURE_GUEST|INTERVIEWED_BY]->(n)

        WITH n, labels(n) AS labels,
             collect(DISTINCT coalesce(ref.url, ref.link)) AS ref_urls,
             collect(DISTINCT tech.name) AS technologies,
             collect(DISTINCT note.text) AS narratives,
             collect(DISTINCT CASE WHEN person IS NOT NULL THEN {name: person.name, role: type(gRel)} END) AS guests

        RETURN properties(n) AS properties,
               labels,
               ref_urls,
               technologies,
               narratives,
               guests,
               n.node_id AS node_id,
               elementId(n) AS element_id,
               COUNT { (n)--(m) WHERE NOT m:""" + bridge_labels + """ AND (""" + sec_m + """) } AS degree,
               coalesce(n.name, n.title, n.text, n.url, labels[0]) AS display_name
        LIMIT 1
        """
        result = self._exec_query(
            query,
            **self._security_params(),
            node_id=node_id,
            node_name=node_name,
        )

        if not result.records:
            return json.dumps({"error": "Node not found or access denied."})

        data = result.records[0].data()
        # Apply Python Sanitizer to Narratives
        if data.get("narratives"):
            data["narratives"] = [self._sanitize_narrative(n) for n in data["narratives"] if n]

        # Inferred structural context + combined narrative (2026-08-03; merge behavior reversed
        # 2026-08-06 — see documents/architecture/node-context-inference-2026-08-03.md §5
        # addendum) — always attempted alongside the authored narrative above, unless the node
        # is structural (Category). `context_summary`/`context_facts` stay raw-inferred-only,
        # unchanged, for consumers that want them (e.g. a future "Explain this node" button).
        # `combined_narrative` is the new field: authored + inferred composed into one string
        # with inline "Authored:"/"Inferred from graph:" labels — see _render_combined_narrative.
        labels_list = data.get("labels") or []
        if "Category" not in labels_list:
            try:
                keywords = set()
                facts = self._collect_context_facts(data["element_id"], keywords)
                node_row = {
                    "name": data.get("display_name"),
                    "labels": labels_list,
                    "degree": data.get("degree") or 0,
                }
                if facts:
                    data["context_summary"] = self._render_context_summary(node_row, facts, keywords)
                    data["context_facts"] = facts
                    data["context_tier"] = "inferred"
                    data["context_provenance"] = "inferred_structural"
                data["combined_narrative"] = self._render_combined_narrative(
                    data.get("narratives") or [], node_row, facts, keywords
                )
            except Exception as e:
                # Non-fatal — the authored narrative (if any) and placeholder fallback still work.
                print(f"[get_node_details] inferred context collection failed (non-fatal): {e}")

        return neo4j_json_dumps([data], indent=2)

    def expand_node_topology(self, node_id: Optional[str] = None, node_name: Optional[str] = None) -> str:
        """
        Explore the 1-hop neighborhood of a node by node_id or name.
        """
        import json as _json
        from domain_registry import DISCOVERY_LABELS
        from schema_guard import TRAVERSAL_RELATIONSHIPS
        _traversal_rels = _json.dumps(TRAVERSAL_RELATIONSHIPS)
        query = f"""
        MATCH (node)-[r]-(neighbor)
        WHERE (node.name = $node_name OR node.node_id = $node_id)
          AND ({self._get_security_clause("node")})
          AND type(r) IN {_traversal_rels}
          AND ({self._get_security_clause("neighbor")})
          AND any(label IN labels(neighbor) WHERE label IN $allowed_labels)

        OPTIONAL MATCH (neighbor)-[:HAS_REFERENCE]->(ref:ReferenceLink)

        RETURN
            CASE
                WHEN 'Category' IN labels(neighbor) THEN 'Category'
                WHEN 'Role' IN labels(neighbor) THEN 'Role'
                WHEN 'Hackathon' IN labels(neighbor) THEN 'Hackathon'
                WHEN 'ThoughtLeadership' IN labels(neighbor) THEN 'ThoughtLeadership'
                WHEN 'Startup' IN labels(neighbor) THEN 'Startup'
                WHEN 'Company' IN labels(neighbor) THEN 'Company'
                WHEN 'ProfessionalEducation' IN labels(neighbor) THEN 'ProfessionalEducation'
                WHEN 'Certification' IN labels(neighbor) THEN 'Certification'
                WHEN 'Project' IN labels(neighbor) THEN 'Project'
                ELSE labels(neighbor)[0]
            END AS EntityType,
            properties(neighbor) AS Details,
            collect(DISTINCT ref.url) AS ref_urls,
            type(r) AS RelationshipType
        LIMIT 30
        """
        try:
            result = self._exec_query(
                query,
                node_id=node_id,
                node_name=node_name,
                **self._security_params(),
                allowed_labels=DISCOVERY_LABELS
            )
            
            output = []
            for record in result.records:
                details = record["Details"]
                details.pop("embedding", None)
                details.pop("tenant_id", None)
                details["links"] = record["ref_urls"]
                
                output.append({
                    "name": details.get("name") or details.get("text") or details.get("description") or record["EntityType"],
                    "type": record["EntityType"],
                    "Relationship": record["RelationshipType"],
                    "Details": details
                })
            return json.dumps(output, indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})

    def _inject_federated_demo_boost(self) -> str:
        return "WHEN 'ExternalSilo' IN labels(node) AND any(w IN keywords WHERE w IN ['silo', 'silos', 'external', 'lakehouse', 'iceberg']) THEN 1000"

    def search_enterprise_graph(self, keyword: str, requesting_user_id: str = "", wants_visual_map: bool = False, domain_intent: str = "all", scoped_expansion: bool = False) -> str:
        """
        Search for entities across the Universal Enterprise Graph dynamically, explicitly crossing boundaries between domains (Podcast/Resume/Federated).

        scoped_expansion: set deterministically by the gateway for bridge/cross_domain entity
        queries only (never LLM-chosen — AP-20 pattern). Caps the taxonomy-expansion anchor
        fan-out to SEARCH_EXPANSION_LIMIT_SCOPED instead of the default practical-no-op limit.
        See domain_registry.py and documents/architecture/search-enterprise-graph-expansion-cap-2026-08-27.md.
        """
        # Career cluster shortcut: only fire when the LLM explicitly signals wants_visual_map=True.
        # Keyword-based triggering (checking for "career", "map", etc.) is suppressed because it
        # intercepts Q2 career map queries, returning backbone-only nodes that fail the
        # CAREER_CHAT_NODE_TYPES filter in the gateway and produce ungrounded LLM responses.
        if wants_visual_map and domain_intent in ("professional", "all"):
            return self.get_cluster_context("Sangeetha Ramadurai", depth=1, backbone_only=True, domain="professional")

        discovery_synonyms = ["portfolio", "overview", "background", "experience", "career", "map"]
        is_discovery_request = any(s in keyword.lower() for s in discovery_synonyms)

        stop_words = {"show", "me", "how", "did", "she", "what", "is", "the", "and", "a", "an", "at", "in", "of", "for", "with", "on", "to", "from", "by"}
        clean_keyword = keyword.lower().replace(".", "").replace(",", "").replace("?", "").replace("!", "")
        keywords = [w for w in clean_keyword.split() if w not in stop_words]
        final_keyword_str = " ".join(keywords) if keywords else keyword

        search_keyword = final_keyword_str
        if is_discovery_request and domain_intent != "podcast":
            search_keyword = "Category " + final_keyword_str if final_keyword_str else "Category"

        from domain_registry import get_authorized_labels, get_backbone_labels, get_anchor_labels
        
        keywords_list = [w.lower() for w in keyword.split() if len(w) > 2]
        if not keywords_list:
            keywords_list = [keyword.lower()]
        
        anchor_labels = get_anchor_labels(domain_intent)
        temporal_keywords = ["currently", "working", "now", "present", "active", "recent", "recently", "latest"]
        has_temporal_intent = any(tk in keyword.lower() for tk in temporal_keywords)

        from domain_registry import get_discovery_label_string, get_visual_deny_list
        discovery_labels = get_discovery_label_string()
        visual_deny_list = get_visual_deny_list()

        # AP-1: Build MATCH label string from authorized labels for this domain (inclusion-based).
        # domain_intent="all" falls back to discovery_labels (full union) for cross-domain queries.
        if domain_intent.lower() == "all":
            match_label_string = discovery_labels
        else:
            _authorized = get_authorized_labels(domain_intent) or []
            match_label_string = "|".join(_authorized) if _authorized else discovery_labels

        query = f"""
        {self._fragment_taxonomy_expansion()}

        MATCH (node:{match_label_string})
        WHERE ({self._get_security_clause("node")})
          AND (
                elementId(node) IN expanded_ids
                OR toLower(node.name) CONTAINS toLower($keyword) 
                OR toLower(node.title) CONTAINS toLower($keyword)
                OR toLower(node.description) CONTAINS toLower($keyword)
                OR any(word IN $keywords WHERE toLower(word) = toLower(labels(node)[0]))
          )
        
        {self._fragment_neighbor_aggregation()}
        {self._fragment_narrative_aggregation()}
        
        WITH collect(DISTINCT node) AS matchedNodes,
             apoc.coll.flatten(collect(DISTINCT neighbors)) AS allNeighbors,
             apoc.coll.flatten(collect(DISTINCT rels)) AS allRels,
             apoc.coll.flatten(collect(DISTINCT narratives)) AS allNarratives
             
        WITH apoc.coll.toSet(matchedNodes + [n IN allNeighbors WHERE n IS NOT NULL]) AS allNodes,
             [r IN allRels WHERE r IS NOT NULL] AS allRels
             
        UNWIND allNodes AS node
        
        // Final enrichment of each node for the UI
        OPTIONAL MATCH (node)-[:HAS_REFERENCE]->(ref:ReferenceLink)
        OPTIONAL MATCH (node)-[:USES_TOOL]->(tech:Technology)
        OPTIONAL MATCH (node)-[:HAS_NOTE]->(note:Note)
        WHERE ({self._get_security_clause("note")})

        WITH node, allNodes, allRels,
             collect(DISTINCT coalesce(ref.url, ref.link, ref.neighborUrl)) AS cluster_ref_urls,
             collect(DISTINCT tech.name) AS cluster_tech_urls,
             collect(DISTINCT note.text) AS notes

        WITH allNodes, allRels,
             collect(DISTINCT {{
                id: elementId(node),
                node_id: node.node_id,
                name: node.name,
                type: CASE
                    WHEN 'Category' IN labels(node) THEN 'Category'
                    WHEN 'Role' IN labels(node) THEN 'Role'
                    WHEN 'ThoughtLeadership' IN labels(node) THEN 'ThoughtLeadership'
                    WHEN 'Startup' IN labels(node) THEN 'Startup'
                    WHEN 'Company' IN labels(node) THEN 'Company'
                    WHEN 'Project' IN labels(node) THEN 'Project'
                    WHEN 'Episode' IN labels(node) THEN 'Episode'
                    WHEN 'Technology' IN labels(node) THEN 'Technology'
                    WHEN 'Topic' IN labels(node) THEN 'Topic'
                    ELSE labels(node)[0]
                END,
                description: left(coalesce(node.description, node.text, ""), 500),
                text: apoc.text.join(notes, "\n---\n"),
                url: node.url,
                link: node.link,
                links: [l IN apoc.coll.toSet(coalesce(node.links, []) + cluster_ref_urls + [node.url, node.link]) WHERE l IS NOT NULL AND l <> ""],
                technologies: [t IN cluster_tech_urls WHERE t IS NOT NULL AND t <> ""],
                isPresent: node.isPresent,
                endDate: node.endDate,
                endYear: node.endYear
             }}) AS uiNodes

        RETURN uiNodes AS nodes,
               [rel IN allRels WHERE rel IS NOT NULL | {{
                  source: elementId(startNode(rel)),
                  target: elementId(endNode(rel)),
                  type: type(rel)
               }}] AS links
        LIMIT 1
        """
        # Phase 3: Hybrid Search Fallback
        embedding = None
        try:
            if len(keywords_list) > 0:
                embedding = self.get_embedding(" ".join(keywords_list))
        except Exception as e:
            print(f"Warning: Failed to fetch embedding for search_enterprise_graph: {e}")

        try:
            # AP-2: get_authorized_labels returns None for "all" → Cypher $allowed_labels IS NULL → neighbor filter bypassed.
            allowed_labels = get_authorized_labels(domain_intent)
            from domain_registry import (
                SEARCH_NEIGHBOR_LIMIT_DEFAULT, SEARCH_NEIGHBOR_LIMIT_SCOPED,
                SEARCH_EXPANSION_LIMIT_DEFAULT, SEARCH_EXPANSION_LIMIT_SCOPED,
            )
            neighbor_limit = SEARCH_NEIGHBOR_LIMIT_SCOPED if scoped_expansion else SEARCH_NEIGHBOR_LIMIT_DEFAULT
            expansion_limit = SEARCH_EXPANSION_LIMIT_SCOPED if scoped_expansion else SEARCH_EXPANSION_LIMIT_DEFAULT

            print(f"[SEARCH] Running '{domain_intent}' enterprise search for user: {requesting_user_id} (scoped_expansion={scoped_expansion})")
            result = self._exec_query(
                query,
                **self._security_params(),
                keyword=keyword,
                keywords=keywords_list,
                anchorLabels=anchor_labels,
                allowed_labels=allowed_labels,
                has_temporal_intent=has_temporal_intent,
                embedding=embedding,
                owner_id=os.environ.get("OWNER_USER_ID"),
                neighbor_limit=neighbor_limit,
                expansion_limit=expansion_limit
            )
            
            # --- SELF-CORRECTION FALLBACK ---
            if not result.records and embedding is not None:
                print(f"[SEARCH] No results for '{keyword}'. Attempting broader semantic fallback...")
                fallback_query = f"""
                MATCH (node)
                WHERE node.embedding IS NOT NULL
                  AND ({self._get_security_clause("node")})
                WITH node, vector.similarity.cosine($embedding, node.embedding) AS score
                WHERE score > 0.7
                WITH node, score
                ORDER BY score DESC
                LIMIT 10
                RETURN collect(node {{ .*, labels: labels(node), temporal_boost: score * 100 }}) AS nodes, [] AS links
                """
                result = self._exec_query(
                    fallback_query,
                    **self._security_params(),
                    embedding=embedding,
                )

            backbone_labels = get_backbone_labels()
            output = []
            if not result.records:
                return json.dumps({"nodes": [], "links": []})
                
            record = result.records[0]
            nodes = record["nodes"]
            # Cypher returns links with source/target as elementId — use directly.
            # Do NOT rebuild from node["relationships"]: that dict uses field "element_id"
            # which is not set (Cypher uses "id"), so rebuilding yields an empty list.
            cypher_links = record["links"]

            # Serialize and Clean nodes
            for node in nodes:
                for k, v in node.items():
                    if hasattr(v, 'iso_format'):
                        node[k] = v.iso_format()
                    elif isinstance(v, list):
                        node[k] = [i.iso_format() if hasattr(i, 'iso_format') else i for i in v]
                node.pop("embedding", None)
                node.pop("tenant_id", None)

            output = nodes

            # 2.5 Narrative Sanitization (Professional Polish)
            # Remove internal STAR headers from notes before they reach the LLM/UI.
            for node in output:
                if node.get("narratives"):
                    node["narratives"] = [self._sanitize_narrative(n) for n in node["narratives"] if n]

            # 3. Visual Bouncer (Cleanliness & Zero-Trust)
            # We keep the narratives for the LLM, but strip the nodes from the Visual Graph.
            # visual_deny_list is already imported and defined above
            
            clean_output = []
            for node in output:
                node_labels = node.get("labels", [])
                if not any(label in visual_deny_list for label in node_labels):
                    clean_output.append(node)
            
            # Filter Cypher links to only those whose endpoints survived the visual bouncer.
            # Nodes use field "id" (= elementId from Cypher), not "element_id".
            valid_ids = {n.get("id") or n.get("element_id") for n in clean_output}
            valid_ids.discard(None)
            final_links = [l for l in cypher_links if l.get("source") in valid_ids and l.get("target") in valid_ids]

            # 4. Role Orbit (Virtual Projection)
            # Center projects around their roles even if roles aren't separate nodes in Neo4j.
            virtual_role_nodes = []
            virtual_role_links = []
            seen_roles = set()
            for node in clean_output:
                if 'Project' in node.get('labels', []) and node.get('role'):
                    role_name = node['role']
                    role_id = f"role_{role_name.lower().replace(' ', '_')}"
                    if role_name not in seen_roles:
                        virtual_role_nodes.append({
                            "id": role_id,
                            "element_id": role_id,
                            "name": role_name,
                            "display_name": role_name,
                            "type": "Role",
                            "labels": ["Role", "VirtualLandmark"],
                            "is_anchor": True
                        })
                        seen_roles.add(role_name)
                    
                    virtual_role_links.append({
                        "source": role_id,
                        "target": node['element_id'],
                        "type": "ROLE_FOR"
                    })
            
            clean_output.extend(virtual_role_nodes)
            final_links.extend(virtual_role_links)

            return json.dumps({"nodes": clean_output, "links": final_links}, indent=2)
        except Exception as e:
            import traceback
            print(f"Error in search_enterprise_graph: {e}")
            traceback.print_exc()
            return json.dumps({"error": str(e)})



    def explore_graph_schema(self, schema_readable: bool = False) -> str:
        """
        Introspect the Neo4j database to find exactly what Node Labels and Relationships exist.
        """
        if not schema_readable:
            return json.dumps({"error": "Access Denied: Schema Readable permission required to introspect the graph ontology."})

        query = "CALL db.schema.visualization() YIELD relationships RETURN relationships"
        try:
            with self.driver.session() as session:
                res = session.run(query)
                schema_rules = []
                for r in res:
                    for rel in r["relationships"]:
                        start = rel.start_node.labels[0] if rel.start_node.labels else "Unknown"
                        end = rel.end_node.labels[0] if rel.end_node.labels else "Unknown"
                        
                        if rel.type not in ["SIMILAR", "IS_SIMILAR", "SEMANTICALLY_SIMILAR_KNN"]:
                            schema_rules.append(f"({start})-[:{rel.type}]->({end})")
                
                unique_rules = sorted(list(set(schema_rules)))
                return json.dumps({"Active_Database_Schema": unique_rules}, indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})

    def get_cluster_context(self, node_name: Optional[str] = None, depth: int = 1, backbone_only: bool = False, domain: str = "all", node_id: Optional[str] = None) -> str:
        """
        Fetch the semantic neighbors and relationships for a specific node to expand the graph view.
        Uses Progressive Discovery (Backbone-First) and Domain Masking to maintain scalability and clarity.
        """
        if not node_name and not node_id:
            return json.dumps({"error": "node_name or node_id is required"})
        safe_depth = max(1, min(depth, 2))
        
        # 1. Progressive Discovery Filter
        backbone_filter = ""
        if backbone_only:
            from domain_registry import get_backbone_labels
            backbone_labels_list = get_backbone_labels(domain)
            backbone_filter = "AND any(label IN labels(m) WHERE label IN $backbone_labels_list)"

        # 2. Domain Masking Filter (Positive Schema Sovereignty)
        from domain_registry import get_authorized_labels
        authorized_labels = get_authorized_labels(domain)
        
        domain_filter = ""
        if authorized_labels:
            domain_filter = "AND any(label IN labels(m) WHERE label IN $authorized_labels)"

        from domain_registry import get_discovery_label_string, get_bridge_label_string, get_visual_deny_list
        bridge_labels = get_bridge_label_string()

        # AP-11: neighbor-hop traversal must use the same TRAVERSAL_RELATIONSHIPS whitelist
        # and SYSTEM non-primitive guard as _fragment_neighbor_aggregation, rather than an
        # untyped [*1..depth]. Applied across every node/relationship in the path (not just
        # the terminal `m`), matching the existing ALL(node IN nodes(path) WHERE NOT
        # node:{bridge_labels}) style already used for bridge-label exclusion below.
        from schema_guard import TRAVERSAL_RELATIONSHIPS
        traversal_whitelist = json.dumps(TRAVERSAL_RELATIONSHIPS)

        # Identify the node by node_id (UUID, preferred — durable across a Neo4j
        # restore/recycle event, unlike elementId), elementId (backward compatibility), or
        # name. Kept as two separate guarded parameters — not aliased into one — so a caller
        # that supplies both doesn't have the ID-based match silently discarded, and so the
        # Cypher text itself documents which parameter means what.
        query = """
        MATCH (n)
        WHERE (
              ($node_id <> "" AND (n.node_id = $node_id OR elementId(n) = $node_id))
           OR ($node_name <> "" AND (toLower(n.name) = toLower($node_name) OR n.name CONTAINS $node_name))
        )
          AND ({sec_n})
          AND NOT n:{bridge_labels}
        
        OPTIONAL MATCH path = (n)-[*1..{safe_depth}]-(m)
        WHERE ({sec_m})
          AND ALL(node IN nodes(path) WHERE NOT node:{bridge_labels})
          AND ALL(r IN relationships(path) WHERE type(r) IN {traversal_whitelist})
          AND ALL(node IN nodes(path) WHERE node.tenant_id <> 'SYSTEM' OR labels(node)[0] IN ['Technology','Concept','Topic','Category'])
          {backbone_filter}
          {domain_filter}
        
        WITH n, collect(path) AS paths
        UNWIND (CASE WHEN size(paths) = 0 THEN [null] ELSE paths END) AS p
        WITH n, nodes(p) AS pathNodes, relationships(p) AS pathRels
        UNWIND (CASE WHEN pathNodes IS NULL THEN [n] ELSE pathNodes END) AS node
        UNWIND (CASE WHEN pathRels IS NULL THEN [null] ELSE pathRels END) AS rel
        
        OPTIONAL MATCH (node)-[:HAS_REFERENCE]->(ref:ReferenceLink)
        OPTIONAL MATCH (node)-[:USES_TOOL]->(tech:Technology)
        OPTIONAL MATCH (p:Person)-[roleRel:CURRENTLY_BUILDING|HELD_ROLE|PARTICIPATED_IN|AUTHORED|CO_AUTHORED|CERTIFIED_BY|STUDIED_AT|GRADUATED_FROM|CONTRIBUTED_TO|FEATURE_GUEST|BUILT_DURING]-(node)
        WHERE ({sec_p})

        OPTIONAL MATCH (node)-[:HAS_NOTE]->(note:Note)
        WHERE ({sec_note})

        WITH node, rel, roleRel,
             collect(DISTINCT coalesce(ref.url, ref.link, ref.neighborUrl)) AS cluster_ref_urls,
             collect(DISTINCT tech.name) AS cluster_tech_urls,
             collect(DISTINCT note.text) AS notes

        WITH node, rel, roleRel, cluster_tech_urls, notes,
             apoc.coll.toSet(coalesce(node.links, []) + cluster_ref_urls + [node.url, node.link]) AS fused_links

        WITH
             collect(DISTINCT {
                id: elementId(node),
                node_id: node.node_id,
                name: node.name,
                type: CASE
                    WHEN 'Category' IN labels(node) THEN 'Category'
                    WHEN 'Role' IN labels(node) THEN 'Role'
                    WHEN 'Hackathon' IN labels(node) THEN 'Hackathon'
                    WHEN 'ThoughtLeadership' IN labels(node) THEN 'ThoughtLeadership'
                    WHEN 'Startup' IN labels(node) AND 'Project' IN labels(node) THEN 'Startup'
                    WHEN 'Startup' IN labels(node) THEN 'Startup'
                    WHEN 'Company' IN labels(node) THEN 'Company'
                    WHEN 'Degree' IN labels(node) THEN 'Degree'
                    WHEN 'ProfessionalEducation' IN labels(node) THEN 'ProfessionalEducation'
                    WHEN 'Certification' IN labels(node) THEN 'Certification'
                    WHEN 'Project' IN labels(node) THEN 'Project'
                    WHEN 'Episode' IN labels(node) THEN 'Episode'
                    WHEN 'Technology' IN labels(node) THEN 'Technology'
                    WHEN 'Topic' IN labels(node) THEN 'Topic'
                    ELSE labels(node)[0]
                END,
                description: left(coalesce(node.description, node.text, ""), 500),
                text: apoc.text.join(notes, "\n---\n"),
                url: node.url,
                link: node.link,
                aired_date: node.aired_date,
                links: [l IN fused_links WHERE l IS NOT NULL AND l <> ""],
                technologies: [t IN cluster_tech_urls WHERE t IS NOT NULL AND t <> ""],
                displayDate: coalesce(
                    node.displayDate,
                    roleRel.start + (CASE WHEN roleRel.end IS NOT NULL THEN "-" + roleRel.end ELSE "" END),
                    node.startDate + (CASE WHEN node.endDate IS NOT NULL THEN "-" + node.endDate ELSE "" END),
                    roleRel.date,
                    node.date,
                    toString(node.year),
                    node.published_at,
                    "Active"
                ),
                startYear: coalesce(node.startYear, right(roleRel.start, 4), toString(node.year)),
                endYear: coalesce(node.endYear, right(roleRel.end, 4), toString(node.year)),
                isPresent: coalesce(node.isPresent, roleRel.end = "Present", false),
                role: roleRel.role,
                year: coalesce(
                    toString(node.year),
                    right(roleRel.end, 4),
                    right(roleRel.start, 4),
                    right(roleRel.date, 4),
                    right(node.date, 4),
                    left(node.published_at, 4),
                    "2026"
                )
             }) AS allNodes,
             collect(DISTINCT rel) AS allRels
             
        // Hard node limit for Progressive Discovery
        WITH allNodes[0..50] AS nodes,
             [rel IN allRels WHERE rel IS NOT NULL AND any(n IN allNodes[0..50] WHERE n.id = elementId(startNode(rel))) 
                            AND any(n IN allNodes[0..50] WHERE n.id = elementId(endNode(rel))) | {
                source: elementId(startNode(rel)),
                target: elementId(endNode(rel)),
                type: type(rel)
             }] AS links,
             [n IN allNodes[0..10] | {
                name: n.name,
                type: n.type,
                highlight: left(n.description, 80) + "..."
             }] AS snapshot
             
        RETURN nodes, links, snapshot
        LIMIT 1
        """
        query = query.replace("{safe_depth}", str(safe_depth)).replace("{bridge_labels}", bridge_labels).replace("{backbone_filter}", backbone_filter).replace("{domain_filter}", domain_filter).replace("{traversal_whitelist}", traversal_whitelist)
        query = query.replace("{sec_n}", self._get_security_clause("n")).replace("{sec_m}", self._get_security_clause("m")).replace("{sec_p}", self._get_security_clause("p")).replace("{sec_note}", self._get_security_clause("note"))
        try:
            from domain_registry import get_backbone_labels
            backbone_labels_list = get_backbone_labels(domain)
            result = self._exec_query(
                query,
                **self._security_params(),
                node_id=node_id or "",
                node_name=node_name or "",
                backbone_labels_list=backbone_labels_list,
                authorized_labels=authorized_labels,
                keyword="",
                keywords=[],
                anchorLabels=[],
                embedding=None,
                owner_id=os.environ.get("OWNER_USER_ID")
            )
            if not result.records:
                return json.dumps({"error": f"Node '{node_name or node_id}' not found."})
            
            record = result.records[0]
            return json.dumps({
                "nodes": record["nodes"],
                "links": record["links"],
                "snapshot": record["snapshot"]
            }, indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})

    def connect_knowledge_on_demand(
        self,
        source_node_id: Optional[str] = None,
        source_node_name: Optional[str] = None,
        target_domain: str = "all",
        min_anchors: int = 1,
        limit: Optional[int] = None,
        target_node_name: Optional[str] = None,
        query_context: Optional[str] = None,
    ) -> str:
        """
        Discover virtual cross-domain knowledge bridges for a specific node.

        Finds the shortest weighted path — every relationship type is eligible, no
        hardcoded relationship-type whitelist — from the source node to each candidate
        node in the requested domain, within the security/domain-authorized subgraph.
        Path weight applies a logarithmic, tenant-agnostic penalty for high-degree hub
        nodes (e.g. "AI") so generic landmarks don't dominate every bridge.

        source_node_id (2026-08-03): accepts either the stable node_id UUID (preferred)
        or elementId (accepted for backward compatibility with existing callers). Prefer
        node_id — elementId is a Neo4j-internal identifier not guaranteed durable across
        a database restore or node recycling; node_id is the app-managed UUID meant for
        any reference that outlives a single request.

        min_anchors is accepted for MCP tool-schema backward compatibility but is a
        no-op — bridges are single weighted paths now, not anchor-count matches.

        limit defaults to domain_registry.BRIDGE_DEFAULT_LIMIT (env-var configurable) and
        is clamped to domain_registry.BRIDGE_MAX_LIMIT regardless of what's requested.

        target_node_name (2026-07-23): when the caller already knows a specific target
        (e.g. it's named literally in the user's question), pass it here — if resolved,
        it's guaranteed to appear in the results as an ADDITIONAL bridge beyond `limit`,
        regardless of where it would otherwise rank by path weight. Exact match preferred,
        CONTAINS fallback, restricted to nodes matching target_domain (a hint outside the
        requested domain is reported as not found rather than silently expanding scope).

        query_context (2026-07-23): free text — normally the user's original question —
        used to make ranking query-aware for the case where no specific target is known.
        Hops into a node whose name literally matches a keyword extracted from this text
        get a weight discount (domain_registry.BRIDGE_RELEVANCE_DISCOUNT), so e.g. a
        question mentioning "governance" ranks a bridge through a "Governance" node above
        an equally-cheap bridge through an unrelated node. Deliberately literal keyword
        matching, not embedding similarity — keeps every ranking decision traceable to an
        actual matched word (Invariant 11 grounding), at the cost of missing non-literal
        matches (e.g. "AI ethics" vs. "Governance").

        Zero-write guarantee: nothing is persisted to Neo4j. All returned links are
        session-only virtual bridges rendered as gold dashed lines in the UI.
        """
        if not source_node_id and not source_node_name:
            return json.dumps({"error": "source_node_id or source_node_name is required"})

        from domain_registry import get_authorized_labels, get_bridge_label_string, get_bridge_limit
        limit = get_bridge_limit(limit)
        relevance_keywords = self._extract_bridge_keywords(query_context)

        # Map target domain to allowed labels
        target_labels_raw = get_authorized_labels(target_domain)
        # For "all", get_authorized_labels returns None — use a broad default
        if not target_labels_raw:
            target_labels_raw = [
                "Project", "Role", "Company", "Hackathon", "ThoughtLeadership",
                "Publication", "Episode", "Topic", "Podcast", "Certification",
                "Institution", "Category", "Technology", "Concept"
            ]
        target_domain_labels = set(target_labels_raw)
        bridge_labels = get_bridge_label_string()

        # Bridge discovery is a READ-ONLY operation on content already visible to the user
        # (they clicked the node in the graph, so it was already authorized at tenant level).
        # Re-applying full ownership check here blocks cross-user org content. Use tenant-level
        # read access for the source — any org member can initiate a bridge from tenant content.
        sec_source_read = f"""
        (
            source.tenant_id IN ['SYSTEM', 'PUBLIC']
            OR source.tenant_id = $tenant_id
        )
        """
        sec_a = self._get_security_clause("a")
        sec_b = self._get_security_clause("b")

        try:
            # Step 1: Resolve the source node. Exact match preferred; CONTAINS fallback for a
            # paraphrased name (a bare exact-match lookup silently returns nothing if the LLM
            # doesn't pass the literal node name). Bridge-label nodes excluded so a fuzzy match
            # can't resolve to a Chunk/PreparatoryNote/etc. (AP-19).
            # Accepts both the stable node_id UUID (preferred — elementId is not guaranteed
            # durable across a Neo4j restore/recycle event, see
            # documents/architecture/node-context-inference-2026-08-03.md) and elementId (for
            # backward compatibility with existing callers that still pass it).
            source_query = f"""
            MATCH (source)
            WHERE NOT source:{bridge_labels}
              AND (source.node_id = $source_node_id
                   OR elementId(source) = $source_node_id
                   OR toLower(source.name) = toLower($source_node_name)
                   OR source.name CONTAINS $source_node_name)
              AND ({sec_source_read})
            RETURN elementId(source) AS source_eid, source.name AS source_name,
                   CASE WHEN source.node_id = $source_node_id
                          OR elementId(source) = $source_node_id
                          OR toLower(source.name) = toLower($source_node_name)
                        THEN 0 ELSE 1 END AS match_rank
            ORDER BY match_rank ASC, size(source.name) ASC
            LIMIT 1
            """
            source_result = self._exec_query(
                source_query,
                **self._security_params(),
                # sec_source_read always uses $tenant_id. _security_params() omits tenant_id
                # only in guest_share_anchor mode — supply it there explicitly.
                **({"tenant_id": self.tenant_id} if self.guest_share_anchor else {}),
                source_node_id=source_node_id or "",
                source_node_name=source_node_name or "",
            )

            if not source_result.records:
                return json.dumps({
                    "nodes": [],
                    "virtual_links": [],
                    "bridge_summary": f"No source node found matching '{source_node_name or source_node_id}'.",
                    "confidence_tier": "none"
                })

            source_row = source_result.records[0]
            source_eid = source_row["source_eid"]
            source_name = source_row["source_name"]

            # Step 2: Fetch the full security/domain-authorized adjacency. No relationship-type
            # filter at all — every type is eligible, which is the whole point of this redesign
            # (the old hardcoded whitelist missed WORKED_AT/CONTRIBUTED_TO, among others).
            # Bridge-label nodes are excluded on BOTH endpoints of every edge, so they can never
            # enter the adjacency list — stronger than an endpoint-only post-filter and avoids
            # the AP-19 failure mode (a bridge-label node blocking all downstream traversal) by
            # construction rather than by a post-hoc check. sec_a/sec_b already reference
            # $tenant_id exactly when _security_params() supplies it (both derive from the same
            # _get_security_clause branching), so no extra guest-mode kwarg is needed here.
            edge_query = f"""
            MATCH (a)-[r]-(b)
            WHERE NOT a:{bridge_labels} AND NOT b:{bridge_labels}
              AND ({sec_a}) AND ({sec_b})
            RETURN elementId(a) AS a_id, a.name AS a_name, labels(a) AS a_labels,
                   a.node_id AS a_node_id, a.description AS a_description,
                   elementId(b) AS b_id, b.name AS b_name, labels(b) AS b_labels,
                   b.node_id AS b_node_id, b.description AS b_description,
                   type(r) AS rel_type,
                   COUNT {{ (a)--() }} AS deg_a, COUNT {{ (b)--() }} AS deg_b
            """
            edge_result = self._exec_query(edge_query, **self._security_params())

            adjacency: dict = {}
            node_info: dict = {}

            def _remember(nid, name, labels_, node_id_, description_):
                if nid not in node_info:
                    node_info[nid] = {
                        "name": name,
                        "type": labels_[0] if labels_ else "Unknown",
                        "labels": labels_ or [],
                        "node_id": node_id_,
                        "description": description_ or "",
                    }

            for rec in edge_result.records:
                a_id, b_id, rel_type = rec["a_id"], rec["b_id"], rec["rel_type"]
                deg_a, deg_b = rec["deg_a"], rec["deg_b"]
                _remember(a_id, rec["a_name"], rec["a_labels"], rec["a_node_id"], rec["a_description"])
                _remember(b_id, rec["b_name"], rec["b_labels"], rec["b_node_id"], rec["b_description"])
                adjacency.setdefault(a_id, []).append((b_id, rel_type, deg_b))
                adjacency.setdefault(b_id, []).append((a_id, rel_type, deg_a))

            # Candidate targets: any node in the authorized subgraph whose labels intersect the
            # target domain, excluding the source itself (matches labels() in full, not just the
            # primary label, so dual-labeled nodes like Project+ThoughtLeadership still qualify).
            candidate_targets = {
                nid for nid, info in node_info.items()
                if nid != source_eid and target_domain_labels & set(info["labels"])
            }

            if not candidate_targets:
                return json.dumps({
                    "nodes": [],
                    "virtual_links": [],
                    "bridge_summary": f"No candidate nodes found in target domain '{target_domain}'.",
                    "confidence_tier": "none"
                })

            # Resolve an explicit target hint (2026-07-23), if given, against the already-fetched
            # node_info — no extra Cypher round trip needed. Restricted to candidate_targets so a
            # hint outside target_domain can't silently widen scope. Exact match preferred,
            # CONTAINS fallback with shortest-name tiebreak, mirroring the source resolution above.
            must_include_id = None
            target_hint_unresolved = False
            if target_node_name:
                tnl = target_node_name.strip().lower()
                exact = [nid for nid in candidate_targets if node_info[nid]["name"] and node_info[nid]["name"].lower() == tnl]
                if exact:
                    must_include_id = exact[0]
                else:
                    contains = [nid for nid in candidate_targets if node_info[nid]["name"] and tnl in node_info[nid]["name"].lower()]
                    if contains:
                        contains.sort(key=lambda nid: len(node_info[nid]["name"]))
                        must_include_id = contains[0]
                if must_include_id is None:
                    target_hint_unresolved = True

            must_include = {must_include_id} if must_include_id else set()

            found = self._dijkstra_to_targets(
                adjacency, source_eid, candidate_targets, limit,
                node_info=node_info, relevance_keywords=relevance_keywords, must_include=must_include,
            )

            if not found:
                return json.dumps({
                    "nodes": [],
                    "virtual_links": [],
                    "bridge_summary": f"No path found from '{source_name}' to any node in target domain '{target_domain}' within the authorized subgraph.",
                    "confidence_tier": "none"
                })

            ranked_organic = sorted(found.items(), key=lambda kv: kv[1][0])[:limit]
            ranked_ids = {tid for tid, _ in ranked_organic}
            # "Additional, on top of limit" — a resolved target hint is guaranteed a slot even if
            # it wouldn't otherwise make the top-`limit` cut, rather than bumping an organic result.
            extra_targets = [
                (must_include_id, found[must_include_id])
            ] if must_include_id and must_include_id in found and must_include_id not in ranked_ids else []
            ranked = ranked_organic + extra_targets

            nodes_by_id: dict = {}
            virtual_links = []

            for target_eid, (weight, path, rels) in ranked:
                rel_chain = " → ".join(rels)

                # Every hop becomes one VIRTUAL_BRIDGE link, labeled with the real relationship
                # traversed — more groundable (Invariant 11) than the old "Shared: <anchor>"
                # label, since it exposes the actual relationship chain rather than an inferred
                # shared-concept grouping.
                for i in range(len(path) - 1):
                    virtual_links.append({
                        "source": path[i],
                        "target": path[i + 1],
                        "type": "VIRTUAL_BRIDGE",
                        "discovery_reason": f"via {rels[i]}"
                    })

                for node_id in path:
                    if node_id == source_eid or node_id in nodes_by_id:
                        continue
                    info = node_info[node_id]
                    entry = {
                        "id": node_id,
                        "element_id": node_id,
                        "node_id": info["node_id"],
                        "name": info["name"],
                        "type": info["type"],
                        "has_federated_bridge": True,
                    }
                    if node_id == target_eid:
                        entry.update({
                            "description": info["description"],
                            "is_bento_eligible": True,
                            "bridge_reason": f"Connected via: {rel_chain}"
                        })
                    else:
                        entry.update({
                            "is_bridge": True,
                            "is_bento_eligible": False,
                        })
                    nodes_by_id[node_id] = entry

            # Confidence: short, low-hub-penalty paths are "explicit"; longer or hub-heavy paths
            # are "taxonomy_expanded". Kept as the same three enum values for UX compatibility —
            # semantics now reflect path quality rather than IS_A/SUB_TOPIC_OF expansion (no
            # downstream gateway/UI code branches on this value beyond passing it through).
            best_weight, best_path, _ = found[ranked[0][0]]
            best_hops = len(best_path) - 1
            confidence_tier = "explicit" if (best_hops <= 2 and best_weight <= best_hops * 2) else "taxonomy_expanded"

            bridge_clauses = [
                f"{source_name} → {node_info[target_eid]['name']} via {' → '.join(rels)}"
                for target_eid, (weight, path, rels) in ranked_organic[:5]
            ]
            bridge_clauses += [
                f"{source_name} → {node_info[target_eid]['name']} via {' → '.join(rels)} (explicitly requested)"
                for target_eid, (weight, path, rels) in extra_targets
            ]
            bridge_summary = f"Found {len(ranked)} cross-domain bridge(s). " + "; ".join(bridge_clauses) + "."
            if target_hint_unresolved:
                bridge_summary += f" Note: requested target '{target_node_name}' was not found in domain '{target_domain}'."

            return json.dumps({
                "nodes": list(nodes_by_id.values()),
                "virtual_links": virtual_links,
                "bridge_summary": bridge_summary,
                "confidence_tier": confidence_tier
            }, indent=2)

        except Exception as e:
            import traceback
            traceback.print_exc()
            return json.dumps({"error": str(e)})

    # Domain-specific additions to a plain English stopword list for _extract_bridge_keywords —
    # words that show up in nearly every Q3-style question ("decision trace", "how did X
    # influence Y") and would otherwise match too broadly to carry any relevance signal.
    # Shared by both connect_knowledge_on_demand and infer_context_on_demand's query-aware
    # ranking (2026-08-03) — both rank hops/neighbors by literal keyword match, so one
    # stopword list serves both rather than duplicating it.
    _BRIDGE_QUERY_STOPWORDS = frozenset({
        "the", "a", "an", "of", "to", "and", "or", "is", "are", "was", "were", "did", "does",
        "do", "what", "how", "why", "when", "where", "who", "which", "this", "that", "these",
        "those", "in", "on", "at", "for", "with", "from", "by", "as", "it", "its", "be", "been",
        "has", "have", "had", "will", "would", "could", "should", "can", "may", "might",
        "trace", "work", "decision", "eventually", "influence", "influenced", "shape", "shaped",
    })

    @classmethod
    def _extract_bridge_keywords(cls, query_context: Optional[str]) -> set:
        """Lowercase word-level keywords from a free-text query — shared query-aware ranking
        helper for connect_knowledge_on_demand and infer_context_on_demand. Literal matching
        only (no stemming/embeddings) — see the query_context docstring on
        connect_knowledge_on_demand for why."""
        if not query_context:
            return set()
        words = re.findall(r"[a-zA-Z]{2,}", query_context.lower())
        return {w for w in words if w not in cls._BRIDGE_QUERY_STOPWORDS}

    @staticmethod
    def _dijkstra_to_targets(
        adjacency: dict,
        source_id: str,
        targets: set,
        limit: int,
        node_info: Optional[dict] = None,
        relevance_keywords: Optional[set] = None,
        must_include: Optional[set] = None,
    ) -> dict:
        """Single-source Dijkstra with a logarithmic hub-degree edge penalty, over an
        already-fetched adjacency dict of {node_id: [(neighbor_id, rel_type, neighbor_degree)]}.

        When relevance_keywords is given, a hop into a node whose name (via node_info) literally
        contains one of those keywords gets its weight multiplied by
        domain_registry.BRIDGE_RELEVANCE_DISCOUNT — makes ranking query-aware without needing a
        caller to already know the target (2026-07-23).

        Stops once `limit` targets have been settled AND every id in `must_include` (if any) has
        been found — Dijkstra pops nodes in non-decreasing distance order, so the first `limit`
        targets popped are already the `limit` closest by weight; must_include just keeps the
        search running past that point until a specific known target is also settled (or proven
        unreachable), so a caller-supplied target hint isn't silently dropped for ranking outside
        the top-`limit` (2026-07-23).

        Returns {target_id: (total_weight, path_node_ids, path_rel_types)}.
        """
        import heapq
        import math

        from domain_registry import BRIDGE_RELEVANCE_DISCOUNT

        node_info = node_info or {}
        relevance_keywords = relevance_keywords or set()
        must_include = must_include or set()

        def edge_weight(neighbor_id: str, neighbor_degree: int) -> float:
            w = 1 + math.log(1 + neighbor_degree)
            if relevance_keywords:
                name = (node_info.get(neighbor_id, {}).get("name") or "").lower()
                if name and any(kw in name for kw in relevance_keywords):
                    w *= BRIDGE_RELEVANCE_DISCOUNT
            return w

        dist = {source_id: 0.0}
        prev: dict = {}
        visited: set = set()
        heap = [(0.0, source_id)]
        found: dict = {}
        remaining = set(targets)

        while heap:
            d, node = heapq.heappop(heap)
            if node in visited:
                continue
            visited.add(node)

            if node in remaining:
                path = [node]
                rels = []
                cur = node
                while cur in prev:
                    p, rel_type = prev[cur]
                    path.append(p)
                    rels.append(rel_type)
                    cur = p
                path.reverse()
                rels.reverse()
                found[node] = (d, path, rels)
                remaining.discard(node)
                still_need_must_include = bool(must_include - found.keys())
                if (len(found) >= limit and not still_need_must_include) or not remaining:
                    break

            for neighbor, rel_type, deg_neighbor in adjacency.get(node, []):
                if neighbor in visited:
                    continue
                nd = d + edge_weight(neighbor, deg_neighbor)
                if nd < dist.get(neighbor, float("inf")):
                    dist[neighbor] = nd
                    prev[neighbor] = (node, rel_type)
                    heapq.heappush(heap, (nd, neighbor))

        return found

    def _resolve_context_node(self, node_id: Optional[str], node_name: Optional[str]) -> Optional[dict]:
        """Resolve a single node for infer_context_on_demand. Accepts both n.node_id (UUID,
        as used by get_node_details) and elementId (as used by connect_knowledge_on_demand) —
        existing callers disagree on which one they pass, so this accepts either.

        Empty-string guards on $node_id/$node_name are deliberate: `n.name CONTAINS ""` is
        true for every node in Cypher, so an unguarded CONTAINS clause with an absent param
        would match arbitrarily. connect_knowledge_on_demand's source-resolution query has
        this same latent issue and only survives it via match_rank ordering rescuing the
        exact hit — guarded explicitly here instead of relying on that.
        """
        from domain_registry import get_bridge_label_string
        bridge_labels = get_bridge_label_string()
        sec_n = self._get_security_clause("n")
        sec_m = self._get_security_clause("m")

        query = f"""
        MATCH (n)
        WHERE NOT n:{bridge_labels}
          AND (
                ($node_id <> "" AND (n.node_id = $node_id OR elementId(n) = $node_id))
             OR ($node_name <> "" AND toLower(n.name) = toLower($node_name))
             OR ($node_name <> "" AND n.name CONTAINS $node_name)
          )
          AND ({sec_n})
        RETURN elementId(n) AS element_id,
               n.node_id AS node_id,
               n.name AS name,
               labels(n) AS labels,
               COUNT {{ (n)--(m) WHERE NOT m:{bridge_labels} AND ({sec_m}) }} AS degree,
               coalesce(n.displayDate,
                        n.startDate + (CASE WHEN n.endDate IS NOT NULL THEN "-" + n.endDate ELSE "" END),
                        n.date, toString(n.year), n.published_at, n.aired_date) AS display_date,
               CASE WHEN ($node_id <> "" AND (n.node_id = $node_id OR elementId(n) = $node_id))
                      OR ($node_name <> "" AND toLower(n.name) = toLower($node_name))
                    THEN 0 ELSE 1 END AS match_rank
        ORDER BY match_rank ASC, size(n.name) ASC
        LIMIT 1
        """
        result = self._exec_query(
            query,
            **self._security_params(),
            node_id=node_id or "",
            node_name=node_name or "",
        )
        if not result.records:
            return None
        r = result.records[0]
        return {
            "element_id": r["element_id"],
            "node_id": r["node_id"],
            "name": r["name"],
            "labels": r["labels"] or [],
            "degree": r["degree"] or 0,
            "display_date": r["display_date"],
        }

    def _collect_context_facts(self, element_id: str, keywords: set) -> list:
        """1-hop structural facts for infer_context_on_demand, grouped by (relationship type,
        direction), ranked by query-keyword match then ascending neighbor degree (same
        hub-avoidance principle as connect_knowledge_on_demand's log-degree edge weight — a
        specific, low-degree neighbor explains more than a generic hub), and hard-capped both
        per group and across groups so a high-degree node cannot produce an unbounded payload.

        NOT n:{bridge_labels} on the neighbor is security-relevant, not cosmetic: without it,
        PreparatoryNote/Chunk content could surface to a viewer not authorized for it.
        """
        from domain_registry import get_bridge_label_string, get_context_caps
        bridge_labels = get_bridge_label_string()
        sec_m = self._get_security_clause("m")
        per_cap, group_cap = get_context_caps()

        query = f"""
        MATCH (n) WHERE elementId(n) = $element_id
        MATCH (n)-[r]-(m)
        WHERE elementId(m) <> $element_id
          AND NOT m:{bridge_labels}
          AND m.name IS NOT NULL
          AND ({sec_m})

        WITH type(r) AS rel_type,
             CASE WHEN startNode(r) = n THEN 'outgoing' ELSE 'incoming' END AS direction,
             m.name AS neighbor_name,
             labels(m) AS neighbor_labels,
             COUNT {{ (m)--() }} AS neighbor_degree,
             coalesce(m.displayDate,
                      m.startDate + (CASE WHEN m.endDate IS NOT NULL THEN "-" + m.endDate ELSE "" END),
                      m.date, toString(m.year), m.published_at, m.aired_date) AS neighbor_date,
             CASE WHEN size($keywords) > 0
                   AND any(k IN $keywords WHERE toLower(coalesce(m.name, '')) CONTAINS k)
                  THEN 0 ELSE 1 END AS kw_rank

        ORDER BY kw_rank ASC, neighbor_degree ASC, neighbor_name ASC, rel_type ASC

        WITH rel_type, direction,
             collect({{ name: neighbor_name,
                        type: neighbor_labels[0],
                        labels: neighbor_labels,
                        degree: neighbor_degree,
                        date: neighbor_date,
                        keyword_match: kw_rank = 0 }})[0..{per_cap}] AS neighbors,
             count(*) AS total_count,
             min(kw_rank) AS best_kw_rank,
             min(neighbor_degree) AS best_degree

        RETURN rel_type AS relationship, direction, total_count, neighbors
        ORDER BY best_kw_rank ASC, best_degree ASC, relationship ASC, direction ASC
        LIMIT {group_cap}
        """
        result = self._exec_query(
            query,
            **self._security_params(),
            element_id=element_id,
            keywords=sorted(keywords) if keywords else [],
        )
        return [
            {
                "relationship": rec["relationship"],
                "direction": rec["direction"],
                "total_count": rec["total_count"],
                "neighbors": rec["neighbors"],
            }
            for rec in result.records
        ]

    def _render_fact_sentences(self, node_row: dict, facts: list, keywords: set) -> str:
        """Deterministic recitation of 1-hop structural facts — the hub/degree framing sentence,
        one sentence per (relationship, direction) group, and a keyword-priority sentence if
        applicable. Shared by _render_context_summary (inferred-only) and
        _render_combined_narrative (merged with authored content) so the two render paths can't
        drift. Returns "" when there are no facts — callers own the empty-state wording, since
        it differs (inferred-only vs. combined-with-authored vs. standalone tool)."""
        from domain_registry import CONTEXT_HUB_DEGREE_THRESHOLD

        if not facts:
            return ""

        name = node_row.get("name") or "This node"
        ntype = (node_row.get("labels") or ["Node"])[0]
        degree = node_row.get("degree", 0)
        is_hub = degree >= CONTEXT_HUB_DEGREE_THRESHOLD

        parts = []
        if is_hub:
            parts.append(
                f"{ntype} '{name}' is a high-connectivity landmark with {degree} connection(s) "
                f"visible in your authorized view; the most specific among them:"
            )
        else:
            parts.append(
                f"{ntype} '{name}' has {degree} connection(s) visible in your authorized view."
            )

        for group in facts:
            neighbor_strs = []
            for n in group["neighbors"]:
                date_part = f", {n['date']}" if n.get("date") else ""
                neighbor_strs.append(f"'{n['name']}' ({n['type']}{date_part})")
            joined = ", ".join(neighbor_strs)
            direction_word = "Incoming" if group["direction"] == "incoming" else "Outgoing"
            connector = "from" if group["direction"] == "incoming" else "to"
            total = group["total_count"]
            suffix = f" — {total} total" if total > len(group["neighbors"]) else ""
            parts.append(f"{direction_word} {group['relationship']} {connector} {joined}{suffix}.")

        if keywords:
            parts.append(f"Prioritized by match with: {', '.join(sorted(keywords))}.")

        return " ".join(parts)

    def _render_context_summary(self, node_row: dict, facts: list, keywords: set) -> str:
        """Deterministic f-string recitation of structural facts — no LLM call, exactly like
        connect_knowledge_on_demand's bridge_summary. Phrasing into fuller natural-language
        prose (if wanted) happens downstream, by whatever LLM consumes this — never here."""
        name = node_row.get("name") or "This node"
        ntype = (node_row.get("labels") or ["Node"])[0]

        if not facts:
            return (
                f"No connections visible in your authorized view for '{name}' ({ntype}), "
                f"and no narrative context is recorded for it."
            )

        sentences = self._render_fact_sentences(node_row, facts, keywords)
        return "Inferred from graph structure — no authored narrative exists for this node. " + sentences

    def _render_combined_narrative(self, authored_narratives: list, node_row: dict, facts: list, keywords: set) -> str:
        """Merges authored PreparatoryNote content with inferred structural facts into ONE
        narrative string, with inline provenance labels ("Authored:" / "Inferred from graph:")
        so a downstream consumer (e.g. the career-domain biographer LLM prompt) can still tell
        directly-stated fact from graph-derived inference apart, even though they're now
        combined. Reverses the 2026-08-03 "never merge" decision — see
        documents/architecture/node-context-inference-2026-08-03.md §5 addendum (2026-08-06).

        Deterministic string composition only — no LLM call. This is a permanent architectural
        guarantee shared with _render_context_summary/_render_fact_sentences, enforced by
        tdd/verify_infer_context.py::test_07_no_llm_call_in_layer via source inspection.

        - No authored content, facts present: inferred-only, no empty "Authored:" header —
          this is what makes the inferred narrative stand in for the narrative itself when no
          note exists, rather than being suppressed or shown as a secondary block.
        - Authored content present, facts present: both sections, in that order.
        - Authored content present, no facts: authored section only.
        - Neither: falls through to the same viewer-relative sparse wording
          _render_context_summary uses for its own no-facts case (never an absolute "has no
          connections" claim — a genuinely orphaned node and a node whose neighbors are all
          permission-masked must stay indistinguishable at this layer, by design).
        """
        authored = [n for n in (authored_narratives or []) if n]
        fact_sentences = self._render_fact_sentences(node_row, facts, keywords)

        if authored and fact_sentences:
            return "Authored: " + "\n\n".join(authored) + "\n\nInferred from graph: " + fact_sentences
        if authored:
            return "Authored: " + "\n\n".join(authored)
        if fact_sentences:
            return "Inferred from graph: " + fact_sentences

        name = node_row.get("name") or "This node"
        ntype = (node_row.get("labels") or ["Node"])[0]
        return (
            f"No connections visible in your authorized view for '{name}' ({ntype}), "
            f"and no narrative context is recorded for it."
        )

    def infer_context_on_demand(
        self,
        node_id: Optional[str] = None,
        node_name: Optional[str] = None,
        query_context: Optional[str] = None,
    ) -> str:
        """
        Explain WHY a node matters by reciting its structural position in the graph — the
        relationships it participates in, the named entities on the other end, their types
        and dates, and how central or peripheral it is. Use this when a node has no authored
        narrative or description of its own (a bare Technology, Concept, or Topic), or when
        the user asks "why does this matter", "why did this show up", or "what is this
        connected to".

        Returns FACTS ONLY — a deterministic Cypher-computed recitation, exactly like
        connect_knowledge_on_demand's bridge_summary. No LLM call happens in this method.
        Callers may phrase these facts in natural language but must not state intent,
        motivation, causation, or significance that is not literally present in the facts.

        query_context (optional): the user's original question, verbatim. Reuses
        _extract_bridge_keywords() — a hop into a neighbor whose name literally matches a
        keyword from this text is prioritized in the returned facts, same query-aware
        ranking rationale as connect_knowledge_on_demand.

        Zero-write guarantee: nothing is persisted to Neo4j. Deliberately returns no
        `nodes`/`links`/`virtual_links` keys — this never extends the rendered graph, only
        explains what is already there.
        """
        if not node_id and not node_name:
            return json.dumps({"error": "node_id or node_name is required"})

        try:
            node_row = self._resolve_context_node(node_id, node_name)
            if not node_row:
                return json.dumps({
                    "node": None,
                    "context_facts": [],
                    "context_tier": "none",
                    "provenance": "inferred_structural",
                    "context_summary": f"No node found matching '{node_name or node_id}'.",
                })

            keywords = self._extract_bridge_keywords(query_context)
            facts = self._collect_context_facts(node_row["element_id"], keywords)

            from domain_registry import CONTEXT_HUB_DEGREE_THRESHOLD
            degree = node_row.get("degree", 0)
            hub_tier = "landmark" if degree >= CONTEXT_HUB_DEGREE_THRESHOLD else "specific"
            context_tier = "inferred" if facts else "sparse"
            summary = self._render_context_summary(node_row, facts, keywords)

            return json.dumps({
                "node": {
                    "name": node_row["name"],
                    "type": (node_row["labels"] or ["Node"])[0],
                    "labels": node_row["labels"],
                    "node_id": node_row["node_id"],
                    "element_id": node_row["element_id"],
                    "degree": degree,
                    "display_date": node_row.get("display_date"),
                },
                "context_facts": facts,
                "matched_keywords": sorted(keywords) if keywords else [],
                "hub_tier": hub_tier,
                "context_tier": context_tier,
                "provenance": "inferred_structural",
                "context_summary": summary,
            }, indent=2)
        except Exception as e:
            import traceback
            traceback.print_exc()
            return json.dumps({"error": str(e)})

    def get_composition_subtree(self, root_node_id: str, max_depth: int = 5) -> dict:
        """BFS over COMPOSITION_RELATIONSHIPS to compute the subtree of a root node.

        Returns child_node_ids (shareable) and private_node_ids (is_private=true, excluded from shares).
        Used by the gateway /api/share/infer and /api/share/user endpoints.
        """
        from schema_guard import COMPOSITION_RELATIONSHIPS
        rels = "|".join(COMPOSITION_RELATIONSHIPS)
        query = f"""
            MATCH (root {{node_id: $root_id, tenant_id: $tenant_id}})
            MATCH (root)-[:{rels}*1..{max_depth}]->(child)
            WHERE child.node_id IS NOT NULL
              AND NOT child.tenant_id IN ['SYSTEM', 'PUBLIC']
            RETURN DISTINCT child.node_id AS node_id, child.is_private AS is_private
        """
        result = self._exec_query(query, root_id=root_node_id, tenant_id=self.tenant_id)
        child_node_ids   = [r["node_id"] for r in result.records if not r.get("is_private")]
        private_node_ids = [r["node_id"] for r in result.records if r.get("is_private")]
        return {"child_node_ids": child_node_ids, "private_node_ids": private_node_ids}

    def close(self):
        """Close the Neo4j driver"""
        if self.driver:
            self.driver.close()