"""
Phase B M5 step 9: document query end to end on the TEST TENANT (real Neo4j, Docling, OpenAI).

Ingests two small documents through the real worker (worker.ingest_document.run; download served by
httpx.MockTransport at an IP-literal URL so the SSRF guard passes without DNS; figure descriptions off,
so no Claude call), then checks the M5 read path against what was written:
  - search_document_blocks: passages with citations — PDF cite_url carries #page=N, DOCX uses the bare
    uri; pages within the document; only the current revision; per-document cap;
  - visibility by role: owner sees the passages; an invited user (strict allowlist, nothing shared) and a
    guest link see none;
  - the document graph view: DocumentSource anchor, no ContentBlocks;
  - the visibility chosen at ingestion is stored on the DocumentSource; sections exist for registration.
Writes ONLY under the test tenant and deletes everything afterwards (no Permify tuples: test-tenant rule).
Paid: two GPT-4o extractions + embeddings + a few query embeddings (a few cents).

    .venv/bin/python -m unittest tests.ingestion.test_document_query -v
"""
import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

from tests.test_tenant import TEST_TENANT_ID, use_test_tenant, cleanup_test_tenant, count_test_tenant_nodes  # noqa: E402
use_test_tenant()

from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(ROOT, ".env"))
use_test_tenant()

import httpx  # noqa: E402

DOCS_DIR = os.path.join(ROOT, "documents", "eval", "parser-eval-2026-09-30", "source_docs")
PDF = os.path.join(DOCS_DIR, "11_bert_pages_3_6_7.pdf")
DOCX = os.path.join(DOCS_DIR, "08_gradle.docx")
PDF_URL = "https://8.8.8.8/m5/bert-pages.pdf"        # never contacted: served by MockTransport
DOCX_URL = "https://8.8.8.8/m5/gradle-guide.docx"
DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
OWNER = "user_owner_m5_test"


class FakeRedis:
    def __init__(self):
        self.store = {}

    def setex(self, key, ttl, value):
        self.store[key] = value

    def get(self, key):
        return self.store.get(key)

    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    def expire(self, key, ttl):
        return key in self.store

    def eval(self, script, numkeys, key, token):
        if self.store.get(key) == token:
            del self.store[key]
            return 1
        return 0


def serve(files):
    def handler(request):
        data, ctype = files[str(request.url)]
        return httpx.Response(200, content=data, headers={"content-type": ctype, "etag": '"m5-v1"'})
    return httpx.MockTransport(handler)


@unittest.skipUnless(os.path.exists(PDF) and os.path.exists(DOCX) and os.environ.get("NEO4J_URI") and os.environ.get("OPENAI_API_KEY"),
                     "needs the parser-eval documents, Neo4j and OpenAI credentials")
