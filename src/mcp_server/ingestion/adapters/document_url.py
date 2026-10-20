"""Phase B M3' — a document (PDF/DOCX/PPTX) at a public URL.
See documents/architecture/phase-b-document-ingestion-build-plan-2026-10-01.md (M3') and
federated-retrieval-and-freshness-design-2026-09-29.md §1.3.4 (has_changed: ETag/Last-Modified,
then content hash) and §1.3.7 (the parser takes bytes, never a URL).

Runs only in the ingestion worker (decision P4: no Docling in cortex-mcp). cortex-mcp never imports
this module; it validates URLs with validate_public_url from web_url.py before enqueueing.

SSRF: every fetch goes through ingestion/safe_fetch.py (guard re-validated on every redirect hop,
size cap; DNS rebinding is an accepted residual risk, tracker S2-28).
"""
import hashlib
import io
import os
import sys
import zipfile
from dataclasses import dataclass
from typing import Any, List, Optional
from urllib.parse import urlparse

import httpx
from neo4j import GraphDatabase

from .base import BaseAdapter

sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from ingestion.safe_fetch import SafeFetchError, safe_get  # noqa: E402
from parsing.structure_parser import MIME_DOCX, MIME_PDF, MIME_PPTX  # noqa: E402
from schema_guard import (  # noqa: E402
    DOCUMENT_FETCH_MAX_BYTES, DOCUMENT_FETCH_MAX_REDIRECTS, DOCUMENT_FETCH_TIMEOUT_SECONDS,
    DOCUMENT_FETCH_USER_AGENT,
)

SUPPORTED_DOCUMENT_MIME_TYPES = (MIME_PDF, MIME_DOCX, MIME_PPTX)
# OOXML packages are zip files; the part that identifies each format.
OOXML_MARKER_PARTS = {MIME_DOCX: 'word/document.xml', MIME_PPTX: 'ppt/presentation.xml'}


class DocumentFetchError(ValueError):
    """The URL can't be ingested: unsafe, unreachable, too large, or not a supported document."""


@dataclass
class FetchedDocument:
    data: Optional[bytes]            # None when the server answered 304 Not Modified
    final_url: str
    mime_type: Optional[str]
    content_hash: Optional[str]
    etag: Optional[str]
    last_modified: Optional[str]
    filename: Optional[str]

    @property
    def not_modified(self) -> bool:
        return self.data is None


def detect_document_mime_type(data: bytes) -> Optional[str]:
    """MIME type from the bytes themselves (never from the server's Content-Type alone)."""
    if data[:5] == b'%PDF-':
        return MIME_PDF
    if data[:4] == b'PK\x03\x04':
        try:
            names = set(zipfile.ZipFile(io.BytesIO(data)).namelist())
        except zipfile.BadZipFile:
            return None
        for mime, part in OOXML_MARKER_PARTS.items():
            if part in names:
                return mime
    return None


def fetch_public_document(url: str, *, etag: Optional[str] = None, last_modified: Optional[str] = None,
                          transport: Optional[httpx.BaseTransport] = None) -> FetchedDocument:
    """GET a public document through the shared SSRF-safe fetcher (ingestion/safe_fetch.py: guard on
    every hop, size cap), with a conditional request when ETag/Last-Modified are known (304 → not
    modified, nothing downloaded). Accepts only PDF/DOCX/PPTX, detected from the bytes.
    `transport` is for tests only (httpx.MockTransport)."""
    headers = {'User-Agent': DOCUMENT_FETCH_USER_AGENT}
    if etag:
        headers['If-None-Match'] = etag
    if last_modified:
        headers['If-Modified-Since'] = last_modified
    try:
        resp = safe_get(url, max_bytes=DOCUMENT_FETCH_MAX_BYTES, max_redirects=DOCUMENT_FETCH_MAX_REDIRECTS,
                        timeout=DOCUMENT_FETCH_TIMEOUT_SECONDS, headers=headers, transport=transport)
    except SafeFetchError as e:
        raise DocumentFetchError(str(e)) from e
    if resp.status == 304:
        return FetchedDocument(None, resp.final_url, None, None, etag, last_modified, None)
    if resp.status != 200:
        raise DocumentFetchError(f"Fetching {resp.final_url} returned HTTP {resp.status}")
    mime = detect_document_mime_type(resp.data)
    if mime not in SUPPORTED_DOCUMENT_MIME_TYPES:
        raise DocumentFetchError("Not a supported document (PDF, DOCX or PPTX) — got "
                                 f"{resp.headers.get('content-type', 'unknown content type')}")
    return FetchedDocument(
        data=resp.data, final_url=resp.final_url, mime_type=mime,
        content_hash=hashlib.sha256(resp.data).hexdigest(),
        etag=resp.headers.get('etag'), last_modified=resp.headers.get('last-modified'),
        filename=os.path.basename(urlparse(resp.final_url).path) or None,
    )


