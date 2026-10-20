"""
Phase B M3' integration test: the ingestion worker end to end (worker.ingest_document.run) against
the real Neo4j, Docling and OpenAI (BAML + embeddings), writing ONLY under the shared test tenant
and deleting everything afterwards (tests/test_tenant.py).

The download is served by httpx.MockTransport (the Chai deck from the parser eval, at an IP-literal
URL so the SSRF guard passes without DNS), and the L2 describer is a stand-in (no Claude call), so
the paid parts are one GPT-4o extraction per stage plus embeddings: a few cents per run.

    .venv/bin/python -m unittest tests.ingestion.test_document_worker -v
"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

from tests.test_tenant import (  # noqa: E402
    TEST_TENANT_ID, use_test_tenant, cleanup_test_tenant, count_test_tenant_nodes,
)
use_test_tenant()

from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(ROOT, ".env"))
use_test_tenant()

import httpx  # noqa: E402

CHAI = os.path.join(ROOT, "documents", "eval", "parser-eval-2026-09-30", "source_docs", "02_chai_ai.pdf")
URL = "https://8.8.8.8/m3/chai-deck.pdf"     # never contacted: served by MockTransport
ETAG = '"chai-v1"'
OTHER_TENANTS = ("SYSTEM", "test_org_123")
VLM_ONLY_TECHNOLOGY = "Apache Kafka"          # not in the deck: can only arrive via the stand-in describer


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

    def eval(self, script, numkeys, key, token):      # the lock-release script: delete only our own token
        if self.store.get(key) == token:
            del self.store[key]
            return 1
        return 0


class StandInDescriber:
    """Replaces Claude: a fixed description naming a technology that isn't in the document."""
    name = "stand-in"
    input_tokens = output_tokens = 0

    def __init__(self):
        self.calls = 0

    def describe(self, image_png, *, section_path, figure_text):
        from parsing.visual_describer import FigureDescription
        self.calls += 1
        assert image_png[:8] == b"\x89PNG\r\n\x1a\n", "figure crops must be PNG images"
        return FigureDescription(kind="diagram", title="",
                                 description=f"Diagram of events flowing from {VLM_ONLY_TECHNOLOGY} into a context graph.")


class Server:
    """Serves the PDF; answers 304 to a matching If-None-Match when `honor_etag` is on."""

    def __init__(self, data, content_type="application/pdf"):
        self.data, self.content_type, self.honor_etag, self.requests = data, content_type, True, 0
        self.etag = ETAG

    def __call__(self, request):
        self.requests += 1
        if self.honor_etag and request.headers.get("if-none-match") == self.etag:
            return httpx.Response(304)
        return httpx.Response(200, content=self.data, headers={"etag": self.etag, "content-type": self.content_type})


@unittest.skipUnless(os.path.exists(CHAI) and os.environ.get("NEO4J_URI") and os.environ.get("OPENAI_API_KEY"),
                     "needs the parser-eval documents, Neo4j and OpenAI credentials")
