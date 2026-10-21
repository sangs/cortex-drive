"""
Phase B M4' integration test: the worker's batch path end to end against the real Neo4j, Docling and
OpenAI (BAML + embeddings), under the test tenant, with a stand-in for the Claude Batch API (no Claude
cost). Ingest with l2="batch" submits one batch; a collect run applies the results to the graph.
Also checks l2="off" makes no figure calls. Everything is deleted afterwards.

    .venv/bin/python -m unittest tests.ingestion.test_document_worker_batch -v

Needs Neo4j. Cost: GPT-4o extractions + embeddings, a few cents.
"""
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

from tests.test_tenant import TEST_TENANT_ID, use_test_tenant, cleanup_test_tenant, count_test_tenant_nodes  # noqa: E402
use_test_tenant()

from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(ROOT, ".env"))
use_test_tenant()

import httpx  # noqa: E402

CHAI = os.path.join(ROOT, "documents", "eval", "parser-eval-2026-09-30", "source_docs", "02_chai_ai.pdf")
URL = "https://8.8.8.8/m4/chai-deck.pdf"
URL_OFF = "https://8.8.8.8/m4/chai-deck-off.pdf"
VLM_ONLY_TECHNOLOGY = "Apache Kafka"


class FakeRedis:
    def __init__(self):
        self.store = {}

    def setex(self, k, ttl, v):
        self.store[k] = v

    def get(self, k):
        return self.store.get(k)

    def delete(self, k):
        self.store.pop(k, None)

    def set(self, k, v, nx=False, ex=None):
        if nx and k in self.store:
            return None
        self.store[k] = v
        return True

    def expire(self, k, ttl):
        return k in self.store

    def eval(self, script, n, k, token):
        if self.store.get(k) == token:
            del self.store[k]
            return 1
        return 0


class StandInBatchDescriber:
    """Real request building (so requests are the production ones); the Batch API is simulated."""
    def __init__(self):
        from parsing.visual_describer import ClaudeVisualDescriber
        from unittest import mock
        self.real = ClaudeVisualDescriber(client=mock.MagicMock())
        self.submitted, self.sync_calls = [], 0

    def request_params(self, png, **kw):
        assert png[:8] == b"\x89PNG\r\n\x1a\n"
        return self.real.request_params(png, **kw)

    def describe(self, *a, **k):
        self.sync_calls += 1
        raise AssertionError("l2=batch must not make synchronous calls")

    def submit_batch(self, requests):
        self.submitted = requests
        return "batch_test_1"

    def batch_status(self, batch_id):
        return {"processing_status": "ended", "succeeded": len(self.submitted), "errored": 0, "expired": 0,
                "canceled": 0, "processing": 0}

    def batch_results(self, batch_id):
        from parsing.visual_describer import FigureDescription
        for cid, _ in self.submitted:
            yield cid, FigureDescription("diagram", "", [], f"Events flow from {VLM_ONLY_TECHNOLOGY} into a context graph."), "succeeded", 100, 20


def server(data):
    return lambda request: httpx.Response(200, content=data, headers={"etag": '"m4"', "content-type": "application/pdf"})


@unittest.skipUnless(os.path.exists(CHAI) and os.environ.get("NEO4J_URI") and os.environ.get("OPENAI_API_KEY"),
                     "needs the parser-eval documents, Neo4j and OpenAI credentials")
class WorkerBatchTest(unittest.TestCase):
    driver = None

    @classmethod
    def setUpClass(cls):
        from neo4j import GraphDatabase
        from parsing.docling_parser import DoclingParser
        from worker.ingest_document import run, run_collect
        cls.driver = GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"]))
        cleanup_test_tenant(cls.driver)
        with open(CHAI, "rb") as f:
            data = f.read()
        cls.redis, cls.queued, cls.describer = FakeRedis(), [], StandInBatchDescriber()
        enqueue = lambda task, delay: cls.queued.append((task, delay))  # noqa: E731
        parser = DoclingParser()
        task = {"mode": "ingest", "uri": URL, "tenant_id": TEST_TENANT_ID, "owner_id": "test-owner", "l2": "batch"}
        cls.ingest = run(task, parser=parser, describer=cls.describer, transport=httpx.MockTransport(server(data)),
                         redis_client=cls.redis, enqueue=enqueue)
        cls.pending_after_submit = cls._count("MATCH (b:ContentBlock {tenant_id: $t}) WHERE b.description_status = 'pending' RETURN count(b) AS c")
        cls.collect = run_collect(cls.queued[0][0], describer=cls.describer, redis_client=cls.redis, enqueue=enqueue)
        off_describer = StandInBatchDescriber()
        cls.off = run({"mode": "ingest", "uri": URL_OFF, "tenant_id": TEST_TENANT_ID, "owner_id": "test-owner", "l2": "off"},
                      parser=parser, describer=off_describer, transport=httpx.MockTransport(server(data)),
                      redis_client=cls.redis, enqueue=enqueue)
        cls.off_describer = off_describer

    @classmethod
    def tearDownClass(cls):
        if cls.driver is None:
            return
        cleanup_test_tenant(cls.driver)
        remaining = count_test_tenant_nodes(cls.driver)
        cls.driver.close()
        assert remaining == 0, f"{remaining} test-tenant nodes left behind"

    @classmethod
    def _count(cls, q, **p):
        with cls.driver.session() as s:
            return s.run(q, t=TEST_TENANT_ID, **p).single()["c"]

    def test_ingest_submits_one_batch_and_queues_collect(self):
        fig = self.ingest["figures"]
        self.assertEqual((fig["mode"], fig["batch_id"]), ("batch", "batch_test_1"))
        self.assertGreater(fig["submitted"], 0)
        self.assertEqual(self.describer.sync_calls, 0)
        task, delay = self.queued[0]
        self.assertEqual((task["mode"], delay), ("collect", 900))
        self.assertGreater(self.pending_after_submit, 0, "figures stay pending until the batch is collected")

    def test_collect_applies_descriptions(self):
        self.assertEqual(self.collect["state"], "applied")
        self.assertEqual(self.collect["described"], len(self.describer.submitted))
        n = self._count("MATCH (b:ContentBlock {tenant_id: $t}) WHERE b.description_status = 'described' "
                        "AND b.derived_by = 'vlm' AND b.embedding IS NOT NULL AND b.description CONTAINS $k RETURN count(b) AS c",
                        k=VLM_ONLY_TECHNOLOGY)
        self.assertEqual(n, len(self.describer.submitted))

    def test_vlm_entities_linked(self):
        n = self._count("MATCH (d:DocumentSource {tenant_id: $t, uri: $u})-[r]->(e) WHERE r.derived_by = 'vlm' "
                        "AND toLower(e.name) CONTAINS 'kafka' RETURN count(e) AS c", u=URL)
        self.assertGreater(n, 0)

    def test_spend_recorded_in_status(self):
        from worker.status import status_key
        st = json.loads(self.redis.get(status_key(TEST_TENANT_ID, URL)))
        self.assertEqual(st["figures"]["l2_batch_input_tokens"], 100 * len(self.describer.submitted))

    def test_l2_off_makes_no_calls(self):
        self.assertEqual(self.off["figures"]["reason"], "l2 off")
        self.assertEqual((self.off_describer.submitted, self.off_describer.sync_calls), ([], 0))


if __name__ == "__main__":
    unittest.main()
