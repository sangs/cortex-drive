import hashlib
import os
import sys
from typing import List, Optional

import trafilatura
from neo4j import GraphDatabase

from .base import BaseAdapter

sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from ingestion_engine import IngestionEngine


class WebUrlAdapter(BaseAdapter):
    """Adapter for ingesting a single registered web URL (Phase A — unauthenticated,
    single-page sources only; Phase A.5 extends this with auth).
    See documents/architecture/phase-a-web-url-adapter-design-2026-08-19.md.

    Unlike LocalFileAdapter (which scans a directory for many unprocessed files), one
    WebUrlAdapter instance represents ONE registered URL — get_unprocessed_items()
    returns either [url] (first ingestion, or content changed since last fetch) or []
    (unchanged, skip re-ingestion — the Iceberg-style freshness layer)."""

    def __init__(self, url: str, uri: str, user: str, password: str, tenant_id: str, owner_id: str):
        self.url = url
        self.tenant_id = tenant_id
        self.owner_id = owner_id
        self.driver = GraphDatabase.driver(uri, auth=(user, password))
        self._last_fetch_content: Optional[str] = None
        self._last_fetch_hash: Optional[str] = None

    def __del__(self):
        self.driver.close()

    def fetch(self, source_ref: str) -> str:
        """Fetch and extract clean content from a URL via trafilatura. Caches the result
        on self so a has_changed() call immediately followed by process_item() within the
        same adapter instance doesn't re-fetch over the network."""
        downloaded = trafilatura.fetch_url(source_ref)
        if downloaded is None:
            raise RuntimeError(f"Failed to fetch URL: {source_ref}")
        extracted = trafilatura.extract(
            downloaded, include_comments=False, include_tables=True, favor_recall=True
        )
        if not extracted:
            raise RuntimeError(f"trafilatura could not extract readable content from: {source_ref}")
        self._last_fetch_content = extracted
        self._last_fetch_hash = hashlib.sha256(extracted.encode("utf-8")).hexdigest()
        return extracted

    def has_changed(self, source_ref: str, last_known_hash: Optional[str]) -> bool:
        """True if source_ref's current content hash differs from last_known_hash, or if
        last_known_hash is None (never fetched before)."""
        self.fetch(source_ref)  # populates self._last_fetch_hash
        return last_known_hash is None or self._last_fetch_hash != last_known_hash

    def _get_current_snapshot_hash(self) -> Optional[str]:
        """Reads the content_hash of the current SourceSnapshot for this URL, if a
        WebsiteSource is already registered for it. None if not yet registered."""
        query = """
        MATCH (s:WebsiteSource {tenant_id: $tenant_id, base_url: $url})
              -[:HAS_SNAPSHOT]->(snap:SourceSnapshot {is_current: true})
        RETURN snap.content_hash AS content_hash
        LIMIT 1
        """
        with self.driver.session() as session:
            record = session.run(query, tenant_id=self.tenant_id, url=self.url).single()
            return record["content_hash"] if record else None

    def get_unprocessed_items(self) -> List[str]:
        current_hash = self._get_current_snapshot_hash()
        if self.has_changed(self.url, current_hash):
            return [self.url]
        return []

    def process_item(self, item: str, engine: IngestionEngine):
        """Extracts and writes a WebsiteSource + SourceSnapshot for the fetched URL.
        Reuses self._last_fetch_content populated by the has_changed() call in
        get_unprocessed_items() — no redundant fetch in the common path."""
        content = self._last_fetch_content or self.fetch(item)
        content_hash = self._last_fetch_hash
        print(f"WebUrlAdapter passing '{item}' to IngestionEngine (hash={content_hash[:12]}...)")
        engine.process_web_source(
            url=item,
            content=content,
            content_hash=content_hash,
            owner_id=self.owner_id,
        )
