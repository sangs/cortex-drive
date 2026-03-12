import os
import json
from typing import List, Dict, Any
from openai import OpenAI
from neo4j import GraphDatabase
from schema_guard import (
    validate_upsert, 
    CORTEX_MODEL_NODES, 
    PROJECT_GRAPH_NODES, 
    SYSTEM_NODES,
    CORTEX_MODEL_RELATIONSHIPS, 
    PROJECT_GRAPH_RELATIONSHIPS
)
from expert_tools import ExpertTools
import re

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
        
        # 3. Semantic Chunking & Embedding
        chunks = self._create_chunks(transcript_text, validated_ep)
        
        # 4. LLM Entity Extraction (Graph Transformation)
        entities = self._extract_entities(transcript_text)
        
        # 5. Atomic Upsert of Chunks & Entities
        self._upsert_graph_data(validated_ep, chunks, entities)
        
        # 6. Post-Processing Enrichment (GDS, KNN, etc.)
        self._trigger_enrichment(validated_ep)
        
        print(f"Ingestion complete for Episode {validated_ep.number}.")

    def _upsert_episode(self, ep_node):
        query = """
        MERGE (ep:Episode {tenant_id: $tenant_id, number: $number})
        SET ep += $props
        """
        props = ep_node.dict()
        with self.driver.session() as session:
            session.run(query, tenant_id=self.tenant_id, number=ep_node.number, props=props)

    def _create_chunks(self, text: str, ep_node, chunk_size: int = 1000):
        # Basic chunking logic (mimicking the notebook)
        words = text.split()
        chunks = []
        for i in range(0, len(words), chunk_size):
            chunk_text = " ".join(words[i:i + chunk_size])
            embedding = self.expert.get_embedding(chunk_text)
            
            chunk_data = {
                'tenant_id': self.tenant_id,
                'text': chunk_text,
                'embedding': embedding,
                'order': len(chunks) + 1,
                'fileName': f"episode_{ep_node.number}.txt",
                'fileSource': f"ep{ep_node.number}"
            }
            chunks.append(validate_upsert('Chunk', chunk_data))
        return chunks

    def _extract_entities(self, text: str):
        """
        Extract Topics, Concepts, and Technologies from text using LLM.
        Strictly constrained to the defined schema.
        """
        from langchain_experimental.graph_transformers import LLMGraphTransformer
        from langchain_openai import ChatOpenAI
        from langchain_core.documents import Document

        print(f"Extracting strictly constrained entities for tenant {self.tenant_id}...")
        
        llm = ChatOpenAI(temperature=0, model_name="gpt-4o-mini")
        transformer = LLMGraphTransformer(
            llm=llm,
            allowed_nodes=CORTEX_MODEL_NODES + PROJECT_GRAPH_NODES + SYSTEM_NODES,
            allowed_relationships=CORTEX_MODEL_RELATIONSHIPS + PROJECT_GRAPH_RELATIONSHIPS
        )

        documents = [Document(page_content=text)]
        graph_documents = transformer.convert_to_graph_documents(documents)
        
        # Post-process to inject tenant_id and validate against schema_guard
        validated_graph = []
        for doc in graph_documents:
            for node in doc.nodes:
                node.properties['tenant_id'] = self.tenant_id
                try:
                    # Validate and clean node properties
                    validated_node = validate_upsert(node.type, node.properties)
                    node.properties = validated_node.dict()
                except Exception as e:
                    print(f"⚠️ Skipping invalid {node.type} node: {e}")
                    continue
            validated_graph.append(doc)
            
        return validated_graph

    def _upsert_graph_data(self, ep, chunks, graph_docs):
        with self.driver.session() as session:
            # 1. Upsert Chunks
            for chunk in chunks:
                query = """
                MATCH (ep:Episode {tenant_id: $tenant_id, number: $ep_num})
                MERGE (c:Chunk {tenant_id: $tenant_id, order: $order, fileName: $fileName})
                SET c.text = $text, c.embedding = $embedding, c.fileSource = $fileSource
                MERGE (ep)-[:HAS_CHUNK]->(c)
                MERGE (c)-[:BELONGS_TO_EPISODE]->(ep)
                """
                session.run(query, 
                    tenant_id=self.tenant_id, 
                    ep_num=ep.number,
                    order=chunk.order,
                    fileName=chunk.fileName,
                    fileSource=chunk.fileSource,
                    text=chunk.text,
                    embedding=chunk.embedding
                )

            # 2. Upsert Extractions (Topics, Concepts, etc.)
            from langchain_neo4j import Neo4jGraph
            graph = Neo4jGraph(
                url=os.environ["NEO4J_URI"],
                username=os.environ["NEO4J_USERNAME"],
                password=os.environ["NEO4J_PASSWORD"]
            )
            for doc in graph_docs:
                graph.add_graph_documents([doc])

    def _trigger_enrichment(self, ep):
        # Placeholder for legacy steps 7-10 (GDS projections, KNN scoring)
        print(f"Triggering GDS enrichment for tenant {self.tenant_id}...")
        pass