def title_hint_from(parsed) -> Optional[str]:
    """The document's own title for L3 (BAML echoes the hint it is given, so a URL file name like
    "1810.04805" would become the source's name): the parser's title element, else the first
    heading on page 1."""
    from parsing.docling_parser import TITLE_HEADING_LEVEL
    headings = [e for e in parsed.elements if e.type == 'heading' and e.text and e.text.strip()]
    for e in headings:
        if e.heading_level == TITLE_HEADING_LEVEL:
            return e.text.strip()
    first_page = [e for e in headings if e.page in (None, 1)]
    return first_page[0].text.strip() if first_page else None


class DocumentUrlAdapter(BaseAdapter):
    """One registered document URL (P3). get_unprocessed_items() returns [url] when the document
    is new or changed and [] when unchanged: a 304 to the conditional request, or the same content
    hash as the current SourceSnapshot (§1.3.4). The fetched bytes are kept on the instance, so
    process_item() never downloads twice."""

    def __init__(self, url: str, uri: str, user: str, password: str, tenant_id: str, owner_id: str,
                 parser=None, transport: Optional[httpx.BaseTransport] = None):
        self.url = url
        self.tenant_id = tenant_id
        self.owner_id = owner_id
        self.driver = GraphDatabase.driver(uri, auth=(user, password))
        self.parser = parser
        self._transport = transport
        self.last_fetch: Optional[FetchedDocument] = None

    def close(self) -> None:
        self.driver.close()

    def _known_state(self) -> dict:
        with self.driver.session() as session:
            rec = session.run(
                """MATCH (d:DocumentSource {tenant_id: $tenant_id, uri: $uri})
                   OPTIONAL MATCH (d)-[:HAS_SNAPSHOT]->(s:SourceSnapshot {is_current: true})
                   RETURN d.http_etag AS etag, d.http_last_modified AS last_modified, s.content_hash AS hash""",
                tenant_id=self.tenant_id, uri=self.url).single()
        return dict(rec) if rec else {}

    def fetch(self, source_ref: str) -> str:
        """Binary-source variant of BaseAdapter.fetch(): downloads the document (unconditionally),
        keeps the bytes on self.last_fetch, and returns the content hash."""
        self.last_fetch = fetch_public_document(source_ref, transport=self._transport)
        return self.last_fetch.content_hash

    def has_changed(self, source_ref: str, last_known_hash: Optional[str]) -> bool:
        known = self._known_state()
        self.last_fetch = fetch_public_document(source_ref, etag=known.get('etag'),
                                                last_modified=known.get('last_modified'),
                                                transport=self._transport)
        if self.last_fetch.not_modified:
            return False
        reference_hash = last_known_hash if last_known_hash is not None else known.get('hash')
        changed = reference_hash is None or self.last_fetch.content_hash != reference_hash
        if not changed and (self.last_fetch.etag, self.last_fetch.last_modified) != (known.get('etag'), known.get('last_modified')):
            self._refresh_validators()
        return changed

    def _refresh_validators(self) -> None:
        """Same content, new ETag/Last-Modified (e.g. the server re-generated its ETag): store them so
        the next check can be answered with a 304 instead of another full download."""
        with self.driver.session() as session:
            session.run(
                """MATCH (d:DocumentSource {tenant_id: $tenant_id, uri: $uri})
                   SET d.http_etag = $etag, d.http_last_modified = $last_modified""",
                tenant_id=self.tenant_id, uri=self.url,
                etag=self.last_fetch.etag, last_modified=self.last_fetch.last_modified)

    def get_unprocessed_items(self) -> List[Any]:
        return [self.url] if self.has_changed(self.url, None) else []

    def process_item(self, item: Any, engine) -> dict:
        """Parse the fetched bytes (L1) and write the revision (L3 + graph). Requires a parser."""
        if self.last_fetch is None or self.last_fetch.not_modified or self.last_fetch.data is None:
            self.fetch(item)
        doc = self.last_fetch
        parsed = self.parser.parse(doc.data, doc.mime_type, doc.filename or "document")
        result = engine.process_document_source(
            uri=self.url, parsed=parsed, mime_type=doc.mime_type, content_hash=doc.content_hash,
            owner_id=self.owner_id, filename=doc.filename, title_hint=title_hint_from(parsed),
            http_etag=doc.etag, http_last_modified=doc.last_modified)
        result['parsed'] = parsed
        return result
