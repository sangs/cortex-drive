"""
Expert Tools for Neo4j Podcast Episode Graph
"""

from openai import OpenAI
from neo4j import GraphDatabase
import os
import json
import numpy as np
import re
from typing import List, Dict, Any, Optional
from schema_guard import PROJECT_GRAPH_NODES


class ExpertTools:
    """Expert tools for querying the Neo4j podcast episode graph"""
    
    def __init__(self, tenant_id: str):
        self.tenant_id = tenant_id
        # Initialize clients
        self.client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
        self.driver = GraphDatabase.driver(
            os.environ["NEO4J_URI"],
            auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"])
        )
    
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
        WHERE id(chunk) = nodeId AND ep.tenant_id = $tenant_id
        RETURN ep.name AS episode_name, 
               ep.number AS episode_number,
               ep.link AS episode_link,
               chunk.text AS text, 
               similarity
        ORDER BY similarity DESC
        LIMIT $top_k
        """
        
        result = self.driver.execute_query(
            query, tenant_id=self.tenant_id, 
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
        CALL db.index.vector.queryNodes('chunkIndex', $top_k * 2, $embedding)
        YIELD node, score
        RETURN node.text AS text, score, 'vector' as source
        """
        
        # 3. Keyword Search (BM25)
        keyword_query = """
        CALL db.index.fulltext.queryNodes('chunkTextIndex', $question)
        YIELD node, score
        RETURN node.text AS text, score, 'keyword' as source
        LIMIT $top_k * 2
        """
        
        try:
            v_res = self.driver.execute_query(vector_query, embedding=embedding, top_k=top_k, tenant_id=self.tenant_id)
            k_res = self.driver.execute_query(keyword_query, question=question, top_k=top_k)
            
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
                MATCH (chunk:Chunk {text: $text, tenant_id: $tenant_id})
                MATCH (chunk)-[:BELONGS_TO_SOURCE]->(s:Source)<-[:HAS_SOURCE]-(ep:Episode)
                RETURN ep.name AS episode_name, ep.number AS episode_number, ep.link AS episode_link
                LIMIT 1
                """
                meta_res = self.driver.execute_query(meta_query, text=text, tenant_id=self.tenant_id)
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
        RETURN ep.name AS episode_name, 
               ep.number AS episode_number,
               ep.link AS episode_link,
               node.text AS text, 
               score
        LIMIT $top_k
        """
        
        result = self.driver.execute_query(
            query, tenant_id=self.tenant_id, 
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
        MATCH (e:Episode {tenant_id: $tenant_id})-[:HAS_TOPIC]->(t:Topic)
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
        
        result = self.driver.execute_query(query, tenant_id=self.tenant_id, question=question)
        
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
            query = "MATCH (n:__MetaContext__ {tenant_id: $tenant_id, useCase: $use_case}) RETURN n.context AS context"
            result = self.driver.execute_query(query, tenant_id=self.tenant_id, use_case=use_case)
        else:
            query = "MATCH (n:__MetaContext__ {tenant_id: $tenant_id}) RETURN n.context AS context"
            result = self.driver.execute_query(query, tenant_id=self.tenant_id)
            
        if result.records:
            return "\n\n".join([r['context'] for r in result.records if r['context']])
        return "No behavioral instructions found for this graph context."

    def find_episodes_by_people(self, question: str) -> str:
        """
        Search for episodes that feature specific people.
        """
        query = """
        MATCH (p:Person)-[r]-(e:Episode {tenant_id: $tenant_id})
        WHERE toLower(p.name) CONTAINS toLower($question)
        RETURN DISTINCT p.name AS person_name,
               type(r) AS relationship_type,
               e.name AS episode_name,
               e.number AS episode_number,
               e.link AS episode_link,
               $question AS matched_term
        ORDER BY e.number DESC
        LIMIT 10
        """
        
        result = self.driver.execute_query(query, tenant_id=self.tenant_id, question=question)
        
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
        MATCH (e:Episode {tenant_id: $tenant_id})-[:HAS_TOPIC]->(t:Topic)-[:COVERS_CONCEPT]->(c:Concept)
        WHERE toLower(c.name) CONTAINS toLower($question) OR 
              toLower(c.description) CONTAINS toLower($question)
        RETURN DISTINCT e.name AS episode_name,
               e.number AS episode_number,
               e.link AS episode_link,
               t.name AS topic_name,
               c.name AS concept_name,
               c.description AS concept_description,
               $question AS matched_term
        ORDER BY e.number DESC
        LIMIT 10
        """
        
        result = self.driver.execute_query(query, tenant_id=self.tenant_id, question=question)
        
        concepts = []
        for record in result.records:
            concepts.append({
                'episode_name': record['episode_name'],
                'episode_number': record['episode_number'],
                'episode_link': record['episode_link'],
                'topic_name': record['topic_name'],
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
        MATCH (e:Episode {tenant_id: $tenant_id})-[:HAS_TOPIC]->(t:Topic)-[:COVERS_TECHNOLOGY]->(tech:Technology)
        WHERE toLower(tech.name) CONTAINS toLower($question)
        RETURN DISTINCT e.name AS episode_name,
               e.number AS episode_number,
               e.link AS episode_link,
               t.name AS topic_name,
               tech.name AS technology_name,
               $question AS matched_term
        ORDER BY e.number DESC
        LIMIT 10
        """
        
        result = self.driver.execute_query(query, tenant_id=self.tenant_id, question=question)
        
        technologies = []
        for record in result.records:
            technologies.append({
                'episode_name': record['episode_name'],
                'episode_number': record['episode_number'],
                'episode_link': record['episode_link'],
                'topic_name': record['topic_name'],
                'technology_name': record['technology_name'],
                'matched_term': record['matched_term']
            })
        
        return json.dumps(technologies, indent=2)

    def get_episode_statistics(self) -> str:
        """
        Get statistics about episodes in the database.
        """
        query = """
        MATCH (e:Episode {tenant_id: $tenant_id})
        OPTIONAL MATCH (e)-[:HAS_TOPIC]->(t:Topic)
        OPTIONAL MATCH (e)-[:HAS_REFERENCE_LINK]->(r:ReferenceLink)
        OPTIONAL MATCH (e)-[:HAS_SOURCE]->(s:Source)-[:CONTAINS]->(c:Chunk)
        RETURN count(DISTINCT e) AS total_episodes,
               count(DISTINCT t) AS total_topics,
               count(DISTINCT r) AS total_reference_links,
               count(DISTINCT c) AS total_chunks
        """
        
        result = self.driver.execute_query(query, tenant_id=self.tenant_id)
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
        MATCH (e:Episode {tenant_id: $tenant_id})-[:HAS_REFERENCE_LINK]->(r:ReferenceLink)
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
        
        result = self.driver.execute_query(query, tenant_id=self.tenant_id, reference_string=reference_string)
        
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
        
        result = self.driver.execute_query(query, tenant_id=self.tenant_id)
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
                CALL db.index.vector.queryNodes(
                    'chunkIndex',
                    $k,
                    $questionEmbedding
                )
                YIELD node AS chunk, score AS indexScore

                MATCH (seedEpisode:Episode {tenant_id: $tenant_id})-[:HAS_SOURCE]->(s:Source)-[:CONTAINS]->(chunk)
                OPTIONAL MATCH (seedEpisode)-[r:SEMANTICALLY_SIMILAR_KNN]->(similarEpisode:Episode {tenant_id: $tenant_id})

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
            """, questionEmbedding=question_embedding, k=k, limit=limit, tenant_id=self.tenant_id)
            
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
                CALL db.index.vector.queryNodes(
                    'chunkIndex',
                    $k,
                    $questionEmbedding
                )
                YIELD node AS chunk, score
                MATCH (episode:Episode {tenant_id: $tenant_id})-[:HAS_SOURCE]->(s:Source)-[:CONTAINS]->(chunk)
                RETURN
                    episode.name AS EpisodeTitle,
                    episode.number AS EpisodeNumber,
                    chunk.text AS ChunkContent, 
                    score AS SimilarityScore
                ORDER BY
                    SimilarityScore DESC
            """, questionEmbedding=question_embedding, k=k, tenant_id=self.tenant_id)
            
            results = []
            for record in result:
                results.append({
                    'EpisodeTitle': record['EpisodeTitle'],
                    'EpisodeNumber': record['EpisodeNumber'],
                    'ChunkContent': record['ChunkContent'],
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
        result = self.driver.execute_query(query, tenant_id=self.tenant_id, episode_name=episode_name)
        
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
        MATCH (e:Episode {tenant_id: $tenant_id})
        OPTIONAL MATCH (p:Person)-[r:HOSTS|GUEST_ON]->(e)
        RETURN e.name AS episode_name, 
               e.number AS episode_number,
               e.link AS episode_link,
               e.description AS description,
               collect({name: p.name, role: type(r)}) AS cast
        ORDER BY e.number DESC
        """
        result = self.driver.execute_query(query, tenant_id=self.tenant_id)
        
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
        Native Hybrid Search (GraphRAG): Performs vector search on chunks and 
        immediately traverses to parent Episode and related nodes.
        """
        question_embedding = self.get_embedding(question, model="text-embedding-3-small")
        
        query = """
        CALL db.index.vector.queryNodes('chunkIndex', 100, $questionEmbedding)
        YIELD node AS chunk, score
        MATCH (chunk)<-[:CONTAINS]-(s:Source)<-[:HAS_SOURCE]-(e:Episode {tenant_id: $tenant_id})
        
        OPTIONAL MATCH (p:Person)-[r]-(e)
        WHERE type(r) IN ['HOSTS', 'GUEST_ON']
        
        OPTIONAL MATCH (e)-[:HAS_TOPIC]->(t:Topic)
        OPTIONAL MATCH (t)-[:COVERS_TECHNOLOGY]->(tech:Technology)

        RETURN e.name AS episode_title,
               e.number AS episode_number,
               e.description AS episode_description,
               e.link AS link,
               chunk.text AS chunk_content,
               score AS similarity_score,
               collect(DISTINCT {name: p.name, role: type(r)}) AS participants,
               collect(DISTINCT t.name) AS topics,
               collect(DISTINCT tech.name) AS technologies
        ORDER BY similarity_score DESC
        LIMIT $k
        """
        
        result = self.driver.execute_query(
            query, 
            tenant_id=self.tenant_id, 
            questionEmbedding=question_embedding, 
            k=k
        )
        
        enriched_results = []
        for record in result.records:
            relationships = []
            
            for p in (record['participants'] or []):
                if p and p.get('name'):
                    relationships.append({"target_name": p['name'], "target_type": "Person", "rel_type": p['role'], "link": p.get('link')})
            
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
                'chunk_content': record['chunk_content'],
                'similarity_score': record['similarity_score'],
                'topics': record['topics'],
                'technologies': record['technologies'],
                'participants': record['participants'],
                'relationships': relationships
            })
            
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
            result = self.driver.execute_query(query, tenant_id=self.tenant_id)
            output = [record.data() for record in result.records]
            return json.dumps(output, indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})

    def get_node_details(self, node_name: str) -> str:
        """
        Fetch all properties and labels for a specific node by its 'name' property.
        """
        query = """
        MATCH (n {tenant_id: $tenant_id})
        WHERE toLower(n.name) = toLower($node_name)
        RETURN n, labels(n) AS labels
        LIMIT 1
        """
        result = self.driver.execute_query(
            query, 
            tenant_id=self.tenant_id,
            node_name=node_name
        )
        
        if not result.records:
            return json.dumps({"message": f"Node with name '{node_name}' not found."})
            
        record = result.records[0]
        return json.dumps({
            "properties": record['n'].data(),
            "labels": record['labels']
        }, indent=2)

    def expand_node_topology(self, node_name: str) -> str:
        """
        Explore the 1-hop neighborhood of a node.
        """
        query = """
        MATCH (node {tenant_id: $tenant_id})-[r]-(neighbor)
        WHERE toLower(node.name) = toLower($node_name)
          AND neighbor.tenant_id = $tenant_id
          AND any(label IN labels(neighbor) WHERE label IN $allowed_labels)
          AND NOT neighbor:ReferenceLink
        
        OPTIONAL MATCH (neighbor)-[:HAS_REFERENCE]->(ref:ReferenceLink)
        
        RETURN 
            CASE 
                WHEN 'Category' IN labels(neighbor) THEN 'Category'
                WHEN 'Role' IN labels(neighbor) THEN 'Role'
                WHEN 'Hackathon' IN labels(neighbor) THEN 'Hackathon'
                WHEN 'ThoughtLeadership' IN labels(neighbor) THEN 'ThoughtLeadership'
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
            result = self.driver.execute_query(
                query, 
                tenant_id=self.tenant_id,
                node_name=node_name,
                allowed_labels=PROJECT_GRAPH_NODES
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

    def search_resume_graph(self, keyword: str, requesting_user_id: str = "") -> str:
        """
        Search for entities across the Interactive Resume Graph dynamically.
        """
        discovery_synonyms = ["portfolio", "overview", "background", "experience", "career", "map"]
        is_discovery_request = any(s in keyword.lower() for s in discovery_synonyms)
        
        stop_words = {"show", "me", "how", "did", "she", "what", "is", "the", "and", "a", "an", "at", "in", "of", "for", "with", "on", "to", "from", "by"}
        clean_keyword = keyword.lower().replace(".", "").replace(",", "").replace("?", "").replace("!", "")
        keywords = [w for w in clean_keyword.split() if w not in stop_words]
        final_keyword_str = " ".join(keywords) if keywords else keyword

        search_keyword = final_keyword_str
        if is_discovery_request:
            search_keyword = "Category " + final_keyword_str if final_keyword_str else "Category"

        query = """
        WITH split(toLower(coalesce($keyword, "")), ' ') AS keywords
        MATCH (node)
        WHERE node.tenant_id = $tenant_id
          AND any(label IN labels(node) WHERE label IN $allowed_labels)
        
        OPTIONAL MATCH (parentCat:Category)-[:CONTAINS]->(node)
        WHERE parentCat.tenant_id = $tenant_id

        OPTIONAL MATCH (node)-[:AT|GRADUATED_FROM|HELD_ROLE|PARTICIPATED_IN|CONTRIBUTED_TO*1..2]-(comp:Company)
        WHERE comp.tenant_id = $tenant_id
        
        WITH node, keywords, parentCat, comp
        WHERE (
                any(word IN keywords WHERE toLower(node.name) CONTAINS word)
                OR any(word IN keywords WHERE toLower(node.description) CONTAINS word)
                OR any(word IN keywords WHERE toLower(node.text) CONTAINS word)
                OR any(label IN labels(node) WHERE any(word IN keywords WHERE toLower(label) CONTAINS word))
                OR any(word IN keywords WHERE toLower(word) = toLower(node.type))
                OR any(word IN keywords WHERE toLower(parentCat.name) CONTAINS word)
                OR any(word IN keywords WHERE toLower(comp.name) CONTAINS word)
                OR (any(word IN keywords WHERE word IN ['infra', 'infrastructure', 'pipeline', 'msk', 'kafka', 'datamesh', 'modernize', 'modernization']) 
                    AND (node:Project OR node:Company OR node:Technology))
                OR (any(word IN keywords WHERE word IN ['academic', 'education', 'cert', 'certification', 'degree', 'foundation']) 
                    AND (node:Degree OR node:Institution OR node:Certification OR node:ProfessionalEducation))
        )
        
        OPTIONAL MATCH (p:Person {tenant_id: $tenant_id})-[roleRel:CURRENTLY_BUILDING|HELD_ROLE|PARTICIPATED_IN|AUTHORED|CO_AUTHORED|CERTIFIED_BY|STUDIED_AT|GRADUATED_FROM|CONTRIBUTED_TO|FEATURE_GUEST|BUILT_DURING]-(node)
        
        OPTIONAL MATCH (node)-[r:HELD_ROLE|AT|CONTRIBUTED_TO|PARTICIPATED_IN|EARNED_DEGREE|FROM_INSTITUTION|HAS_SKILL|CONTAINS|HAS_REFERENCE|BUILT_DURING|FEATURE_GUEST]-(neighbor)
        WHERE neighbor IS NOT NULL 
          AND neighbor.tenant_id = $tenant_id
          AND NOT neighbor:Chunk AND NOT neighbor:Episode AND NOT neighbor:Topic AND NOT neighbor:Source AND NOT neighbor:Podcast AND NOT neighbor:Concept AND NOT neighbor:__MetaContext__
          AND NOT neighbor:ReferenceLink AND NOT neighbor:PreparatoryNote
        
        OPTIONAL MATCH (node)-[:HAS_REFERENCE]->(ref:ReferenceLink)
        OPTIONAL MATCH (node)-[:HAS_PRIVATE_NOTE|CONTAINS*1..2]-(note:PreparatoryNote)
        WHERE note.tenant_id = $tenant_id AND NOT 'Category' IN labels(node)

        WITH node, roleRel, neighbor, r,
             collect(DISTINCT coalesce(ref.url, ref.link, ref.neighborUrl)) AS ref_urls,
             collect(DISTINCT apoc.text.replace(
                apoc.text.replace(
                    apoc.text.replace(
                        apoc.text.replace(note.text, "(?i)Situation:?\\s*", ""),
                        "(?i)Task:?\\s*", "\n"),
                    "(?i)Action:?\\s*", "\n"),
                "(?i)Result:?\\s*", "\n")
             ) AS narratives

        // Aggregate neighbors locally for THIS node before final projection
        WITH node, roleRel, narratives,
             apoc.coll.toSet(coalesce(node.links, []) + ref_urls + [node.url, node.link]) AS fused_links,
             collect(DISTINCT {
                name: coalesce(neighbor.name, neighbor.url, neighbor.text, neighbor.description, labels(neighbor)[0], "Unknown"),
                type: CASE 
                    WHEN 'Category' IN labels(neighbor) THEN 'Category'
                    WHEN 'Role' IN labels(neighbor) THEN 'Role'
                    WHEN 'Hackathon' IN labels(neighbor) THEN 'Hackathon'
                    WHEN 'ThoughtLeadership' IN labels(neighbor) THEN 'ThoughtLeadership'
                    WHEN 'Company' IN labels(neighbor) THEN 'Company'
                    WHEN 'ProfessionalEducation' IN labels(neighbor) THEN 'ProfessionalEducation'
                    WHEN 'Certification' IN labels(neighbor) THEN 'Certification'
                    WHEN 'Project' IN labels(neighbor) THEN 'Project'
                    ELSE labels(neighbor)[0] 
                END,
                relationship: type(r),
                link: coalesce(neighbor.link, neighbor.url, (CASE WHEN neighbor.links IS NOT NULL THEN neighbor.links[0] ELSE NULL END), null),
                description: left(coalesce(neighbor.description, neighbor.text, ""), 300)
             }) AS relationships

        RETURN 
            node { 
                .*, 
                type: labels(node)[0],
                display_date: coalesce(
                    roleRel.start + (CASE WHEN roleRel.end IS NOT NULL THEN "-" + roleRel.end ELSE "" END),
                    node.startDate + (CASE WHEN node.endDate IS NOT NULL THEN "-" + node.endDate ELSE "" END),
                    roleRel.date,
                    node.date,
                    toString(node.year),
                    node.published_at,
                    "Active"
                ),
                year: coalesce(
                    toString(node.year),
                    right(roleRel.start, 4),
                    right(node.startDate, 4),
                    right(roleRel.date, 4),
                    right(node.date, 4),
                    left(node.published_at, 4),
                    "2026"
                ),
                relationships: [rel IN relationships WHERE rel.name <> "Unknown"], 
                links: [l IN fused_links WHERE l IS NOT NULL AND l <> ""],
                text: apoc.text.join(narratives, "\n\n")
            } AS details
        LIMIT 25
        """
        try:
            print(f"[SEARCH] Running resume search for user: {requesting_user_id}")
            result = self.driver.execute_query(
                query, 
                tenant_id=self.tenant_id,
                keyword=search_keyword,
                allowed_labels=PROJECT_GRAPH_NODES
            )
            
            output = []
            for record in result.records:
                details = record["details"]
                details.pop("embedding", None)
                details.pop("tenant_id", None)
                output.append(details)
                
            return json.dumps(output, indent=2)
        except Exception as e:
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

    def get_cluster_context(self, node_name: str, depth: int = 1) -> str:
        """
        Fetch the semantic neighbors and relationships for a specific node to expand the graph view.
        """
        safe_depth = max(1, min(depth, 2))
        
        query = f"""
        MATCH (n {{tenant_id: $tenant_id}})
        WHERE n.name CONTAINS $node_name
        OPTIONAL MATCH path = (n)-[*1..{safe_depth}]-(m {{tenant_id: $tenant_id}})
        WHERE ALL(node IN nodes(path) WHERE NOT node:ReferenceLink)
        
        WITH n, collect(path) AS paths
        UNWIND (CASE WHEN size(paths) = 0 THEN [null] ELSE paths END) AS p
        WITH n, nodes(p) AS pathNodes, relationships(p) AS pathRels
        UNWIND (CASE WHEN pathNodes IS NULL THEN [n] ELSE pathNodes END) AS node
        UNWIND (CASE WHEN pathRels IS NULL THEN [null] ELSE pathRels END) AS rel
        
        OPTIONAL MATCH (node)-[:HAS_REFERENCE]->(ref:ReferenceLink)
        OPTIONAL MATCH (p:Person {{tenant_id: $tenant_id}})-[roleRel:CURRENTLY_BUILDING|HELD_ROLE|PARTICIPATED_IN|AUTHORED|CO_AUTHORED|CERTIFIED_BY|STUDIED_AT|GRADUATED_FROM|CONTRIBUTED_TO|FEATURE_GUEST|BUILT_DURING]-(node)
        OPTIONAL MATCH (node)-[:HAS_PRIVATE_NOTE|CONTAINS|CONTRIBUTED_TO*1..2]-(note:PreparatoryNote)
        WHERE note.tenant_id = $tenant_id AND NOT 'Category' IN labels(node)

        WITH n, node, rel, roleRel, 
             collect(DISTINCT coalesce(ref.url, ref.link, ref.neighborUrl)) AS cluster_ref_urls,
             collect(DISTINCT apoc.text.replace(
                apoc.text.replace(
                    apoc.text.replace(
                        apoc.text.replace(note.text, "(?i)Situation:?\\s*", ""),
                        "(?i)Task:?\\s*", "\n"),
                    "(?i)Action:?\\s*", "\n"),
                "(?i)Result:?\\s*", "\n")
             ) AS cluster_narratives

        WITH n, node, rel, roleRel, cluster_narratives,
             apoc.coll.toSet(coalesce(node.links, []) + cluster_ref_urls + [node.url, node.link]) AS fused_links

        WITH n, 
             collect(DISTINCT {{
                id: node.name,
                name: node.name,
                type: CASE 
                    WHEN 'Category' IN labels(node) THEN 'Category'
                    WHEN 'Role' IN labels(node) THEN 'Role'
                    WHEN 'Hackathon' IN labels(node) THEN 'Hackathon'
                    WHEN 'ThoughtLeadership' IN labels(node) THEN 'ThoughtLeadership'
                    WHEN 'Company' IN labels(node) THEN 'Company'
                    WHEN 'ProfessionalEducation' IN labels(node) THEN 'ProfessionalEducation'
                    WHEN 'Certification' IN labels(node) THEN 'Certification'
                    WHEN 'Project' IN labels(node) THEN 'Project'
                    ELSE labels(node)[0] 
                END,
                description: left(coalesce(node.description, node.text, ""), 200),
                url: node.url,
                links: [l IN fused_links WHERE l IS NOT NULL AND l <> ""],
                text: apoc.text.join(cluster_narratives, "\n\n"),
                // Adjusted context check: Prioritize roleRel dates if the node is being reached via a direct relationship
                display_date: coalesce(
                    roleRel.start + (CASE WHEN roleRel.end IS NOT NULL THEN "-" + roleRel.end ELSE "" END),
                    node.startDate + (CASE WHEN node.endDate IS NOT NULL THEN "-" + node.endDate ELSE "" END),
                    roleRel.date,
                    node.date,
                    toString(node.year),
                    node.published_at,
                    "Active"
                ),
                year: coalesce(
                    toString(node.year),
                    right(roleRel.start, 4),
                    right(node.startDate, 4),
                    right(roleRel.date, 4),
                    right(node.date, 4),
                    left(node.published_at, 4),
                    "2026"
                )
             }}) AS nodes, 
             collect(DISTINCT rel) AS rels
        RETURN 
            [n IN nodes WHERE n.id IS NOT NULL | n] AS nodes,
            [rel IN rels WHERE rel IS NOT NULL | {{
                source: startNode(rel).name,
                target: endNode(rel).name,
                type: type(rel)
            }}] AS links
        LIMIT 50
        """
        try:
            result = self.driver.execute_query(
                query, 
                tenant_id=self.tenant_id, 
                node_name=node_name
            )
            if not result.records:
                return json.dumps({"error": f"Node '{node_name}' not found."})
            
            record = result.records[0]
            return json.dumps({
                "nodes": record["nodes"],
                "links": record["links"]
            }, indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})

    def close(self):
        """Close the Neo4j driver"""
        if self.driver:
            self.driver.close()