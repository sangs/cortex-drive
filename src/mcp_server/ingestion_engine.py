import asyncio
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

        # 2. Upsert Episode Node — returns stable node_id
        ep_node_id = self._upsert_episode(validated_ep)

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

        # 6. Atomic Upsert of Source, Chunks & Entities — returns new node_ids
        graph_node_ids = self._upsert_graph_data(validated_ep, validated_source, chunks, entities)

        # 6. Metadata Context Injection (Listener & Podcast Hierarchy)
        podcast_title = episode_metadata.get('podcast_title')
        invoked_by = episode_metadata.get('invoked_by')
        meta_node_ids = []
        if podcast_title or invoked_by:
            meta_node_ids = self._upsert_metadata_relationships(validated_ep, podcast_title, invoked_by)

        # 7. Post-Processing Enrichment (GDS, KNN, etc.)
        self._trigger_enrichment(validated_ep)

        # 8. Register all new nodes in Permify (owner + tenant_viewer + parent tuples + privacy attrs)
        all_node_ids = [ep_node_id] + graph_node_ids + meta_node_ids
        self._register_with_openfga([nid for nid in all_node_ids if nid])

        print(f"Ingestion complete for Episode {validated_ep.number}.")

    def _upsert_episode(self, ep_node) -> str | None:
        """Upsert episode node, setting node_id on creation. Returns the node_id."""
        query = """
        MERGE (ep:Episode {tenant_id: $tenant_id, number: $number})
        ON CREATE SET ep.node_id = randomUUID()
        SET ep += $props
        RETURN ep.node_id AS node_id
        """
        props = ep_node.dict()
        # Neo4j cannot store dictionaries in properties; serialize the metadata generic store
        if 'metadata' in props and isinstance(props['metadata'], dict):
            props['metadata'] = json.dumps(props['metadata'])

        with self.driver.session() as session:
            result = session.run(query, tenant_id=self.tenant_id, number=ep_node.number, props=props)
            record = result.single()
            return record["node_id"] if record else None

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

    def _upsert_graph_data(self, ep, source, chunks, extraction) -> list[str | None]:
        """Upsert source, chunks, and entities. Returns list of node_ids created."""
        node_ids: list[str | None] = []

        with self.driver.session() as session:
            # 1. Upsert Source Node
            query_source = """
            MATCH (ep:Episode {tenant_id: $tenant_id, number: $ep_num})
            MERGE (s:Source {tenant_id: $tenant_id, fileName: $fileName})
            ON CREATE SET s.node_id = randomUUID(), s.type = $type, s.fileSource = $fileSource, s.ingestedAt = $ingestedAt
            MERGE (ep)-[:HAS_SOURCE]->(s)
            RETURN s.node_id AS node_id
            """
            result = session.run(query_source,
                tenant_id=self.tenant_id, ep_num=ep.number,
                fileName=source.fileName, type=source.type,
                fileSource=source.fileSource, ingestedAt=source.ingestedAt
            )
            record = result.single()
            node_ids.append(record["node_id"] if record else None)

            # 2. Upsert Chunks
            for chunk in chunks:
                query_chunk = """
                MATCH (s:Source {tenant_id: $tenant_id, fileName: $fileName})
                MERGE (c:Chunk {tenant_id: $tenant_id, order: $order, embedding: $embedding})
                ON CREATE SET c.node_id = randomUUID()
                SET c.text = $text, c.startTime = $startTime, c.endTime = $endTime
                MERGE (s)-[:CONTAINS]->(c)
                MERGE (c)-[:BELONGS_TO_SOURCE]->(s)
                RETURN c.node_id AS node_id
                """
                result = session.run(query_chunk,
                    tenant_id=self.tenant_id,
                    fileName=source.fileName,
                    order=chunk.order,
                    text=chunk.text,
                    embedding=chunk.embedding,
                    startTime=chunk.startTime,
                    endTime=chunk.endTime
                )
                record = result.single()
                node_ids.append(record["node_id"] if record else None)

            # 3. Upsert BAML Extractions
            entity_ids = self._upsert_baml_entities(ep, extraction)
            node_ids.extend(entity_ids)

        return node_ids

    def _upsert_baml_entities(self, ep, extraction) -> list[str | None]:
        """
        Surgically upsert BAML-extracted entities and link them to the episode.
        Returns list of node_ids for newly created nodes.
        """
        node_ids: list[str | None] = []

        with self.driver.session() as session:
            # 1. Upsert Podcasts and Episodes (if any metadata was extracted/clarified)
            for podcast in extraction.podcasts:
                query = """
                MERGE (p:Podcast {tenant_id: $tenant_id, title: $title})
                ON CREATE SET p.node_id = randomUUID()
                RETURN p.node_id AS node_id
                """
                result = session.run(query, tenant_id=self.tenant_id, title=podcast.title)
                record = result.single()
                node_ids.append(record["node_id"] if record else None)

            for b_ep in extraction.episodes:
                query = """
                MERGE (ep:Episode {tenant_id: $tenant_id, number: $number})
                ON CREATE SET ep.node_id = randomUUID(), ep.name = $name, ep.description = $description
                RETURN ep.node_id AS node_id
                """
                result = session.run(query, tenant_id=self.tenant_id, number=b_ep.number, name=b_ep.name, description=b_ep.description)
                record = result.single()
                node_ids.append(record["node_id"] if record else None)

            # 2. Upsert Nodes (Topics, Concepts, Tech, People, Links)
            # Topics
            for topic in extraction.topics:
                query = """
                MATCH (ep:Episode {tenant_id: $tenant_id, number: $ep_num})
                MERGE (t:Topic {tenant_id: $tenant_id, name: $name})
                ON CREATE SET t.node_id = randomUUID(), t.description = $description
                MERGE (ep)-[:HAS_TOPIC]->(t)
                MERGE (t)-[:COVERED_BY_EPISODE]->(ep)
                RETURN t.node_id AS node_id
                """
                result = session.run(query, tenant_id=self.tenant_id, ep_num=ep.number, name=topic.name, description=topic.description)
                record = result.single()
                node_ids.append(record["node_id"] if record else None)

            # Concepts (Independent nodes; linkage handled by relationships)
            for concept in extraction.concepts:
                query = """
                MERGE (c:Concept {tenant_id: $tenant_id, name: $name})
                ON CREATE SET c.node_id = randomUUID(), c.description = $description
                RETURN c.node_id AS node_id
                """
                result = session.run(query, tenant_id=self.tenant_id, name=concept.name, description=concept.description)
                record = result.single()
                node_ids.append(record["node_id"] if record else None)

            # Technologies (Independent nodes; linkage handled by relationships)
            for tech in extraction.technologies:
                query = """
                MERGE (t:Technology {tenant_id: $tenant_id, name: $name})
                ON CREATE SET t.node_id = randomUUID(), t.description = $description
                RETURN t.node_id AS node_id
                """
                result = session.run(query, tenant_id=self.tenant_id, name=tech.name, description=tech.description)
                record = result.single()
                node_ids.append(record["node_id"] if record else None)

            # People
            for person in extraction.people:
                query = """
                MATCH (ep:Episode {tenant_id: $tenant_id, number: $ep_num})
                MERGE (p:Person {tenant_id: $tenant_id, name: $name})
                ON CREATE SET p.node_id = randomUUID()
                WITH ep, p
                CALL apoc.do.when(
                    coalesce($role, "") = "Guest",
                    'MERGE (p)-[:GUEST_ON]->(ep)',
                    'MERGE (p)-[:MENTIONED]->(ep)',
                    {p:p, ep:ep}
                ) YIELD value
                RETURN p.node_id AS node_id
                """
                result = session.run(query, tenant_id=self.tenant_id, ep_num=ep.number, name=person.name, role=person.role)
                record = result.single()
                node_ids.append(record["node_id"] if record else None)

            # ReferenceLinks
            for link in extraction.links:
                query = """
                MATCH (ep:Episode {tenant_id: $tenant_id, number: $ep_num})
                MERGE (l:ReferenceLink {tenant_id: $tenant_id, url: $url})
                ON CREATE SET l.node_id = randomUUID(), l.text = $text
                MERGE (ep)-[:HAS_REFERENCE]->(l)
                RETURN l.node_id AS node_id
                """
                result = session.run(query, tenant_id=self.tenant_id, ep_num=ep.number, url=link.url, text=link.text)
                record = result.single()
                node_ids.append(record["node_id"] if record else None)

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

        return node_ids

    def _upsert_metadata_relationships(self, ep, podcast_title: str, invoked_by: str) -> list[str | None]:
        """
        Implicitly maps the Podcast parent edge and connects the invoking User
        (listener) to the Episode using structural audience relationships.
        Returns node_ids for any newly created nodes.
        """
        print(f"Injecting metadata contexts for Episode {ep.number}...")
        node_ids: list[str | None] = []

        with self.driver.session() as session:
            # Connect Podcast -> Episode
            if podcast_title:
                query = """
                MATCH (ep:Episode {tenant_id: $tenant_id, number: $ep_num})
                MERGE (pod:Podcast {tenant_id: $tenant_id, title: $title})
                ON CREATE SET pod.node_id = randomUUID(), pod.id = $title
                MERGE (pod)-[:HAS_EPISODE]->(ep)
                RETURN pod.node_id AS node_id
                """
                result = session.run(query, tenant_id=self.tenant_id, ep_num=ep.number, title=podcast_title)
                record = result.single()
                node_ids.append(record["node_id"] if record else None)

            # Connect Invoking Person -> Podcast & Episode
            if invoked_by:
                query = """
                MATCH (ep:Episode {tenant_id: $tenant_id, number: $ep_num})
                MERGE (person:Person {tenant_id: $tenant_id, name: $invoker})
                ON CREATE SET person.node_id = randomUUID(), person.role = 'Listener'
                MERGE (person)-[:LISTENS_TO_EPISODE]->(ep)
                MERGE (person)-[:LEARNING_FROM]->(ep)
                WITH ep, person
                OPTIONAL MATCH (pod:Podcast)-[:HAS_EPISODE]->(ep)
                FOREACH (p IN CASE WHEN pod IS NOT NULL THEN [pod] ELSE [] END |
                    MERGE (person)-[:LISTENS_TO]->(p)
                    MERGE (person)-[:SUBSCRIBES_TO]->(p)
                )
                RETURN person.node_id AS node_id
                """
                result = session.run(query, tenant_id=self.tenant_id, ep_num=ep.number, invoker=invoked_by)
                record = result.single()
                node_ids.append(record["node_id"] if record else None)

        return node_ids

    def _register_with_openfga(self, node_ids: list[str]) -> None:
        """Register newly ingested nodes in Permify. Idempotent — existing tuples are no-ops.

        Writes per node: owner + tenant_viewer tuples.
        Writes per composition edge: parent tuple (child.parent = parent_node).
        Writes per PreparatoryNote: is_private=true attribute.
        """
        if not os.environ.get("PERMIFY_API_URL"):
            return
        owner_sub = os.environ.get("OWNER_USER_ID", "")
        if not owner_sub:
            print("[ingestion] OWNER_USER_ID not set — skipping Permify registration")
            return

        import sys
        sys.path.insert(0, os.path.dirname(__file__))
        from permify_utils import register_node_owner, make_tenant_wide, write_parent_tuple, write_privacy_attribute
        from schema_guard import COMPOSITION_RELATIONSHIPS

        # Fetch node labels and composition edges for the new node_ids
        node_labels, composition_edges, private_node_ids = self._fetch_node_metadata(node_ids)

        async def _register_all():
            for nid in node_ids:
                await register_node_owner(nid, owner_sub)
                await make_tenant_wide(nid, self.tenant_id)
            for parent_id, child_id in composition_edges:
                await write_parent_tuple(child_node_id=child_id, parent_node_id=parent_id)
            for nid in private_node_ids:
                await write_privacy_attribute(node_id=nid, is_private=True)

        try:
            asyncio.run(_register_all())
            print(f"[ingestion] Registered {len(node_ids)} node(s), "
                  f"{len(composition_edges)} parent tuple(s), "
                  f"{len(private_node_ids)} privacy attribute(s) in Permify.")
        except RuntimeError as e:
            print(f"[ingestion] Permify registration skipped — event loop conflict: {e}")
            return

        try:
            import redis as redis_lib
            _r = redis_lib.Redis.from_url(
                os.environ.get("REDIS_URL", "redis://localhost:6379"),
                decode_responses=True,
                socket_connect_timeout=1,
                socket_timeout=1,
            )
            _r.incr(f"perm_version:{self.tenant_id}")
            print(f"[ingestion] Incremented perm_version for tenant {self.tenant_id}.")
        except Exception as e:
            print(f"[ingestion] perm_version increment failed (non-fatal): {e}")

    def _fetch_node_metadata(
        self, node_ids: list[str]
    ) -> tuple[dict[str, list[str]], list[tuple[str, str]], list[str]]:
        """Query Neo4j for labels, composition edges, and private nodes among new node_ids.

        Returns:
          node_labels: {node_id: [label, ...]}
          composition_edges: [(parent_id, child_id), ...]  — edges to write as parent tuples
          private_node_ids: [node_id, ...]  — PreparatoryNote nodes needing is_private=true
        """
        from schema_guard import COMPOSITION_RELATIONSHIPS
        ids = [nid for nid in node_ids if nid]
        if not ids:
            return {}, [], []

        rel_pattern = "|".join(COMPOSITION_RELATIONSHIPS)
        query = f"""
            UNWIND $ids AS nid
            MATCH (n {{node_id: nid}})
            OPTIONAL MATCH (n)-[r:{rel_pattern}]->(child)
            WHERE child.node_id IS NOT NULL
              AND NOT child.tenant_id IN ['SYSTEM', 'PUBLIC']
            RETURN n.node_id AS node_id, labels(n) AS node_labels,
                   child.node_id AS child_id
        """
        node_labels: dict[str, list[str]] = {}
        composition_edges: list[tuple[str, str]] = []
        private_node_ids: list[str] = []

        with self.driver.session() as session:
            for rec in session.run(query, ids=ids):
                nid = rec["node_id"]
                lbls = rec["node_labels"] or []
                node_labels[nid] = lbls
                if "PreparatoryNote" in lbls:
                    private_node_ids.append(nid)
                if rec["child_id"]:
                    composition_edges.append((nid, rec["child_id"]))

        return node_labels, composition_edges, private_node_ids

    def _trigger_enrichment(self, ep):
        # Placeholder for legacy steps 7-10 (GDS projections, KNN scoring)
        print(f"Triggering GDS enrichment for tenant {self.tenant_id}...")
        pass

    def process_web_source(self, url: str, content: str, content_hash: str, owner_id: str):
        """
        Main entry point for processing a single web-URL source (Phase A —
        documents/architecture/phase-a-web-url-adapter-design-2026-08-19.md).

        Called by WebUrlAdapter.process_item() only when has_changed() already
        determined this content differs from the current snapshot (or is a first-time
        fetch) — this method always creates a new snapshot, it does not re-check the
        hash itself. Mirrors process_transcript()'s shape (extract -> validate -> write
        -> register in Permify), applied to a WebsiteSource anchor instead of an Episode.
        """
        print(f"Starting web-source ingestion for {url}...")

        # 1. LLM extraction (title, description, entities, relationships)
        extraction = b.ExtractWebPage(content=content, url=url)

        # 2. Schema Validation for WebsiteSource
        source_data = {
            'tenant_id': self.tenant_id,
            'owner_id': owner_id,
            'source_type': 'website',
            'name': extraction.title,
            'description': extraction.description,
            'uri': url,
            'base_url': url,
            'requires_auth': False,
            'extraction_method': 'trafilatura',
        }
        validated_source = validate_upsert('WebsiteSource', source_data)

        # 3. Upsert WebsiteSource + create new SourceSnapshot (flip old is_current)
        source_node_id = self._upsert_website_source(validated_source, url, content_hash)

        # 4. Upsert extracted entities + relationships, linked to the WebsiteSource
        entity_ids = self._upsert_web_entities(source_node_id, extraction)

        # 5. Register in Permify
        all_node_ids = [source_node_id] + entity_ids
        self._register_with_openfga([nid for nid in all_node_ids if nid])

        print(f"Web-source ingestion complete for {url}.")
        return source_node_id

    def _upsert_website_source(self, source, url: str, content_hash: str) -> str | None:
        """Upsert the WebsiteSource node (stable identity across snapshots — matched by
        tenant_id + base_url, node_id set only ON CREATE so it never changes across
        re-fetches), create a new SourceSnapshot, and flip any prior current snapshot to
        is_current=false. Returns the WebsiteSource's node_id."""
        props = source.dict()
        if 'metadata' in props and isinstance(props['metadata'], dict):
            props['metadata'] = json.dumps(props['metadata'])
        now = datetime.now().isoformat()

        query = """
        MERGE (s:WebsiteSource {tenant_id: $tenant_id, base_url: $base_url})
        ON CREATE SET s.node_id = randomUUID()
        SET s += $props,
            s.last_synced_at = $now

        WITH s
        OPTIONAL MATCH (s)-[:HAS_SNAPSHOT]->(old:SourceSnapshot {is_current: true})
        SET old.is_current = false

        WITH s
        CREATE (snap:SourceSnapshot {
            tenant_id: $tenant_id,
            content_hash: $content_hash,
            metadata_schema_version: $metadata_schema_version,
            fetched_at: $now,
            is_current: true
        })
        SET snap.node_id = randomUUID()
        MERGE (s)-[:HAS_SNAPSHOT]->(snap)
        SET s.current_snapshot_id = snap.node_id

        RETURN s.node_id AS node_id
        """
        with self.driver.session() as session:
            result = session.run(
                query,
                tenant_id=self.tenant_id,
                base_url=url,
                props=props,
                now=now,
                content_hash=content_hash,
                metadata_schema_version=source.metadata_schema_version,
            )
            record = result.single()
            return record["node_id"] if record else None

    def _upsert_web_entities(self, source_node_id: str, extraction) -> list[str | None]:
        """Upsert BAML-extracted Concept/Technology/Person/ReferenceLink entities and
        link them to the WebsiteSource node via DISCUSSES/COVERS_TECHNOLOGY/MENTIONS —
        the SAME node types the podcast pipeline already uses (shared ontology backbone,
        the mechanism cross-domain bridge discovery already traverses), just a different
        anchor and a Phase-A-scoped relationship set (WebRelationshipType) instead of the
        podcast-specific RelationshipType. Returns list of node_ids for newly created
        nodes."""
        node_ids: list[str | None] = []

        with self.driver.session() as session:
            # Concepts
            for concept in extraction.concepts:
                query = """
                MERGE (c:Concept {tenant_id: $tenant_id, name: $name})
                ON CREATE SET c.node_id = randomUUID(), c.description = $description
                RETURN c.node_id AS node_id
                """
                result = session.run(query, tenant_id=self.tenant_id, name=concept.name, description=concept.description)
                record = result.single()
                node_ids.append(record["node_id"] if record else None)

            # Technologies
            for tech in extraction.technologies:
                query = """
                MERGE (t:Technology {tenant_id: $tenant_id, name: $name})
                ON CREATE SET t.node_id = randomUUID()
                RETURN t.node_id AS node_id
                """
                result = session.run(query, tenant_id=self.tenant_id, name=tech.name)
                record = result.single()
                node_ids.append(record["node_id"] if record else None)

            # People
            for person in extraction.people:
                query = """
                MERGE (p:Person {tenant_id: $tenant_id, name: $name})
                ON CREATE SET p.node_id = randomUUID(), p.role = $role
                RETURN p.node_id AS node_id
                """
                result = session.run(query, tenant_id=self.tenant_id, name=person.name, role=person.role)
                record = result.single()
                node_ids.append(record["node_id"] if record else None)

            # ReferenceLinks
            for link in extraction.reference_links:
                query = """
                MATCH (s:WebsiteSource {tenant_id: $tenant_id, node_id: $source_node_id})
                MERGE (l:ReferenceLink {tenant_id: $tenant_id, url: $url})
                ON CREATE SET l.node_id = randomUUID(), l.text = $text
                MERGE (s)-[:HAS_REFERENCE]->(l)
                RETURN l.node_id AS node_id
                """
                result = session.run(query, tenant_id=self.tenant_id, source_node_id=source_node_id, url=link.url, text=link.text)
                record = result.single()
                node_ids.append(record["node_id"] if record else None)

            # Relationships (WebsiteSource -> Concept/Technology/Person)
            for rel in extraction.relationships:
                query = f"""
                MATCH (s:WebsiteSource {{tenant_id: $tenant_id, node_id: $source_node_id}})
                MATCH (t {{tenant_id: $tenant_id}}) WHERE (t:Concept OR t:Technology OR t:Person) AND t.name = $target
                MERGE (s)-[r:{rel.relationship_type.name}]->(t)
                """
                session.run(query, tenant_id=self.tenant_id, source_node_id=source_node_id, target=rel.target_node)

        return node_ids
