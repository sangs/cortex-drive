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


class ExpertTools:
    """Expert tools for querying the Neo4j podcast episode graph"""
    
    def __init__(self, tenant_id: str, requesting_user_id: str = "", guest_share_anchor: str = ""):
        self.tenant_id = tenant_id
        self.requesting_user_id = requesting_user_id
        self.guest_share_anchor = guest_share_anchor
        # Initialize clients
        self.client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        self.driver = GraphDatabase.driver(
            os.environ["NEO4J_URI"],
            auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"])
        )
    
    def _get_security_clause(self, node_var: str) -> str:
        """
        Unified Zero-Trust ReBAC security clause.
        Matches the identity migration spec:
          - SYSTEM/PUBLIC nodes are globally visible (tenant_id IN ['SYSTEM','PUBLIC'])
          - PRIVATE nodes require matching tenant AND (owner or HAS_ACCESS grant)
        """
        return f"""
        (
            {node_var}.tenant_id IN ['SYSTEM', 'PUBLIC']
            OR (
                {node_var}.tenant_id = $tenant_id
                AND (
                    {node_var}.owner_id = $requesting_user_id
                    OR EXISTS {{ (u:User {{id: $requesting_user_id}})-[:HAS_ACCESS*1..2]->({node_var}) }}
                )
            )
        )
        """

    def _exec_query(self, query: str, **kwargs: Any):
        """Execute a parameterized Cypher query. cast() satisfies Pylance's LiteralString requirement — all user values are passed as $params, never interpolated."""
        return self.driver.execute_query(cast(LiteralString, query), **kwargs)

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
        
        WITH collect(DISTINCT elementId(anchor)) + collect(DISTINCT elementId(expandedNode)) + collect(DISTINCT elementId(parentEpisode)) AS expanded_ids
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
        
        WITH node, expanded_ids, 
             collect(DISTINCT neighbor) AS neighbors,
             collect(DISTINCT r) AS rels,
             collect(DISTINCT {
                id: elementId(neighbor),
                name: neighbor.name,
                type: labels(neighbor)[0],
                relationship: type(r),
                target_id: elementId(neighbor)
             }) AS relationships,
             collect(DISTINCT tech.name) AS technologies,
             collect(DISTINCT (CASE WHEN r.start IS NOT NULL OR r.end IS NOT NULL OR r.date IS NOT NULL THEN {rel_start: r.start, rel_end: r.end, rel_date: r.date, rel_title: coalesce(r.title, r.role)} ELSE null END)) AS relDates
        """
        return query.replace("{whitelist}", whitelist).replace("{security_clause}", self._get_security_clause("neighbor")).replace("{bridge_labels}", bridge_labels)

    def _fragment_narrative_aggregation(self) -> str:
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
                element_id: elementId(node),
                labels: labels(node),
                display_name: coalesce(node.name, node.title, node.text, node.url, labels(node)[0]),
                type: CASE
                    WHEN 'Category' IN labels(node) THEN 'Category'
                    WHEN 'Role' IN labels(node) THEN 'Role'
                    WHEN 'Hackathon' IN labels(node) THEN 'Hackathon'
                    WHEN 'ThoughtLeadership' IN labels(node) THEN 'ThoughtLeadership'
                    WHEN 'Startup' IN labels(node) AND 'Project' IN labels(node) THEN 'Project'
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
            tenant_id=self.tenant_id, 
            requesting_user_id=self.requesting_user_id,
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
                tenant_id=self.tenant_id,
                requesting_user_id=self.requesting_user_id
            )
            k_res = self._exec_query(
                keyword_query, 
                question=question, 
                top_k=top_k,
                tenant_id=self.tenant_id,
                requesting_user_id=self.requesting_user_id
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
                    tenant_id=self.tenant_id,
                    requesting_user_id=self.requesting_user_id
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
            tenant_id=self.tenant_id, 
            requesting_user_id=self.requesting_user_id,
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
        query = """
        MATCH (e:Episode)
        WHERE (e.tenant_id = $tenant_id OR EXISTS((:User {id: $requesting_user_id})-[:HAS_ACCESS]->(e)))
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
        """
        
        result = self._exec_query(
            query, 
            tenant_id=self.tenant_id, 
            question=question,
            requesting_user_id=self.requesting_user_id
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
            query = "MATCH (n:__MetaContext__ {useCase: $use_case}) WHERE (n.tenant_id = $tenant_id OR EXISTS((:User {id: $requesting_user_id})-[:HAS_ACCESS]->(n))) RETURN n.context AS context"
            result = self._exec_query(query, tenant_id=self.tenant_id, requesting_user_id=self.requesting_user_id, use_case=use_case)
        else:
            query = "MATCH (n:__MetaContext__) WHERE (n.tenant_id = $tenant_id OR EXISTS((:User {id: $requesting_user_id})-[:HAS_ACCESS]->(n))) RETURN n.context AS context"
            result = self._exec_query(query, tenant_id=self.tenant_id, requesting_user_id=self.requesting_user_id)
            
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
            tenant_id=self.tenant_id, 
            question=question,
            requesting_user_id=self.requesting_user_id
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
        WHERE (e.tenant_id = $tenant_id OR EXISTS((:User {id: $requesting_user_id})-[:HAS_ACCESS]->(e)))
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
            tenant_id=self.tenant_id, 
            question=question,
            requesting_user_id=self.requesting_user_id
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
        WHERE (e.tenant_id = $tenant_id OR EXISTS((:User {id: $requesting_user_id})-[:HAS_ACCESS]->(e)))
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
            tenant_id=self.tenant_id, 
            question=question,
            requesting_user_id=self.requesting_user_id
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
        WHERE (e.tenant_id = $tenant_id OR EXISTS((:User {id: $requesting_user_id})-[:HAS_ACCESS]->(e)))
        OPTIONAL MATCH (e)-[:HAS_TOPIC]->(t:Topic)
        OPTIONAL MATCH (e)-[:HAS_REFERENCE_LINK]->(r:ReferenceLink)
        OPTIONAL MATCH (e)-[:HAS_SOURCE]->(s:Source)-[:CONTAINS]->(c:Chunk)
        RETURN count(DISTINCT e) AS total_episodes,
               count(DISTINCT t) AS total_topics,
               count(DISTINCT r) AS total_reference_links,
               count(DISTINCT c) AS total_chunks
        """
        
        result = self._exec_query(query, tenant_id=self.tenant_id, requesting_user_id=self.requesting_user_id)
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
        WHERE (e.tenant_id = $tenant_id OR EXISTS((:User {id: $requesting_user_id})-[:HAS_ACCESS]->(e)))
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
            tenant_id=self.tenant_id, 
            reference_string=reference_string,
            requesting_user_id=self.requesting_user_id
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
        MATCH (c:Chunk {tenant_id: $tenant_id})
        WHERE c.embedding IS NOT NULL
        RETURN c.embedding AS embedding
        LIMIT 1
        """
        
        result = self._exec_query(
            query, 
            tenant_id=self.tenant_id,
            requesting_user_id=self.requesting_user_id
        )
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
            result = session.run("""
                WITH split($question, ' ') AS keywords
                CALL db.index.vector.queryNodes(
                    'chunkIndex',
                    $k,
                    $questionEmbedding
                )
                YIELD node AS chunk, score AS indexScore

                MATCH (seedEpisode:Episode {tenant_id: $tenant_id})-[:HAS_SOURCE]->(s:Source)-[:CONTAINS]->(chunk)
                WHERE (seedEpisode.tenant_id = $tenant_id OR EXISTS((:User {id: $requesting_user_id})-[:HAS_ACCESS]->(seedEpisode)))
                OPTIONAL MATCH (seedEpisode)-[r:SEMANTICALLY_SIMILAR_KNN]->(similarEpisode:Episode {tenant_id: $tenant_id})
                WHERE (similarEpisode.tenant_id = $tenant_id OR EXISTS((:User {id: $requesting_user_id})-[:HAS_ACCESS]->(similarEpisode)))

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
            """, questionEmbedding=question_embedding, k=k, limit=limit, tenant_id=self.tenant_id, requesting_user_id=self.requesting_user_id, question=question)
            
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
            result = session.run("""
                WITH split($question, ' ') AS keywords
                CALL db.index.vector.queryNodes(
                    'chunkIndex',
                    $k,
                    $questionEmbedding
                )
                YIELD node AS chunk, score
                MATCH (episode:Episode {tenant_id: $tenant_id})-[:HAS_SOURCE]->(s:Source)-[:CONTAINS]->(chunk)
                WHERE (episode.tenant_id = $tenant_id OR EXISTS((:User {id: $requesting_user_id})-[:HAS_ACCESS]->(episode)))
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
            """, questionEmbedding=question_embedding, k=k, tenant_id=self.tenant_id, requesting_user_id=self.requesting_user_id, question=question)
            
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
        MATCH (e:Episode {tenant_id: $tenant_id})-[r]-(p:Person)
        WHERE toLower(e.name) CONTAINS toLower($episode_name)
        RETURN p.name AS person_name, 
               type(r) AS relationship,
               e.name AS episode_title,
               e.number AS episode_number
        LIMIT 20
        """
        result = self._exec_query(
            query, 
            tenant_id=self.tenant_id, 
            episode_name=episode_name,
            requesting_user_id=self.requesting_user_id
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
        WHERE (e.tenant_id = $tenant_id OR EXISTS((:User {id: $requesting_user_id})-[:HAS_ACCESS]->(e)))
        OPTIONAL MATCH (p:Person)-[r:HOSTS|GUEST_ON]->(e)
        RETURN e.name AS episode_name, 
               e.number AS episode_number,
               e.link AS episode_link,
               e.description AS description,
               collect({name: p.name, role: type(r)}) AS cast
        ORDER BY e.number DESC
        """
        result = self._exec_query(
            query, 
            tenant_id=self.tenant_id,
            requesting_user_id=self.requesting_user_id
        )
        
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
            MATCH (e:Episode {tenant_id: $tenant_id, name: $episode_name})
            WHERE (e.tenant_id = $tenant_id OR EXISTS((:User {id: $requesting_user_id})-[:HAS_ACCESS]->(e)))
            
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
                    tenant_id=self.tenant_id, 
                    episode_name=episode_name,
                    requesting_user_id=self.requesting_user_id
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
                tenant_id=self.tenant_id,
                requesting_user_id=requesting_user_id or self.requesting_user_id
            )
            output = [record.data() for record in result.records]
            return json.dumps(output, indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})

    def get_node_details(self, node_id: Optional[str] = None, node_name: Optional[str] = None) -> str:
        """
        Fetch all properties and labels for a specific node by its 'element_id' or 'name'.
        """
        query = """
        MATCH (n)
        WHERE (elementId(n) = $node_id OR toLower(n.name) = toLower($node_name))
          AND (""" + self._get_security_clause("n") + """)
        
        OPTIONAL MATCH (n)-[:HAS_REFERENCE]->(ref:ReferenceLink)
        OPTIONAL MATCH (n)-[:USES_TOOL]->(tech:Technology)
        OPTIONAL MATCH (n)-[:HAS_PRIVATE_NOTE|CONTAINS|CONTRIBUTED_TO*1..2]-(note:PreparatoryNote)
        WHERE (""" + self._get_security_clause("note") + """) AND NOT 'Category' IN labels(n)

        WITH n, labels(n) AS labels,
             collect(DISTINCT coalesce(ref.url, ref.link)) AS ref_urls,
             collect(DISTINCT tech.name) AS technologies,
             collect(DISTINCT note.text) AS narratives

        RETURN properties(n) AS properties, 
               labels, 
               ref_urls, 
               technologies, 
               narratives,
               elementId(n) AS element_id,
               coalesce(n.name, n.title, n.text, n.url, labels[0]) AS display_name
        LIMIT 1
        """
        result = self._exec_query(
            query, 
            tenant_id=self.tenant_id,
            node_id=node_id,
            node_name=node_name,
            requesting_user_id=self.requesting_user_id
        )
        
        if not result.records:
            return json.dumps({"error": "Node not found or access denied."})
            
        data = result.records[0].data()
        # Apply Python Sanitizer to Narratives
        if data.get("narratives"):
            data["narratives"] = [self._sanitize_narrative(n) for n in data["narratives"] if n]
            
        return json.dumps([data], indent=2)

    def expand_node_topology(self, node_id: Optional[str] = None, node_name: Optional[str] = None) -> str:
        """
        Explore the 1-hop neighborhood of a node by element_id or name.
        """
        import json as _json
        from domain_registry import DISCOVERY_LABELS
        from schema_guard import TRAVERSAL_RELATIONSHIPS
        _traversal_rels = _json.dumps(TRAVERSAL_RELATIONSHIPS)
        query = f"""
        MATCH (node)-[r]-(neighbor)
        WHERE (node.name = $node_name OR elementId(node) = $node_id)
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
                tenant_id=self.tenant_id,
                requesting_user_id=self.requesting_user_id,
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

    def search_enterprise_graph(self, keyword: str, requesting_user_id: str = "", wants_visual_map: bool = False, domain_intent: str = "all") -> str:
        """
        Search for entities across the Universal Enterprise Graph dynamically, explicitly crossing boundaries between domains (Podcast/Resume/Federated).
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
                name: node.name,
                type: CASE 
                    WHEN 'Category' IN labels(node) THEN 'Category'
                    WHEN 'Role' IN labels(node) THEN 'Role'
                    WHEN 'ThoughtLeadership' IN labels(node) THEN 'ThoughtLeadership'
                    WHEN 'Company' IN labels(node) THEN 'Company'
                    WHEN 'Project' IN labels(node) THEN 'Project'
                    WHEN 'Episode' IN labels(node) THEN 'Episode'
                    WHEN 'Technology' IN labels(node) THEN 'Technology'
                    WHEN 'Topic' IN labels(node) THEN 'Topic'
                    ELSE labels(node)[0] 
                END,
                description: left(coalesce(node.description, node.text, ""), 150),
                text: apoc.text.join(notes, "\n---\n"),
                url: node.url,
                link: node.link,
                links: [l IN apoc.coll.toSet(coalesce(node.links, []) + cluster_ref_urls + [node.url, node.link]) WHERE l IS NOT NULL AND l <> ""],
                technologies: [t IN cluster_tech_urls WHERE t IS NOT NULL AND t <> ""]
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

            print(f"[SEARCH] Running '{domain_intent}' enterprise search for user: {requesting_user_id}")
            result = self._exec_query(
                query, 
                tenant_id=self.tenant_id,
                requesting_user_id=requesting_user_id,
                keyword=keyword,
                keywords=keywords_list,
                anchorLabels=anchor_labels,
                allowed_labels=allowed_labels,
                has_temporal_intent=has_temporal_intent,
                embedding=embedding,
                owner_id=os.environ.get("OWNER_USER_ID")
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
                RETURN collect(node {{ .*, element_id: elementId(node), labels: labels(node), temporal_boost: score * 100 }}) AS nodes, [] AS links
                """
                result = self._exec_query(
                    fallback_query,
                    tenant_id=self.tenant_id,
                    embedding=embedding,
                    requesting_user_id=requesting_user_id
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
        # Accept node_id as an alias for node_name (GPT-4o sometimes passes node_id)
        node_name = node_name or node_id
        if not node_name:
            return json.dumps({"error": "node_name is required"})
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

        # Identify the node by name or elementId
        query = """
        MATCH (n)
        WHERE (elementId(n) = $node_name OR toLower(n.name) = toLower($node_name) OR n.name CONTAINS $node_name)
          AND ({sec_n})
        
        OPTIONAL MATCH path = (n)-[*1..{safe_depth}]-(m)
        WHERE ({sec_m})
          AND ALL(node IN nodes(path) WHERE NOT node:{bridge_labels})
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

        WITH n, node, rel, roleRel, 
             collect(DISTINCT coalesce(ref.url, ref.link, ref.neighborUrl)) AS cluster_ref_urls,
             collect(DISTINCT tech.name) AS cluster_tech_urls,
             collect(DISTINCT note.text) AS notes

        WITH n, node, rel, roleRel, cluster_tech_urls, notes,
             apoc.coll.toSet(coalesce(node.links, []) + cluster_ref_urls + [node.url, node.link]) AS fused_links

        WITH n,
             collect(DISTINCT {
                id: elementId(node),
                name: node.name,
                type: CASE
                    WHEN 'Category' IN labels(node) THEN 'Category'
                    WHEN 'Role' IN labels(node) THEN 'Role'
                    WHEN 'Hackathon' IN labels(node) THEN 'Hackathon'
                    WHEN 'ThoughtLeadership' IN labels(node) THEN 'ThoughtLeadership'
                    WHEN 'Startup' IN labels(node) AND 'Project' IN labels(node) THEN 'Project'
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
                description: left(coalesce(node.description, node.text, ""), 150),
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
        query = query.replace("{safe_depth}", str(safe_depth)).replace("{bridge_labels}", bridge_labels).replace("{backbone_filter}", backbone_filter).replace("{domain_filter}", domain_filter)
        query = query.replace("{sec_n}", self._get_security_clause("n")).replace("{sec_m}", self._get_security_clause("m")).replace("{sec_p}", self._get_security_clause("p")).replace("{sec_note}", self._get_security_clause("note"))
        try:
            from domain_registry import get_backbone_labels
            backbone_labels_list = get_backbone_labels(domain)
            result = self._exec_query(
                query, 
                tenant_id=self.tenant_id,
                requesting_user_id=self.requesting_user_id,
                node_name=node_name,
                backbone_labels_list=backbone_labels_list,
                authorized_labels=authorized_labels,
                keyword="",
                keywords=[],
                anchorLabels=[],
                embedding=None,
                owner_id=os.environ.get("OWNER_USER_ID")
            )
            if not result.records:
                return json.dumps({"error": f"Node '{node_name}' not found."})
            
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
        limit: int = 5
    ) -> str:
        """
        Discover virtual cross-domain knowledge bridges for a specific node.

        Finds nodes in another domain that share semantic anchors (Technology, Topic,
        Concept) with the source node using a three-tier algorithm:
          Tier 1: Explicit anchor match (shared Technology/Topic/Concept nodes)
          Tier 2: Taxonomy-expanded match (parent concept traversal via IS_A/SUB_TOPIC_OF)
          Tier 3: Graceful degradation when no anchors exist (returns empty, no error)

        Zero-write guarantee: nothing is persisted to Neo4j. All returned links are
        session-only virtual bridges rendered as gold dashed lines in the UI.
        """
        if not source_node_id and not source_node_name:
            return json.dumps({"error": "source_node_id or source_node_name is required"})

        from domain_registry import get_authorized_labels

        # Map target domain to allowed labels
        target_labels_raw = get_authorized_labels(target_domain)
        # For "all", get_authorized_labels returns None — use a broad default
        if not target_labels_raw:
            target_labels_raw = [
                "Project", "Role", "Company", "Hackathon", "ThoughtLeadership",
                "Publication", "Episode", "Topic", "Podcast", "Certification",
                "Institution", "Category", "Technology", "Concept"
            ]
        # Exclude the source node's own type from target labels to avoid self-bridges
        target_domain_labels = list(target_labels_raw)

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
        sec_anchor = self._get_security_clause("anchor")
        sec_parent = self._get_security_clause("parentAnchor")
        sec_target = self._get_security_clause("target")

        query = f"""
        // Step 1: Locate the source node (tenant-level read — ownership already proven by UI click)
        MATCH (source)
        WHERE (elementId(source) = $source_node_id OR toLower(source.name) = toLower($source_node_name))
          AND ({sec_source_read})

        // Step 2: Find its semantic anchors (1-2 hops, no chunks/notes)
        OPTIONAL MATCH (source)-[:DISCUSSES|USES_TOOL|HAS_TOPIC|COVERS_TECHNOLOGY|MENTIONS|HAS_SKILL|CONTAINS|IS_SIMILAR|SIMILAR*1..2]-(anchor)
        WHERE any(label IN labels(anchor) WHERE label IN ['Technology', 'Topic', 'Concept', 'Skill'])
          AND ({sec_anchor})

        // Step 3: Taxonomy Expansion — resolve AI Agent -> AI parent, etc.
        OPTIONAL MATCH (anchor)-[:IS_A|SUB_TOPIC_OF|PARENT_OF*0..2]-(parentAnchor)
        WHERE parentAnchor IS NOT NULL
          AND any(label IN labels(parentAnchor) WHERE label IN ['Technology', 'Topic', 'Concept'])
          AND ({sec_parent})

        WITH source,
             collect(DISTINCT anchor) + collect(DISTINCT parentAnchor) AS allAnchors

        // Step 4: Find target nodes in the requested domain sharing these anchors
        MATCH (target)-[:DISCUSSES|USES_TOOL|HAS_TOPIC|COVERS_TECHNOLOGY|MENTIONS|HAS_SKILL]-(sharedAnchor)
        WHERE sharedAnchor IN allAnchors
          AND any(label IN labels(target) WHERE label IN $target_domain_labels)
          AND target <> source
          AND ({sec_target})
          AND NOT target:ReferenceLink AND NOT target:Chunk AND NOT target:Source
          AND NOT target:PreparatoryNote AND NOT target:__MetaContext__

        WITH source, target,
             count(DISTINCT sharedAnchor) AS sharedCount,
             collect(DISTINCT {{
                name: sharedAnchor.name,
                element_id: elementId(sharedAnchor),
                type: labels(sharedAnchor)[0],
                anchor_element_id: elementId(sharedAnchor)
             }}) AS sharedAnchors
        WHERE sharedCount >= $min_anchors

        RETURN
            elementId(source) AS source_eid,
            elementId(target) AS target_eid,
            target.name AS target_name,
            labels(target)[0] AS target_type,
            target.description AS target_description,
            sharedCount,
            sharedAnchors
        ORDER BY sharedCount DESC
        LIMIT $limit
        """

        try:
            result = self._exec_query(
                query,
                tenant_id=self.tenant_id,
                requesting_user_id=self.requesting_user_id,
                source_node_id=source_node_id or "",
                source_node_name=source_node_name or "",
                target_domain_labels=target_domain_labels,
                min_anchors=min_anchors,
                limit=limit
            )

            if not result.records:
                return json.dumps({
                    "nodes": [],
                    "virtual_links": [],
                    "bridge_summary": "No cross-domain bridges found for this node with the current anchor threshold.",
                    "confidence_tier": "none"
                })

            nodes = []
            virtual_links = []
            seen_node_ids = set()
            seen_anchor_ids = set()
            all_shared_anchor_names = set()

            source_eid = result.records[0]["source_eid"]

            for record in result.records:
                target_eid = record["target_eid"]
                target_name = record["target_name"]
                target_type = record["target_type"]
                shared_anchors = record["sharedAnchors"]

                # Add target node
                if target_eid not in seen_node_ids:
                    seen_node_ids.add(target_eid)
                    nodes.append({
                        "id": target_eid,
                        "element_id": target_eid,
                        "name": target_name,
                        "type": target_type,
                        "description": record["target_description"] or "",
                        "has_federated_bridge": True,
                        "is_bento_eligible": True,
                        "bridge_reason": f"Common Ground: {', '.join(a['name'] for a in shared_anchors[:3])}"
                    })

                # Add anchor nodes and virtual links
                for anchor in shared_anchors:
                    anchor_eid = anchor.get("anchor_element_id") or anchor.get("element_id")
                    anchor_name = anchor.get("name", "")
                    anchor_type = anchor.get("type", "Concept")
                    all_shared_anchor_names.add(anchor_name)

                    if anchor_eid and anchor_eid not in seen_anchor_ids:
                        seen_anchor_ids.add(anchor_eid)
                        nodes.append({
                            "id": anchor_eid,
                            "element_id": anchor_eid,
                            "name": anchor_name,
                            "type": anchor_type,
                            "is_bridge": True,
                            "has_federated_bridge": True,
                            "is_bento_eligible": False
                        })
                        # Virtual link: source → anchor
                        virtual_links.append({
                            "source": source_eid,
                            "target": anchor_eid,
                            "type": "VIRTUAL_BRIDGE",
                            "discovery_reason": f"Shared: {anchor_name}"
                        })
                        # Virtual link: anchor → target
                        virtual_links.append({
                            "source": anchor_eid,
                            "target": target_eid,
                            "type": "VIRTUAL_BRIDGE",
                            "discovery_reason": f"Shared: {anchor_name}"
                        })

            # Determine confidence tier
            confidence_tier = "taxonomy_expanded" if len(seen_anchor_ids) > 0 else "explicit"

            summary_anchors = ", ".join(sorted(all_shared_anchor_names)[:5])
            bridge_summary = (
                f"Found {len(seen_node_ids)} cross-domain bridge(s) via shared concepts: {summary_anchors}."
                if seen_node_ids
                else "No bridges found."
            )

            return json.dumps({
                "nodes": nodes,
                "virtual_links": virtual_links,
                "bridge_summary": bridge_summary,
                "confidence_tier": confidence_tier
            }, indent=2)

        except Exception as e:
            import traceback
            traceback.print_exc()
            return json.dumps({"error": str(e)})

    def close(self):
        """Close the Neo4j driver"""
        if self.driver:
            self.driver.close()