@mock.patch.dict(os.environ, {"OWNER_USER_ID": OWNER})
class DocumentQueryTest(unittest.TestCase):
    driver = None

    @classmethod
    def setUpClass(cls):
        from neo4j import GraphDatabase
        from parsing.docling_parser import DoclingParser
        from worker.ingest_document import run
        cls.driver = GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"]))
        cleanup_test_tenant(cls.driver)
        with open(PDF, "rb") as f, open(DOCX, "rb") as g:
            files = {PDF_URL: (f.read(), "application/pdf"), DOCX_URL: (g.read(), DOCX_TYPE)}
        parser, redis = DoclingParser(), FakeRedis()
        cls.results = {}
        for url in (PDF_URL, DOCX_URL):
            task = {"uri": url, "tenant_id": TEST_TENANT_ID, "owner_id": "test-owner", "l2": "off", "visibility": "organization"}
            cls.results[url] = run(task, parser=parser, describer=None, transport=serve(files), redis_client=redis)

    @classmethod
    def tearDownClass(cls):
        if cls.driver is None:
            return
        cleanup_test_tenant(cls.driver)
        remaining = count_test_tenant_nodes(cls.driver)
        cls.driver.close()
        assert remaining == 0, f"{remaining} test-tenant nodes left"

    def tools(self, user=OWNER, guest="", allowed=None):
        from expert_tools import ExpertTools
        return ExpertTools(tenant_id=TEST_TENANT_ID, requesting_user_id=user, guest_share_anchor=guest, allowed_ids=allowed)

    def search(self, question, **who):
        with mock.patch.dict(os.environ, {"OWNER_USER_ID": OWNER}):
            t = self.tools(**who)
            try:
                return t.search_document_blocks(question)
            finally:
                t.close()

    def test_ingested(self):
        for url, r in self.results.items():
            self.assertEqual(r.get("state"), "done", f"{url}: {r}")

    def test_pdf_passages_cite_pages(self):
        out = self.search("masked language model pre-training objective")
        blocks = [b for b in out["blocks"] if b["citation"]["uri"] == PDF_URL]
        self.assertTrue(blocks, out)
        for b in blocks:
            page = b["citation"]["page"]
            self.assertIn(page, (1, 2, 3))
            self.assertEqual(b["citation"]["cite_url"], f"{PDF_URL}#page={page}")
            self.assertTrue(b["citation"]["revision_id"])
            self.assertTrue(b["text"])

    def test_docx_passages_cite_the_document(self):
        out = self.search("how do I configure a Gradle build")
        blocks = [b for b in out["blocks"] if b["citation"]["uri"] == DOCX_URL]
        self.assertTrue(blocks, out)
        self.assertTrue(all(b["citation"]["cite_url"] == DOCX_URL for b in blocks))

    def test_caps_and_cited_sources(self):
        from schema_guard import DOCUMENT_SEARCH_TOP_K, DOCUMENT_SEARCH_MAX_PER_SOURCE
        out = self.search("BERT Gradle language model build tasks")
        self.assertLessEqual(len(out["blocks"]), DOCUMENT_SEARCH_TOP_K)
        per = {}
        for b in out["blocks"]:
            per[b["citation"]["source_id"]] = per.get(b["citation"]["source_id"], 0) + 1
        self.assertTrue(all(n <= DOCUMENT_SEARCH_MAX_PER_SOURCE for n in per.values()))
        self.assertEqual({c["source_id"] for c in out["cited_sources"]}, set(per))

    def test_visibility_by_role(self):
        q = "masked language model pre-training objective"
        self.assertTrue(self.search(q)["blocks"], "owner sees the passages")
        self.assertEqual(self.search(q, user="user_invited_m5", allowed=[])["blocks"], [], "invited user, nothing shared")
        self.assertEqual(self.search(q, user="guest-auth", guest="anchor", allowed=[])["blocks"], [], "guest link")

    def test_graph_view(self):
        import json
        import domain_registry
        with mock.patch.object(domain_registry, "ENABLE_DOCUMENT_DOMAIN", True):
            t = self.tools()
            try:
                out = json.loads(t.search_enterprise_graph("BERT", domain_intent="document"))
            finally:
                t.close()
        types = [n["type"] for n in out["nodes"]]
        self.assertIn("DocumentSource", types)
        self.assertNotIn("ContentBlock", types)
        self.assertTrue(out["nodes"][0]["is_anchor"])

    def test_visibility_stored_and_sections_found(self):
        with self.driver.session() as s:
            rows = s.run("MATCH (d:DocumentSource {tenant_id: $t}) RETURN d.uri AS uri, d.visibility AS v, d.node_id AS id, "
                         "d.current_snapshot_id AS snap", t=TEST_TENANT_ID).data()
        self.assertEqual({r["uri"]: r["v"] for r in rows}, {PDF_URL: "organization", DOCX_URL: "organization"})
        from ingestion_engine import IngestionEngine
        e = IngestionEngine(tenant_id=TEST_TENANT_ID)
        try:
            for r in rows:
                self.assertTrue(e._current_section_ids(r["id"], r["snap"]), r["uri"])
        finally:
            e.close()


if __name__ == "__main__":
    unittest.main()