class DocumentWorkerTest(unittest.TestCase):
    driver = None

    @classmethod
    def setUpClass(cls):
        from neo4j import GraphDatabase
        from parsing.docling_parser import DoclingParser
        from worker.ingest_document import run
        from worker.status import status_key
        cls.driver = GraphDatabase.driver(os.environ["NEO4J_URI"],
                                          auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"]))
        cleanup_test_tenant(cls.driver)
        cls.other_before = cls._other_tenant_counts()
        cls.worker_run, cls.status_key = staticmethod(run), staticmethod(status_key)
        cls.parser = DoclingParser()
        with open(CHAI, "rb") as f:
            cls.server = Server(f.read())
        cls.redis = FakeRedis()
        cls.describer = StandInDescriber()
        cls.task = {"uri": URL, "tenant_id": TEST_TENANT_ID, "owner_id": "test-owner"}
        cls.first = cls._run()
        cls.status_after_first = cls._status()
        cls.second = cls._run()                        # server answers 304
        cls.server.honor_etag = False
        cls.third = cls._run()                         # full download, same content hash
        cls.server.etag = '"chai-v2"'                  # server re-generates its ETag; content identical
        cls.fourth = cls._run()

    @classmethod
    def _run(cls, task=None, server=None):
        return cls.worker_run(task or cls.task, parser=cls.parser, describer=cls.describer,
                       transport=httpx.MockTransport(server or cls.server), redis_client=cls.redis)

    @classmethod
    def _status(cls, uri=URL):
        import json
        raw = cls.redis.get(cls.status_key(TEST_TENANT_ID, uri))
        return json.loads(raw) if raw else None

    @classmethod
    def tearDownClass(cls):
        if cls.driver is None:
            return
        cleanup_test_tenant(cls.driver)
        remaining = count_test_tenant_nodes(cls.driver)
        other_after = cls._other_tenant_counts()
        cls.driver.close()
        assert remaining == 0, f"{remaining} test-tenant nodes left behind"
        assert other_after == cls.other_before, f"other tenants changed: {cls.other_before} -> {other_after}"

    @classmethod
    def _other_tenant_counts(cls):
        with cls.driver.session() as s:
            return {t: s.run("MATCH (n {tenant_id: $t}) RETURN count(n) AS c", t=t).single()["c"] for t in OTHER_TENANTS}

    def _q(self, query, **params):
        with self.driver.session() as s:
            return [r.data() for r in s.run(query, t=TEST_TENANT_ID, **params)]

    # ---------------------------------------------------------------- stage 1

    def test_first_run_ingests_document(self):
        self.assertEqual(self.first["state"], "done")
        self.assertGreater(self.first["blocks"], 0)
        self.assertGreater(self.first["entities"], 0)
        rows = self._q("MATCH (d:DocumentSource {tenant_id: $t, uri: $u}) RETURN d.http_etag IS NOT NULL AS has_etag, "
                       "d.mime_type AS mime, d.page_count AS pages", u=URL)
        self.assertEqual(rows, [{"has_etag": True, "mime": "application/pdf", "pages": 21}])

    def test_status_record_written(self):
        self.assertEqual(self.status_after_first["state"], "done")
        self.assertEqual(self.status_after_first["uri"], URL)

    # ---------------------------------------------------------------- change detection

    def test_etag_match_skips_download(self):
        self.assertEqual(self.second["state"], "unchanged")

    def test_same_content_without_etag_is_unchanged(self):
        self.assertEqual(self.third["state"], "unchanged")
        snaps = self._q("MATCH (:DocumentSource {tenant_id: $t})-[:HAS_SNAPSHOT]->(s) RETURN count(s) AS c")
        self.assertEqual(snaps, [{"c": 1}], "unchanged runs must not create snapshots")

    def test_new_etag_same_content_refreshes_validators(self):
        self.assertEqual(self.fourth["state"], "unchanged")
        rows = self._q("MATCH (d:DocumentSource {tenant_id: $t, uri: $u}) RETURN d.http_etag AS etag", u=URL)
        self.assertEqual(rows, [{"etag": '"chai-v2"'}], "the new ETag must be stored so the next check can get a 304")

    # ---------------------------------------------------------------- synchronous L2 (stand-in describer)

    def test_figures_described_or_marked_decorative(self):
        figures = self.first["figures"]
        self.assertGreater(figures["described"], 0)
        pending = self._q("MATCH (b:ContentBlock {tenant_id: $t}) WHERE b.description_status = 'pending' "
                          "RETURN count(b) AS c")[0]["c"]
        self.assertEqual(pending, figures["left_pending_cap"] + figures["left_pending_unusable"])
        bad = self._q("MATCH (b:ContentBlock {tenant_id: $t}) WHERE b.description_status = 'described' "
                      "AND (b.derived_by <> 'vlm' OR b.description IS NULL OR b.embedding IS NULL) RETURN count(b) AS c")
        self.assertEqual(bad, [{"c": 0}])

    def test_vlm_entities_linked_with_provenance(self):
        rows = self._q("MATCH (d:DocumentSource {tenant_id: $t})-[r]->(e) WHERE r.derived_by = 'vlm' "
                       "RETURN toLower(e.name) AS name, r.snapshot_id = d.current_snapshot_id AS current")
        self.assertTrue(any("kafka" in r["name"] for r in rows), f"expected the stand-in's technology, got {rows}")
        self.assertTrue(all(r["current"] for r in rows))

    def test_vlm_entity_grounded_to_described_block(self):
        rows = self._q("MATCH (b:ContentBlock {tenant_id: $t, description_status: 'described'})-[:GROUNDED_TO]->(e) "
                       "WHERE toLower(e.name) CONTAINS 'kafka' RETURN count(*) AS c")
        self.assertGreater(rows[0]["c"], 0)

    def test_lock_released_after_runs(self):
        self.assertFalse([k for k in self.redis.store if k.endswith(":lock")], "every run must release its lock")

    def test_concurrent_run_exits_without_changes(self):
        lock_key = self.status_key(TEST_TENANT_ID, URL) + ":lock"
        self.redis.set(lock_key, "held-by-another-run")
        before = self.server.requests
        try:
            result = self._run()
        finally:
            del self.redis.store[lock_key]
        self.assertEqual(result, {"state": "skipped_already_running"})
        self.assertEqual(self.server.requests, before, "a locked-out run must not even fetch")

    # ---------------------------------------------------------------- failure path and isolation

    def test_non_document_fails_with_status(self):
        url = "https://8.8.8.8/m3/not-a-document.pdf"
        task = {"uri": url, "tenant_id": TEST_TENANT_ID, "owner_id": "test-owner"}
        with self.assertRaises(Exception):
            self._run(task=task, server=Server(b"<html>sign in</html>", "text/html"))
        st = self._status(url)
        self.assertEqual(st["state"], "failed")
        self.assertIn("Not a supported document", st["error"])
        self.assertEqual(self._q("MATCH (d:DocumentSource {tenant_id: $t, uri: $u}) RETURN count(d) AS c", u=url),
                         [{"c": 0}])

    def test_nothing_written_outside_test_tenant(self):
        self.assertEqual(self._other_tenant_counts(), self.other_before)
        self.assertIsNone(os.environ.get("PERMIFY_API_URL"), "test runs must never write Permify tuples")


if __name__ == "__main__":
    unittest.main()
