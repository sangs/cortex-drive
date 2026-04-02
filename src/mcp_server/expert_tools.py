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
    
    def get_embedding(self, question: str, model: str = "text-embedding-ada-002") -> List[float]:
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

    def query_relevant_chunks(self, question: str, top_k: int = 5) -> List[Dict[str, Any]]:
        """Search chunks using keyword matching (GDS-free alternative)"""
        query = """
        MATCH (chunk:Chunk {tenant_id: $tenant_id})-[:BELONGS_TO_SOURCE]->(s:Source {tenant_id: $tenant_id})<-[:HAS_SOURCE]-(ep:Episode {tenant_id: $tenant_id})
        WHERE toLower(chunk.text) CONTAINS toLower($question)
        RETURN ep.name AS episode_name, 
               ep.number AS episode_number,
               ep.link AS episode_link,
               chunk.text AS text
        ORDER BY ep.number DESC
        LIMIT $top_k
        """
        
        result = self.driver.execute_query(
            query, tenant_id=self.tenant_id, 
            question=question, 
            top_k=top_k
        )
        
        # Convert result to list of dictionaries
        chunks = []
        for record in result.records:
            chunks.append({
                'episode_name': record['episode_name'],
                'episode_number': record['episode_number'],
                'episode_link': record['episode_link'],
                'text': record['text']
            })
        
        return chunks

    def query_relevant_chunks_hybrid(self, question: str, top_k: int = 5) -> List[Dict[str, Any]]:
        """Hybrid search: combines keyword search with topic-based search for better results"""
        # First try keyword search on chunks
        keyword_chunks = self.query_relevant_chunks(question, top_k)
        
        # If we don't have enough results, supplement with topic-based search
        if len(keyword_chunks) < top_k:
            remaining = top_k - len(keyword_chunks)
            topic_episodes = self.search_episodes_by_topic(question)
            
            # Convert topic results to chunk-like format
            for episode in topic_episodes[:remaining]:
                keyword_chunks.append({
                    'episode_name': episode['episode_name'],
                    'episode_number': episode['episode_number'],
                    'episode_link': episode['episode_link'],
                    'text': episode['description'][:500] + "..." if episode['description'] else "No description available",
                    'search_type': 'topic_based'
                })
        
        return keyword_chunks

    def find_episodes_by_topic(self, question: str) -> str:
        """
        Search for episodes that contain specific topics or keywords.
        
        This method performs a case-insensitive search across episode names, descriptions,
        and topic names to find episodes that match the given question. It returns episodes
        that have topics containing the search term, or episodes whose names/descriptions
        contain the search term.
        
        Args:
            question (str): The search term to look for in topics, episode names, or descriptions.
                          Can be a single word or phrase.
                          Examples: "database", "graph analytics", "AI machine learning"
        
        Returns:
            str: A JSON-formatted string containing a list of dictionaries, each containing:
                - episode_name (str): The name of the episode
                - episode_number (int): The episode number
                - episode_link (str): The URL link to the episode
                - description (str): The episode description
                - topics (List[str]): List of topic names associated with the episode
                - matched_term (str): The search term that was matched
                
        Example Output:
            [
              {
                "episode_name": "Episode Name",
                "episode_number": 123,
                "episode_link": "https://...",
                "description": "Episode description...",
                "topics": ["Topic1", "Topic2"],
                "matched_term": "database"
              }
            ]
                
        Example:
            >>> expert = ExpertTools()
            >>> results = expert.find_episodes_by_topic("database")
            >>> print(results[0]['episode_name'])
            "High Performance And Low Overhead Graphs With KuzuDB"
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
        If use_case is provided, fetches specific context. Otherwise, fetches all.
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
        Search for episodes that feature specific people (hosts, guests, or listeners).
        
        This method searches for people whose names contain the given question string
        and returns all episodes where they appear, along with their relationship type
        to the episode (e.g., HOSTS, GUEST_ON, LISTENS_TO_EPISODE, etc.).
        
        Args:
            question (str): The name or partial name of the person to search for.
                          Case-insensitive search that matches any part of the person's name.
                          Examples: "Prashanth", "John", "Rao"
        
        Returns:
            str: A JSON-formatted string containing a list of dictionaries, each containing:
                - person_name (str): The full name of the person
                - relationship_type (str): The type of relationship to the episode
                                         (e.g., "HOSTS", "GUEST_ON", "LISTENS_TO_EPISODE")
                - episode_name (str): The name of the episode
                - episode_number (int): The episode number
                - episode_link (str): The URL link to the episode
                - matched_term (str): The search term that was matched
                
        Example Output:
            [
              {
                "person_name": "John Doe",
                "relationship_type": "GUEST_ON",
                "episode_name": "Episode Name",
                "episode_number": 123,
                "episode_link": "https://...",
                "matched_term": "John"
              }
            ]
                
        Example:
            >>> expert = ExpertTools()
            >>> results = expert.find_episodes_by_people("Prashanth")
            >>> print(results[0]['person_name'])
            "Prashanth Rao"
            >>> print(results[0]['relationship_type'])
            "GUEST_ON"
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
        
        This method searches through the concept nodes in the graph to find episodes
        that cover specific concepts. It performs a case-insensitive search on both
        concept names and descriptions to find relevant episodes.
        
        Args:
            question (str): The concept name or description to search for.
                          Can be a single word or phrase.
                          Examples: "graph database", "AI machine learning", "data engineering analytics"
        
        Returns:
            str: A JSON-formatted string containing a list of dictionaries, each containing:
                - episode_name (str): The name of the episode
                - episode_number (int): The episode number
                - episode_link (str): The URL link to the episode
                - topic_name (str): The topic that covers this concept
                - concept_name (str): The name of the concept
                - concept_description (str): The detailed description of the concept
                - matched_term (str): The search term that was matched
                
        Example Output:
            [
              {
                "episode_name": "Episode Name",
                "episode_number": 123,
                "episode_link": "https://...",
                "topic_name": "Topic Name",
                "concept_name": "Concept Name",
                "concept_description": "Concept description...",
                "matched_term": "graph database"
              }
            ]
                
        Example:
            >>> expert = ExpertTools()
            >>> results = expert.find_episodes_by_concept("graph database")
            >>> print(results[0]['concept_name'])
            "Embeddable Graph Database"
            >>> print(results[0]['concept_description'][:50])
            "The concept discussed in the Data Engineering Podcast..."
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
        
        This method searches through the technology nodes in the graph to find episodes
        that cover specific technologies. It performs a case-insensitive search on
        technology names to find relevant episodes that discuss or mention the technology.
        
        Args:
            question (str): The technology name to search for.
                          Can be a single word or phrase.
                          Examples: "KuzuDB", "Snowflake Dynamic Tables", "Python Neo4j"
        
        Returns:
            str: A JSON-formatted string containing a list of dictionaries, each containing:
                - episode_name (str): The name of the episode
                - episode_number (int): The episode number
                - episode_link (str): The URL link to the episode
                - topic_name (str): The topic that covers this technology
                - technology_name (str): The name of the technology
                - matched_term (str): The search term that was matched
                
        Example Output:
            [
              {
                "episode_name": "Episode Name",
                "episode_number": 123,
                "episode_link": "https://...",
                "topic_name": "Topic Name",
                "technology_name": "Technology Name",
                "matched_term": "KuzuDB"
              }
            ]
                
        Example:
            >>> expert = ExpertTools()
            >>> results = expert.find_episodes_by_technology("KuzuDB")
            >>> print(results[0]['episode_name'])
            "High Performance And Low Overhead Graphs With KuzuDB"
            >>> print(results[0]['technology_name'])
            "KuzuDB"
            
        Note:
            This method searches through the graph relationship:
            Episode -> HAS_TOPIC -> Topic -> COVERS_TECHNOLOGY -> Technology
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
        
        Returns:
            str: A JSON-formatted string containing database statistics:
                - total_episodes (int): Total number of episodes
                - total_topics (int): Total number of topics
                - total_reference_links (int): Total number of reference links
                - total_chunks (int): Total number of transcript chunks
                
        Example Output:
            {
              "total_episodes": 2,
              "total_topics": 4,
              "total_reference_links": 8,
              "total_chunks": 1342
            }
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
        
        This method searches for episodes that are connected to reference links
        through the HAS_REFERENCE_LINK relationship, where the reference URL or text
        contains the provided string. It performs a case-insensitive search.
        
        Args:
            reference_string (str): String to search for in reference URLs or text.
        
        Returns:
            str: A JSON-formatted string containing a list of dictionaries, each containing:
                - episode_name (str): The name of the episode
                - episode_number (int): The episode number
                - episode_link (str): The URL link to the episode
                - description (str): The episode description
                - reference_url (str): The reference URL that was matched
                - reference_text (str): The text of the reference link
                - matched_term (str): The search term that was matched
                
        Example Output:
            [
              {
                "episode_name": "Episode Name",
                "episode_number": 123,
                "episode_link": "https://example.com/episode-123",
                "description": "Episode description...",
                "reference_url": "https://example.com/reference",
                "reference_text": "Reference Text",
                "matched_term": "github.com"
              }
            ]
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

    def find_episodes_by_mentions(self, search_terms: str) -> str:
        """
        Find episodes that mention the input search term in their reference links.
        
        This method searches for episodes that have reference links containing the
        provided search term. It performs a case-insensitive search on reference URLs
        and text to find relevant episodes.
        
        Args:
            search_terms (str): Search term to look for in reference links.
                              Can be a URL, partial URL, or keyword that might appear in reference text.
        
        Returns:
            str: A JSON-formatted string containing a list of dictionaries, each containing:
                - episode_name (str): The name of the episode
                - episode_number (int): The episode number
                - episode_link (str): The URL link to the episode
                - description (str): The episode description
                - reference_url (str): The reference URL that matched
                - reference_text (str): The text of the reference link
                - matched_term (str): The search term that was matched
                
        Example Output:
            [
              {
                "episode_name": "Episode Name",
                "episode_number": 123,
                "episode_link": "https://example.com/episode-123",
                "description": "Episode description...",
                "reference_url": "https://example.com/reference",
                "reference_text": "Reference Text",
                "matched_term": "example.com"
              }
            ]
        """
        query = """
        MATCH (e:Episode {tenant_id: $tenant_id})-[:HAS_REFERENCE_LINK]->(r:ReferenceLink)
        WHERE toLower(r.url) CONTAINS toLower($search_terms) OR 
              toLower(r.text) CONTAINS toLower($search_terms)
        RETURN e.name AS episode_name,
               e.number AS episode_number,
               e.link AS episode_link,
               e.description AS description,
               r.url AS reference_url,
               r.text AS reference_text,
               $search_terms AS matched_term
        ORDER BY e.number DESC
        """
        
        result = self.driver.execute_query(query, tenant_id=self.tenant_id, search_terms=search_terms)
        
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
                    return "text-embedding-ada-002"  # Most likely model for 1536 dimensions
                elif dimension == 3072:
                    return "text-embedding-3-large"
                elif dimension == 384:
                    return "text-embedding-3-small"  # This might be the actual model used
                else:
                    return "text-embedding-ada-002"  # Default fallback
        
        return "text-embedding-ada-002"  # Default fallback

    def search_by_question_old(self, user_question: str, top_k: int = 5, similarity_threshold: float = 0.7) -> str:
        """
        Search for episodes using semantic similarity based on user question.
        
        This method performs semantic search by:
        1. Getting an embedding for the user question
        2. Retrieving all chunks with their embeddings from the database
        3. Calculating cosine similarity between the question and each chunk
        4. Returning episodes with the most relevant chunks above the similarity threshold
        
        Args:
            user_question (str): The user's question or search query
            top_k (int): Maximum number of results to return (default: 5)
            similarity_threshold (float): Minimum similarity score to include results (default: 0.7)
        
        Returns:
            str: A JSON-formatted string containing a list of dictionaries, each containing:
                - episode_name (str): The name of the episode
                - episode_number (int): The episode number
                - episode_link (str): The URL link to the episode
                - description (str): The episode description
                - chunk_text (str): The relevant text chunk from the episode
                - similarity_score (float): The cosine similarity score
                
        Example Output:
            [
              {
                "episode_name": "Episode Name",
                "episode_number": 123,
                "episode_link": "https://example.com/episode-123",
                "description": "Episode description...",
                "chunk_text": "Relevant text from the episode transcript...",
                "similarity_score": 0.85
              }
            ]
        """
        # Detect the embedding model used for chunks and get embedding for the user question
        chunk_model = self.detect_embedding_model()
        question_embedding = self.get_embedding(user_question)
        
        # Query to get all chunks with their embeddings and episode information
        query = """
        MATCH (c:Chunk {tenant_id: $tenant_id})-[:BELONGS_TO_SOURCE]->(s:Source {tenant_id: $tenant_id})<-[:HAS_SOURCE]-(e:Episode {tenant_id: $tenant_id})
        WHERE c.embedding IS NOT NULL
        RETURN e.name AS episode_name,
               e.number AS episode_number,
               e.link AS episode_link,
               e.description AS description,
               c.text AS chunk_text,
               c.embedding AS chunk_embedding
        """
        
        result = self.driver.execute_query(query, tenant_id=self.tenant_id)
        
        # Calculate similarities and filter by threshold
        relevant_chunks = []
        for record in result.records:
            chunk_embedding = record['chunk_embedding']
            if chunk_embedding:  # Ensure embedding exists
                similarity = self.cosine_similarity(question_embedding, chunk_embedding)
                
                if similarity >= similarity_threshold:
                    relevant_chunks.append({
                        'episode_name': record['episode_name'],
                        'episode_number': record['episode_number'],
                        'episode_link': record['episode_link'],
                        'description': record['description'],
                        'chunk_text': record['chunk_text'],
                        'similarity_score': similarity
                    })
        
        # Sort by similarity score (descending) and limit results
        relevant_chunks.sort(key=lambda x: x['similarity_score'], reverse=True)
        relevant_chunks = relevant_chunks[:top_k]
        
        return json.dumps(relevant_chunks, indent=2)

    def search_episodes_gds_by_question(
        self, question: str, k: Optional[int] = 5, limit: Optional[int] = 10
    ) -> str:
        """
        Extended search that combines vector search with GDS KNN relationships.
        
        This method:
        1. Performs vector search to find seed episodes
        2. Follows pre-calculated SEMANTICALLY_SIMILAR_KNN relationships from seed episodes
        3. Combines and ranks results using both index scores and KNN similarity scores
        
        Args:
            question (str): The user's question
            k (int): Number of nearest neighbor chunks to retrieve for initial search (default: 5)
            limit (int): Total number of results to return (default: 10)
            
        Returns:
            str: JSON string containing:
                - SeedEpisode: Name of the episode found via vector search
                - SeedEpisodeNumber: Episode number
                - SeedEpisode_IndexScore: Similarity score from vector index
                - SimilarEpisode: Name of the episode found via KNN relationship (may be None)
                - SimilarEpisodeNumber: Episode number (may be None)
                - KNN_Similarity_Score: Pre-calculated KNN similarity score (may be None)
        """
        # Step 1: Create embedding for the question using text-embedding-3-small
        question_embedding = self.get_embedding(question, model="text-embedding-3-small")
        
        # Step 2: Execute combined vector search + GDS KNN query
        with self.driver.session() as session:
            result = session.run("""
                // Step 1-2: Query the vector index and find seed episodes
                CALL db.index.vector.queryNodes(
                    'chunkIndex',
                    $k,
                    $questionEmbedding
                )
                YIELD node AS chunk, score AS indexScore

                // Match the relationship to find the parent Episode (seed episode)
                MATCH (seedEpisode:Episode {tenant_id: $tenant_id})-[:HAS_SOURCE]->(s:Source)-[:CONTAINS]->(chunk)

                // Step 3: Follow the pre-calculated KNN relationships from the seed episodes
                OPTIONAL MATCH (seedEpisode)-[r:SEMANTICALLY_SIMILAR_KNN]->(similarEpisode:Episode {tenant_id: $tenant_id})

                // Step 4: Combine and rank the results
                RETURN DISTINCT // Use DISTINCT to avoid duplicates if multiple seeds point to the same episode
                    seedEpisode.name AS SeedEpisode,
                    seedEpisode.number AS SeedEpisodeNumber,
                    indexScore AS SeedEpisode_IndexScore,
                    similarEpisode.name AS SimilarEpisode,
                    similarEpisode.number AS SimilarEpisodeNumber,
                    r.knn_score AS KNN_Similarity_Score
                ORDER BY 
                    SeedEpisode_IndexScore DESC, // Prioritize results from a stronger index match
                    KNN_Similarity_Score DESC // Use KNN score as a secondary rank
                LIMIT $limit // Return the top N overall results
            """, questionEmbedding=question_embedding, k=k, limit=limit, tenant_id=self.tenant_id)
            
            # Collect results
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

    def create_question_embedding(self, question: str) -> List[float]:
        """
        Create an embedding for a user's question using OpenAI's text-embedding-3-small model.
        
        Args:
            question (str): The user's question text
            
        Returns:
            list: A 1536-dimensional vector embedding of the question
        """
        return self.get_embedding(question, model="text-embedding-3-small")

    def search_episodes_by_question(self, question: str, k: int = 5) -> str:
        """
        Search for relevant episodes using vector similarity search on chunk embeddings.
        
        Args:
            question (str): The user's question
            k (int): Number of nearest neighbor chunks to retrieve (default: 5)
            
        Returns:
            str: JSON string containing a list of dictionaries with:
                - EpisodeTitle: Name of the episode
                - EpisodeNumber: Episode number
                - ChunkContent: Content of the matching chunk
                - SimilarityScore: Similarity score from vector index
        """
        # Step 1: Create embedding for the question
        question_embedding = self.create_question_embedding(question)
        
        # Step 2: Execute vector search query
        with self.driver.session() as session:
            result = session.run("""
                // Step 1: Query the vector index ('chunkIndex') to find the most similar chunks.
                // $questionEmbedding is the list of floats/integers representing the user's question.
                // $k specifies the number of nearest neighboring chunks to retrieve.
                CALL db.index.vector.queryNodes(
                    'chunkIndex',
                    $k,
                    $questionEmbedding
                )
                YIELD node AS chunk, score

                // Step 2: Match the relationship to find the parent Episode.
                // We use the inverse direction of the BELONGS_TO relationship 
                // to go from the retrieved Chunk node back to the Episode node.
                MATCH (episode:Episode {tenant_id: $tenant_id})-[:HAS_SOURCE]->(s:Source)-[:CONTAINS]->(chunk)

                // Step 3: Return the results, ordered by similarity score.
                RETURN
                    episode.name AS EpisodeTitle,
                    episode.number AS EpisodeNumber,
                    // Return properties of the matching chunk (e.g., its content)
                    chunk.text AS ChunkContent, 
                    score AS SimilarityScore
                ORDER BY
                    SimilarityScore DESC
            """, questionEmbedding=question_embedding, k=k, tenant_id=self.tenant_id)
            
            # Collect results
            results = []
            for record in result:
                results.append({
                    'EpisodeTitle': record['EpisodeTitle'],
                    'EpisodeNumber': record['EpisodeNumber'],
                    'ChunkContent': record['ChunkContent'],
                    'SimilarityScore': float(record['SimilarityScore']) if record['SimilarityScore'] else None
                })
            
            return json.dumps(results, indent=2)

    def search_episodes_gds_by_question_tool(self, question: str, k: int, limit: int) -> str:
        """
        Extended search that combines vector search with GDS KNN relationships.
        This is a wrapper method without default values for Google ADK compatibility.
        
        Args:
            question (str): The user's question
            k (int): Number of nearest neighbor chunks to retrieve for initial search
            limit (int): Total number of results to return
            
        Returns:
            str: JSON string containing search results
        """
        return self.search_episodes_gds_by_question(question, k=k, limit=limit)

    def search_episodes_by_question_tool(self, question: str, k: int) -> str:
        """
        Search for relevant episodes using vector similarity search on chunk embeddings.
        This is a wrapper method without default values for Google ADK compatibility.
        
        Args:
            question (str): The user's question
            k (int): Number of nearest neighbor chunks to retrieve
            
        Returns:
            str: JSON string containing search results
        """
        return self.search_episodes_by_question(question, k=k)

    def get_people_by_episode(self, episode_name: str) -> str:
        """
        Find all people (hosts, guests, etc.) associated with a specific episode.
        
        Args:
            episode_name (str): The name or partial name of the episode.
            
        Returns:
            str: A JSON-formatted string containing a list of people and their roles.
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

    def hybrid_discovery(self, question: str, k: int = 5) -> str:
        """
        Native Hybrid Search (GraphRAG): Performs vector search on chunks and 
        immediately traverses to parent Episode and related nodes.
        
        Returns a unified JSON object with content, metadata, and participants.
        """
        question_embedding = self.get_embedding(question, model="text-embedding-3-small")
        
        query = """
        CALL db.index.vector.queryNodes('chunkIndex', 100, $questionEmbedding)
        YIELD node AS chunk, score
        MATCH (chunk)<-[:CONTAINS]-(s:Source)<-[:HAS_SOURCE]-(e:Episode {tenant_id: $tenant_id})
        
        OPTIONAL MATCH (p:Person)-[r]-(e)
        WHERE type(r) IN ['IS_A_HOST', 'IS_A_GUEST']
        
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
            # Map legacy metadata arrays into the Universal Graph relationships schema
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
                'name': record['episode_title'],  # explicit name mapping for the frontend
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

        Owner bypass: If requesting_user_id matches the OWNER_USER_ID environment
        variable, all sanitization is skipped and the full query is executed.

        Non-owners are blocked from backward traversals that could expose private
        nodes (Chunk, Source, PreparatoryNote) even if they share the same tenant.

        Args:
            query (str): The Cypher query string. Should include $tenant_id param.
            requesting_user_id (str): Clerk 'sub' claim of the calling user.

        Returns:
            str: JSON string with query results, or an error dict if blocked.
        """
        import re

        # --- Owner Detection ---
        # OWNER_USER_ID is the Clerk user sub claim of the graph creator.
        # Set this in your .env file. Owner can run ANY query without restriction.
        owner_user_id = os.environ.get("OWNER_USER_ID", "")
        is_owner = bool(owner_user_id and requesting_user_id == owner_user_id)

        # --- Schema Readable Permission Check ---
        # If not owner and not authorized for schema, block introspection keywords
        if not is_owner and not schema_readable:
            INTRO_KEYWORDS = ["CALL", "db.labels", "db.schema", "SHOW", "db.relationshipTypes", "introspection"]
            if any(k.lower() in query.lower() for k in INTRO_KEYWORDS):
                msg = "Access Denied: Schema Readable permission required for introspection (CALL, db.schema, SHOW, etc.)."
                print(f"[CYPHER BLOCKED] user={requesting_user_id} reason=UNAUTHORIZED_SCHEMA_READ")
                return json.dumps({"error": msg})

        if is_owner:
            print(f"[CYPHER] Owner bypass granted for user: {requesting_user_id}")
        else:
            # --- Sanitizer: Forbidden traversal patterns for non-owners ---
            # These patterns detect backward traversals into the Source Domain
            # (Chunk, Source) or direct access to private nodes (PreparatoryNote).
            # The No-Bounce Firewall: traversal can go DOWN and OUT, not backward UP.
            FORBIDDEN_PATTERNS = [
                # Backward edge into raw chunk content
                (r"<-\s*\[\s*:CONTAINS", "Backward traversal into Chunk via CONTAINS"),
                # Backward edge into Source node from the graph
                (r"<-\s*\[\s*:HAS_SOURCE", "Backward traversal into Source via HAS_SOURCE"),
                # Direct label match on private note nodes
                (r"\(\s*\w*\s*:PreparatoryNote", "Direct access to PreparatoryNote nodes"),
                # Private note relationship traversal
                (r":HAS_PRIVATE_NOTE", "Traversal via HAS_PRIVATE_NOTE relationship"),
                # Direct raw chunk label access
                (r"\(\s*\w*\s*:Chunk\b", "Direct access to Chunk nodes"),
                # Direct access to Source nodes (only owner can browse sources)
                (r"\(\s*\w*\s*:ResumeChunk", "Direct access to ResumeChunk nodes"),
            ]

            for pattern, reason in FORBIDDEN_PATTERNS:
                if re.search(pattern, query, re.IGNORECASE):
                    msg = (
                        f"Query blocked by security policy: {reason}. "
                        f"This traversal path is restricted to the graph owner. "
                        f"Use search_resume_graph or hybrid_discovery_tool instead."
                    )
                    print(f"[CYPHER BLOCKED] user={requesting_user_id} reason={reason}")
                    return json.dumps({"error": msg})

            print(f"[CYPHER] Query approved for non-owner user: {requesting_user_id}")

        # --- Execute approved / bypassed query ---
        try:
            result = self.driver.execute_query(
                query,
                tenant_id=self.tenant_id
            )

            output = []
            for record in result.records:
                output.append(record.data())

            return json.dumps(output, indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})
    def get_node_details(self, node_name: str) -> str:
        """
        Fetch all properties and labels for a specific node by its 'name' property.
        Use this to 'enrich' your knowledge of an entity once you have its name from a search.
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
        Returns all connected nodes and relationship types.
        Use this for 'drill-down' discovery (e.g., 'What are the projects in this category?').
        """
        query = """
        MATCH (node {tenant_id: $tenant_id})-[r]-(neighbor)
        WHERE toLower(node.name) = toLower($node_name)
          AND neighbor.tenant_id = $tenant_id
          AND any(label IN labels(neighbor) WHERE label IN $allowed_labels)
        RETURN labels(neighbor) AS EntityTypes, properties(neighbor) AS Details, type(r) AS RelationshipType
        LIMIT 20
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
                
                output.append({
                    "name": details.get("name") or details.get("text") or details.get("description") or record["EntityTypes"][0],
                    "type": record["EntityTypes"][0],
                    "Relationship": record["RelationshipType"],
                    "Details": details
                })
            return json.dumps(output, indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})

    def search_resume_graph(self, keyword: str) -> str:
        """
        Search for entities across the Interactive Resume Graph dynamically.
        Matches keywords against Node Names and Descriptions strictly for nodes 
        defined in the PROJECT_GRAPH_NODES schema guard.
        
        NOTE: You are a professional assistant. User content is often organized using 
        internal STAR (Situation, Task, Action, Result) logic or 'Interview Notes'. 
        You MUST NEVER mention these labels or terms (STAR, PreparatoryNote, Interview Note) 
        in your narrative response. Use the data content to answer, but keep the 
        methodology invisible.
        
        Args:
            keyword (str): Search term (e.g., "startup", "clerk", "hackathon", "architectural")
            
        Returns:
            str: JSON string containing a list of matching nodes with their Labels and Properties.
        """
        # Step 1: Detect high-level semantic requests (Portfolio / Overview)
        discovery_synonyms = ["portfolio", "overview", "background", "experience"]
        is_discovery_request = any(s in keyword.lower() for s in discovery_synonyms)
        
        # Step 1.5: Clean punctuation and filter stop words to prevent noise (e.g. 'at' matching everything)
        stop_words = {"show", "me", "how", "did", "she", "what", "is", "the", "and", "a", "an", "at", "in", "of", "for", "with", "on", "to", "from", "by"}
        clean_keyword = keyword.lower().replace(".", "").replace(",", "").replace("?", "").replace("!", "")
        keywords = [w for w in clean_keyword.split() if w not in stop_words]
        final_keyword_str = " ".join(keywords) if keywords else keyword

        search_keyword = final_keyword_str
        if is_discovery_request:
            search_keyword = "Category" if not "Category" in keyword else final_keyword_str

        query = """
        WITH split(toLower(coalesce($keyword, "")), ' ') AS keywords
        MATCH (node)
        WHERE node.tenant_id = $tenant_id
          AND any(label IN labels(node) WHERE label IN $allowed_labels)
        
        // Context Awareness: Check if parent Category OR associated Company matches the keywords
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
                // Semantic Expansion for Infrastructure/Modernization/Education
                OR (any(word IN keywords WHERE word IN ['infra', 'infrastructure', 'pipeline', 'msk', 'kafka', 'datamesh', 'modernize', 'modernization']) 
                    AND (node:Project OR node:Company OR node:Technology))
                OR (any(word IN keywords WHERE word IN ['academic', 'education', 'cert', 'certification', 'degree', 'foundation']) 
                    AND (node:Degree OR node:Institution OR node:Certification OR node:ProfessionalEducation))
        )
        
        OPTIONAL MATCH (node)-[r]-(neighbor)
        WHERE neighbor IS NOT NULL 
          AND neighbor.tenant_id = $tenant_id
          AND NOT neighbor:Chunk AND NOT neighbor:Episode AND NOT neighbor:Topic AND NOT neighbor:Source AND NOT neighbor:Podcast AND NOT neighbor:Concept AND NOT neighbor:__MetaContext__
          AND NOT neighbor:PreparatoryNote AND NOT neighbor:ReferenceLink
        
        // Deep Link Flattening (ReferenceLinks)
        OPTIONAL MATCH (node)-[:HAS_REFERENCE]->(ref:ReferenceLink)
        
        WITH node, collect(DISTINCT ref.url) AS ref_urls, collect(DISTINCT {
            target_name: coalesce(neighbor.name, neighbor.text, neighbor.description, labels(neighbor)[0], "Unknown"),
            target_type: labels(neighbor)[0],
            rel_type: type(r),
            link: coalesce(neighbor.link, neighbor.url, (CASE WHEN neighbor.links IS NOT NULL THEN neighbor.links[0] ELSE NULL END), null),
            description: left(coalesce(neighbor.description, neighbor.text, ""), 300),
            start: r.start,
            end: r.end,
            year: r.year,
            date: r.date
            // Removed target_properties: properties(neighbor) to resolve token bloat (TPM Limit)
        }) AS raw_relationships
        
        WITH node, ref_urls, [rel IN raw_relationships WHERE rel.target_name IS NOT NULL AND rel.target_name <> "Unknown"] AS relationships
        
        // Final link consolidation (Node property + ReferenceLinks + url/link fallbacks)
        WITH node, relationships, 
             [url IN (coalesce(node.links, []) + ref_urls + [node.link, node.url]) WHERE url IS NOT NULL AND url <> ""] AS all_links
        
        // Prioritize Category, Hackathon and Leadership nodes for discovery (Truncate Description/Text for Context Health)
        RETURN labels(node) AS EntityTypes, 
               {
                 name: node.name, 
                 type: coalesce(node.type, labels(node)[0]),
                 description: left(coalesce(node.description, ""), 300),
                 text: left(coalesce(node.text, ""), 300),
                 links: all_links,
                 year: node.year, date: node.date,
                 employer: node.employer, location: node.location,
                 tenant_id: node.tenant_id
               } AS Details, 
               relationships,
               CASE 
                 WHEN 'Category' IN labels(node) THEN 2 
                 WHEN 'Hackathon' IN labels(node) OR 'ThoughtLeadership' IN labels(node) THEN 1
                 // Boost Project nodes that match the query strongly
                 WHEN 'Project' IN labels(node) THEN 1
                 ELSE 0 
               END as priority
        ORDER BY priority DESC, CASE WHEN node.year IS NULL THEN -1 ELSE toInteger(node.year) END DESC, node.name ASC
        LIMIT 15
        """
        try:
            result = self.driver.execute_query(
                query, 
                tenant_id=self.tenant_id,
                keyword=search_keyword,
                allowed_labels=PROJECT_GRAPH_NODES
            )
            
            output = []
            for record in result.records:
                # Clean up internal metadata properties before returning to LLM
                details = record["Details"]
                details.pop("embedding", None)
                details.pop("tenant_id", None)
                
                # Priority mapping from Cypher
                priority = record.get("priority", 0)
                details["priority"] = priority

                # Infer Year for Y-Axis Sorting
                rels = record["relationships"]
                years = []
                
                # Check node properties first (startDate, endDate, year, date)
                # NOTE: node.year is stored as a string (e.g. "2026") — must
                # parse to int explicitly; negating a string silently yields 0.
                for prop in ["startDate", "endDate", "year", "date"]:
                    raw = details.get(prop, "")
                    val = str(raw) if raw is not None else ""
                    if any(word in val.lower() for word in ["present", "active", "current"]):
                        years.append(2030)  # Boost future/active
                    else:
                        match = re.search(r'(\d{4})', val)
                        if match:
                            years.append(int(match.group(1)))

                # Direct parse of the year string property (e.g. "2026" -> 2026)
                # This is the critical fix: ensures inferred_year is always an int.
                raw_year = details.get("year", "")
                if raw_year and str(raw_year).isdigit():
                    years.append(int(str(raw_year)))

                # Iterate relationship arrays
                for r in rels:
                    # Check rel properties directly
                    for key in ["start", "end", "year", "date"]:
                        val = str(r.get(key, ""))
                        if any(word in val.lower() for word in ["present", "active", "current"]):
                            years.append(2030)
                        else:
                            match = re.search(r'(\d{4})', val)
                            if match:
                                years.append(int(match.group(1)))
                
                # Default for Category nodes: always treat them as high priority/current
                if 'Category' in record["EntityTypes"]:
                   years.append(2030)

                details["inferred_year"] = max(years) if years else 1990
                
                # --- DEEP SORTING: Sort the relationships themselves chronologically ---
                def get_rel_year(r):
                    r_years = []
                    # Check rel properties directly
                    for key in ["start", "end", "year", "date"]:
                        val = str(r.get(key, ""))
                        if any(word in val.lower() for word in ["present", "active", "current"]):
                            r_years.append(2030)
                        else:
                            match = re.search(r'(\d{4})', val)
                            if match:
                                r_years.append(int(match.group(1)))
                    return max(r_years) if r_years else 1990

                # Sort nested relationships: Year (DESC), Name (ASC)
                rels.sort(key=lambda r: (-get_rel_year(r), r.get("target_name", "")))
                
                output.append({
                    "name": details.get("name") or details.get("text") or details.get("description") or (record["EntityTypes"][0] if record["EntityTypes"] else "Node"),
                    "type": record["EntityTypes"][0] if record["EntityTypes"] else "Node",
                    "EntityTypes": record["EntityTypes"],
                    "Details": {
                        **details,
                        "description": (details.get("description", "")[:300] + "...") if len(details.get("description", "")) > 300 else details.get("description", ""),
                        "text": (details.get("text", "")[:300] + "...") if len(details.get("text", "")) > 300 else details.get("text", "")
                    },
                    "relationships": rels
                })
            
            # Multi-level sort for top-level nodes: Priority (DESC), Year (DESC), Name (ASC)
            output.sort(key=lambda x: (
                -x["Details"].get("priority", 0),
                -x["Details"].get("inferred_year", 0),
                x["name"]
            ))

            return json.dumps(output, indent=2)
        except Exception as e:
            import traceback
            import sys
            traceback.print_exc(file=sys.stderr)
            return json.dumps({"error": str(e)})

    def explore_graph_schema(self, schema_readable: bool = False) -> str:
        """
        Introspect the Neo4j database to find exactly what Node Labels and Relationships exist.
        Locked down to users with 'Schema Readable' permission (Admins/Owner).
        """
        if not schema_readable:
            return json.dumps({"error": "Access Denied: Schema Readable permission required to introspect the graph ontology."})

        """
        Dynamically extracts the ontology (node labels and relationship types) exactly as they exist in the Neo4j database.
        Returns a simplified list of valid relationships in the format (StartNode)-[:REL_TYPE]->(EndNode).
        """
        query = "CALL db.schema.visualization() YIELD relationships RETURN relationships"
        try:
            with self.driver.session() as session:
                res = session.run(query)
                schema_rules = []
                for r in res:
                    for rel in r["relationships"]:
                        start = rel.start_node.labels[0] if rel.start_node.labels else "Unknown"
                        end = rel.end_node.labels[0] if rel.end_node.labels else "Unknown"
                        
                        # filter out vector similarities to save LLM tokens
                        if rel.type not in ["SIMILAR", "IS_SIMILAR", "SEMANTICALLY_SIMILAR_KNN"]:
                            schema_rules.append(f"({start})-[:{rel.type}]->({end})")
                
                unique_rules = sorted(list(set(schema_rules)))
                return json.dumps({"Active_Database_Schema": unique_rules}, indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})

    def get_cluster_context(self, node_name: str, depth: int = 1) -> str:
        """
        Fetch the semantic neighbors and relationships for a specific node to expand the graph view.
        Use this for Directed Autonomy to proactively discover related context.
        
        Args:
            node_name (str): The 'name' property of the seed node.
            depth (int): The distance to traverse (1 for immediate neighbors, 2 for extended context).
        """
        # Limit depth to 1 or 2 to avoid graph blowout
        safe_depth = max(1, min(depth, 2))
        
        query = f"""
        MATCH (n {{name: $node_name, tenant_id: $tenant_id}})
        OPTIONAL MATCH path = (n)-[*1..{safe_depth}]-(m {{tenant_id: $tenant_id}})
        WITH n, collect(path) AS paths
        UNWIND (CASE WHEN size(paths) = 0 THEN [null] ELSE paths END) AS p
        WITH n, nodes(p) AS pathNodes, relationships(p) AS pathRels
        UNWIND (CASE WHEN pathNodes IS NULL THEN [n] ELSE pathNodes END) AS node
        UNWIND (CASE WHEN pathRels IS NULL THEN [null] ELSE pathRels END) AS rel
        WITH n, 
             collect(DISTINCT node) AS nodes, 
             collect(DISTINCT rel) AS rels
        RETURN 
            [node IN nodes WHERE node IS NOT NULL | {{
                id: node.name,
                name: node.name,
                type: labels(node)[0],
                description: left(coalesce(node.description, node.text, ""), 200),
                url: node.url,
                year: node.year,
                date: node.date
            }}] AS nodes,
            [rel IN rels WHERE rel IS NOT NULL | {{
                source: startNode(rel).name,
                target: endNode(rel).name,
                type: type(rel)
            }}] AS links
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
            # Ensure the seed node is included if no relationships found
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



        