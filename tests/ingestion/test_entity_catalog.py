"""
S2-60: the routing catalog builder (src/mcp_server/entity_catalog.py).

Unit (no network): short names, version bump never raises, label → domain mapping.
Integration (TEST TENANT, real Neo4j + OpenAI): ingest one small PDF through the real worker → the worker
bumped `entcat_version:{tenant}`, and build_entity_catalog returns the document's title with its node id,
tier "org" and short name. Writes only under the test tenant and deletes everything afterwards (no Permify
tuples: test-tenant rule). Paid: one GPT-4o extraction + embeddings (a few cents).

    .venv/bin/python -m unittest tests.ingestion.test_entity_catalog -v
"""
import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))
sys.path.insert(0, os.path.join(ROOT, "tests", "ingestion"))

from tests.test_tenant import TEST_TENANT_ID, use_test_tenant, cleanup_test_tenant, count_test_tenant_nodes  # noqa: E402
use_test_tenant()
from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(ROOT, ".env"))
use_test_tenant()

import entity_catalog  # noqa: E402


class UnitTest(unittest.TestCase):
    def test_short_name(self):
        self.assertEqual(entity_catalog.short_name("BERT: Pre-training of Deep Bidirectional Transformers"), "BERT")
        self.assertEqual(entity_catalog.short_name("Apache Iceberg - Wikipedia"), "Apache Iceberg")
        self.assertIsNone(entity_catalog.short_name("No separator here"))
        self.assertIsNone(entity_catalog.short_name("AI: too short a prefix"))

    def test_bump_never_raises(self):
        class Broken:
            def incr(self, key):
                raise ConnectionError("redis down")
        entity_catalog.bump_version(Broken(), "t")   # logs, doesn't raise

    def test_version_key(self):
        self.assertEqual(entity_catalog.version_key("org_x"), "entcat_version:org_x")

    def test_domain_mapping(self):
        self.assertEqual(entity_catalog._domain_for({"DocumentSource"}), "document")
        self.assertEqual(entity_catalog._domain_for({"Company"}), "career")
        self.assertEqual(entity_catalog._domain_for({"Person"}), "person")
        self.assertIsNone(entity_catalog._domain_for({"Concept"}))


@unittest.skipUnless(os.environ.get("NEO4J_URI") and os.environ.get("OPENAI_API_KEY"), "needs Neo4j and OpenAI credentials")
class IntegrationTest(unittest.TestCase):
    def test_new_document_appears_with_id_tier_and_short_name(self):
        from neo4j import GraphDatabase
        from test_document_query import PDF, PDF_URL, FakeRedis, serve
        from parsing.docling_parser import DoclingParser
        from worker.ingest_document import run

        class CountingRedis(FakeRedis):
            def incr(self, key):
                self.store[key] = int(self.store.get(key) or 0) + 1
                return self.store[key]

        if not os.path.exists(PDF):
            self.skipTest("parser-eval PDF missing")
        driver = GraphDatabase.driver(os.environ["NEO4J_URI"], auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"]))
        try:
            cleanup_test_tenant(driver)
            with open(PDF, "rb") as f:
                files = {PDF_URL: (f.read(), "application/pdf")}
            redis = CountingRedis()
            with mock.patch.dict(os.environ, {"OWNER_USER_ID": "user_owner_s260_test"}):
                result = run({"uri": PDF_URL, "tenant_id": TEST_TENANT_ID, "owner_id": "test-owner", "l2": "off",
                              "visibility": "private"},
                             parser=DoclingParser(), describer=None, transport=serve(files), redis_client=redis)
            self.assertEqual(result.get("state"), "done", result)
            self.assertEqual(redis.store.get(entity_catalog.version_key(TEST_TENANT_ID)), 1, "worker bumped the counter")

            catalog = entity_catalog.build_entity_catalog(driver, TEST_TENANT_ID)
            docs = [e for e in catalog["entries"] if e["domain"] == "document" and e["node_id"] == result["source_node_id"]]
            self.assertEqual(len(docs), 1, catalog["entries"][:5])
            self.assertEqual(docs[0]["tier"], entity_catalog.ORG_TIER)
            self.assertIn(docs[0]["name"], catalog["domains"]["document"])
            if entity_catalog.short_name(docs[0]["name"]):
                self.assertEqual(docs[0]["short_name"], entity_catalog.short_name(docs[0]["name"]))
            print(f"\n  catalog entry: {docs[0]}")
        finally:
            cleanup_test_tenant(driver)
            remaining = count_test_tenant_nodes(driver)
            driver.close()
            self.assertEqual(remaining, 0, f"{remaining} test-tenant nodes left")


if __name__ == "__main__":
    unittest.main()
