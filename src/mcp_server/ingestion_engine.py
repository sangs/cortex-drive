import os
import json
from typing import List, Dict, Any
from datetime import datetime
from openai import OpenAI
from neo4j import GraphDatabase
from schema_guard import (
    validate_upsert, 
    CORTEX_DRIVE_NODES, 
    PROJECT_GRAPH_NODES, 
    SYSTEM_NODES,
    CORTEX_DRIVE_RELATIONSHIPS, 
    PROJECT_GRAPH_RELATIONSHIPS
)
from expert_tools import ExpertTools
import re
from baml_client import b
from baml_client.types import Topic, Concept, Technology, Person, ReferenceLink, Podcast, Episode as BamlEpisode, Relationship

class IngestionEngine:
    """
    CortexDrive Unified Ingestion Engine.
    Consolidates the 10-step legacy ingestion process into a streamlined pipeline.
    """
    
    def __init__(self, tenant_id: str):
        self.tenant_id = tenant_id
        self.expert = ExpertTools(tenant_id=tenant_id)
        self.client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
        self.driver = GraphDatabase.driver(
            os.environ["NEO4J_URI"],
            auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"])
        )

    def close(self):
        self.expert.close()
        self.driver.close()

    def process_transcript(self, transcript_text: str, episode_metadata: Dict[str, Any]):
        """
        Main entry point for processing a single transcript.
        """
        print(f"Starting ingestion for Episode {episode_metadata.get('number')}...")
        
        # 1. Schema Validation for Episode
        episode_metadata['tenant_id'] = self.tenant_id
        validated_ep = validate_upsert('Episode', episode_metadata)
        
        # 2. Upsert Episode Node
        self._upsert_episode(validated_ep)
        
        # 3. Create Source Metadata Node
        source_data = {
            'tenant_id': self.tenant_id,
            'type': episode_metadata.get('source_type', 'LocalFile'),
            'fileName': episode_metadata.get('fileName', f"episode_{validated_ep.number}.txt"),
            'fileSource': episode_metadata.get('fileSource', f"ep{validated_ep.number}"),
            'ingestedAt': str(datetime.now())
        }
        validated_source = validate_upsert('Source', source_data)

        # 4. Semantic Chunking & Embedding
        chunks = self._create_chunks(transcript_text, validated_ep)
        
        # 5. LLM Entity Extraction (Graph Transformation)
        entities = self._extract_entities(transcript_text, validated_ep.name)
        
        # 6. Atomic Upsert of Source, Chunks & Entities
        self._upsert_graph_data(validated_ep, validated_source, chunks, entities)
        
        # 6. Metadata Context Injection (Listener & Podcast Hierarchy)
        podcast_title = episode_metadata.get('podcast_title')
        invoked_by = episode_metadata.get('invoked_by')
        if podcast_title or invoked_by:
            self._upsert_metadata_relationships(validated_ep, podcast_title, invoked_by)
        
        # 7. Post-Processing Enrichment (GDS, KNN, etc.)
        self._trigger_enrichment(validated_ep)
        
        print(f"Ingestion complete for Episode {validated_ep.number}.")

    def _upsert_episode(self, ep_node):
        query = """
        MERGE (ep:Episode {tenant_id: $tenant_id, number: $number})
        SET ep += $props
        """
        props = ep_node.dict()
        # Neo4j cannot store dictionaries in properties; serialize the metadata generic store
        if 'metadata' in props and isinstance(props['metadata'], dict):
            props['metadata'] = json.dumps(props['metadata'])
            
        with self.driver.session() as session:
            session.run(query, tenant_id=self.tenant_id, number=ep_node.number, props=props)

    def _create_chunks(self, text: str, ep_node, chunk_size: int = 1000):
        # Resilient regex for [H:M:S] or [M:S]
        ts_pattern = re.compile(r"\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]")
        
        words = text.split()
        chunks = []
        for i in range(0, len(words), chunk_size):
            chunk_text = " ".join(words[i:i + chunk_size])
            embedding = self.expert.get_embedding(chunk_text)
            
            # Extract first timestamp in this chunk
            start_seconds = None
            ts_match = ts_pattern.search(chunk_text)
            if ts_match:
                h_str, m_str, s_str = ts_match.groups()
                h = int(h_str) if h_str else 0
                m = int(m_str)
                s = int(s_str)
                start_seconds = h * 3600 + m * 60 + s
            
            chunk_data = {
                'tenant_id': self.tenant_id,
                'text': chunk_text,
                'embedding': embedding,
                'order': len(chunks) + 1,
                'startTime': start_seconds
            }
            chunks.append(validate_upsert('Chunk', chunk_data))
            
            # Post-process: Set endTime for the PREVIOUS chunk if we just found a startTime
            if len(chunks) > 1 and start_seconds is not None:
                chunks[-2].endTime = start_seconds

        return chunks

    def _extract_entities(self, text: str, episode_title: str):
        """
        Extract Topics, Concepts, and Technologies from text using BAML.
        """
        print(f"Extracting strictly constrained entities for tenant {self.tenant_id} using BAML...")
        
        # Use BAML client for structured extraction
        extracted = b.ExtractGraph(transcript=text, episode_title=episode_title)
        
        # Convert BAML types to LangChain-compatible Document-like graph structure
        # (or directly to a format we can upsert)
        # For now, let's keep the return type meaningful for _upsert_graph_data
        
        return extracted

    def _upsert_graph_data(self, ep, source, chunks, extraction):
        with self.driver.session() as session:
            # 1. Upsert Source Node
            query_source = """
            MATCH (ep:Episode {tenant_id: $tenant_id, number: $ep_num})
            MERGE (s:Source {tenant_id: $tenant_id, fileName: $fileName})
            ON CREATE SET s.type = $type, s.fileSource = $fileSource, s.ingestedAt = $ingestedAt
            MERGE (ep)-[:HAS_SOURCE]->(s)
            """
            session.run(query_source, 
                tenant_id=self.tenant_id, ep_num=ep.number,
                fileName=source.fileName, type=source.type, 
                fileSource=source.fileSource, ingestedAt=source.ingestedAt
            )

            # 2. Upsert Chunks
            for chunk in chunks:
                query_chunk = """
                MATCH (s:Source {tenant_id: $tenant_id, fileName: $fileName})
                MERGE (c:Chunk {tenant_id: $tenant_id, order: $order, embedding: $embedding})
                SET c.text = $text, c.startTime = $startTime, c.endTime = $endTime
                MERGE (s)-[:CONTAINS]->(c)
                MERGE (c)-[:BELONGS_TO_SOURCE]->(s)
                """
                session.run(query_chunk, 
                    tenant_id=self.tenant_id, 
                    fileName=source.fileName,
                    order=chunk.order,
                    text=chunk.text,
                    embedding=chunk.embedding,
                    startTime=chunk.startTime,
                    endTime=chunk.endTime
                )

            # 3. Upsert BAML Extractions
            self._upsert_baml_entities(ep, extraction)

    def _upsert_baml_entities(self, ep, extraction):
        """
        Surgically upsert BAML-extracted entities and link them to the episode.
        """
        with self.driver.session() as session:
            # 1. Upsert Podcasts and Episodes (if any metadata was extracted/clarified)
            for podcast in extraction.podcasts:
                query = "MERGE (p:Podcast {tenant_id: $tenant_id, title: $title})"
                session.run(query, tenant_id=self.tenant_id, title=podcast.title)

            for b_ep in extraction.episodes:
                query = """
                MERGE (ep:Episode {tenant_id: $tenant_id, number: $number})
                ON CREATE SET ep.name = $name, ep.description = $description
                """
                session.run(query, tenant_id=self.tenant_id, number=b_ep.number, name=b_ep.name, description=b_ep.description)

            # 2. Upsert Nodes (Topics, Concepts, Tech, People, Links)
            # Topics
            for topic in extraction.topics:
                query = """
                MATCH (ep:Episode {tenant_id: $tenant_id, number: $ep_num})
                MERGE (t:Topic {tenant_id: $tenant_id, name: $name})
                ON CREATE SET t.description = $description
                MERGE (ep)-[:HAS_TOPIC]->(t)
                MERGE (t)-[:COVERED_BY_EPISODE]->(ep)
                """
                session.run(query, tenant_id=self.tenant_id, ep_num=ep.number, name=topic.name, description=topic.description)

            # Concepts (Independent nodes; linkage handled by relationships)
            for concept in extraction.concepts:
                query = "MERGE (c:Concept {tenant_id: $tenant_id, name: $name}) ON CREATE SET c.description = $description"
                session.run(query, tenant_id=self.tenant_id, name=concept.name, description=concept.description)

            # Technologies (Independent nodes; linkage handled by relationships)
            for tech in extraction.technologies:
                query = "MERGE (t:Technology {tenant_id: $tenant_id, name: $name}) ON CREATE SET t.description = $description"
                session.run(query, tenant_id=self.tenant_id, name=tech.name, description=tech.description)

            # People
            for person in extraction.people:
                query = """
                MATCH (ep:Episode {tenant_id: $tenant_id, number: $ep_num})
                MERGE (p:Person {tenant_id: $tenant_id, name: $name})
                WITH ep, p
                CALL apoc.do.when(
                    coalesce($role, "") = "Guest",
                    'MERGE (p)-[:GUEST_ON]->(ep)',
                    'MERGE (p)-[:MENTIONED]->(ep)',
                    {p:p, ep:ep}
                ) YIELD value
                RETURN count(*)
                """
                session.run(query, tenant_id=self.tenant_id, ep_num=ep.number, name=person.name, role=person.role)

            # ReferenceLinks
            for link in extraction.links:
                query = """
                MATCH (ep:Episode {tenant_id: $tenant_id, number: $ep_num})
                MERGE (l:ReferenceLink {tenant_id: $tenant_id, url: $url})
                ON CREATE SET l.text = $text
                MERGE (ep)-[:HAS_REFERENCE]->(l)
                """
                session.run(query, tenant_id=self.tenant_id, ep_num=ep.number, url=link.url, text=link.text)

            # 3. Dynamic Relationship Linking
            for rel in extraction.relationships:
                # We use a generic merge for relationships between entities
                # This requires finding the nodes by name first
                # We assume nodes are either Topic, Concept, Technology, or Person
                query = f"""
                MATCH (s {{tenant_id: $tenant_id}}) WHERE (s:Person OR s:Topic OR s:Concept OR s:Technology OR s:Episode OR s:Podcast) AND (s.name = $src OR s.title = $src)
                MATCH (t {{tenant_id: $tenant_id}}) WHERE (t:Person OR t:Topic OR t:Concept OR t:Technology OR t:Episode OR t:Podcast) AND (t.name = $target OR t.title = $target)
                MERGE (s)-[r:{rel.relationship_type.name}]->(t)
                """
                session.run(query, tenant_id=self.tenant_id, src=rel.source_node, target=rel.target_node)

    def _upsert_metadata_relationships(self, ep, podcast_title: str, invoked_by: str):
        """
        Implicitly maps the Podcast parent edge and connects the invoking User 
        (listener) to the Episode using structural audience relationships.
        """
        print(f"Injecting metadata contexts for Episode {ep.number}...")
        with self.driver.session() as session:
            # Connect Podcast -> Episode
            if podcast_title:
                query = """
                MATCH (ep:Episode {tenant_id: $tenant_id, number: $ep_num})
                MERGE (pod:Podcast {tenant_id: $tenant_id, title: $title})
                ON CREATE SET pod.id = $title
                MERGE (pod)-[:HAS_EPISODE]->(ep)
                """
                session.run(query, tenant_id=self.tenant_id, ep_num=ep.number, title=podcast_title)
            
            # Connect Invoking Person -> Podcast & Episode
            if invoked_by:
                query = """
                MATCH (ep:Episode {tenant_id: $tenant_id, number: $ep_num})
                MERGE (person:Person {tenant_id: $tenant_id, name: $invoker})
                ON CREATE SET person.role = 'Listener'
                MERGE (person)-[:LISTENS_TO_EPISODE]->(ep)
                MERGE (person)-[:LEARNING_FROM]->(ep)
                WITH ep, person
                OPTIONAL MATCH (pod:Podcast)-[:HAS_EPISODE]->(ep)
                FOREACH (p IN CASE WHEN pod IS NOT NULL THEN [pod] ELSE [] END |
                    MERGE (person)-[:LISTENS_TO]->(p)
                    MERGE (person)-[:SUBSCRIBES_TO]->(p)
                )
                """
                session.run(query, tenant_id=self.tenant_id, ep_num=ep.number, invoker=invoked_by)

    def _trigger_enrichment(self, ep):
        # Placeholder for legacy steps 7-10 (GDS projections, KNN scoring)
        print(f"Triggering GDS enrichment for tenant {self.tenant_id}...")
        pass
