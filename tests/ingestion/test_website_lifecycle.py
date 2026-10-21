"""
S2-30: website sources get the same entity lifecycle as documents. Two revisions of a page are
ingested with IngestionEngine.process_web_source() against the real Neo4j, under the test tenant,
with a stand-in for the BAML extraction (deterministic, no GPT cost). Everything is deleted after.

    .venv/bin/python -m unittest tests.ingestion.test_website_lifecycle -v

Revision 1 links Alpha, Bravo, Old Person and a reference link, and also extracts "Unlinked One"
without linking it. Before revision 2, an untagged pre-S2-30 link to "Legacy Concept" is added by hand,
and "Shared Concept" is linked from revision 1 and also from an unrelated node (it must survive).
Revision 2 links Bravo and Charlie only.
"""
import os
import sys
import unittest
from types import SimpleNamespace as NS
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

from tests.test_tenant import TEST_TENANT_ID, use_test_tenant, cleanup_test_tenant, count_test_tenant_nodes  # noqa: E402
use_test_tenant()

from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(ROOT, ".env"))
use_test_tenant()

URL = "https://test.cortex-drive.invalid/s2-30/page"     # never fetched: content is passed directly


def rel(kind, target):
    return NS(relationship_type=NS(name=kind), target_node=target, source_node="Test page")


def extraction(concepts, technologies, people, links, relationships):
    return NS(title="Test page", description="S2-30 lifecycle test page",
              concepts=[NS(name=c, description=None) for c in concepts],
              technologies=[NS(name=t) for t in technologies],
              people=[NS(name=p, role=None) for p in people],
              reference_links=[NS(url=u, text=u) for u in links],
              relationships=relationships)


REV1 = extraction(["Alpha", "Shared Concept", "Unlinked One"], ["Bravo"], ["Old Person"], ["https://example.org/ref-1"],
                  [rel("DISCUSSES", "Alpha"), rel("DISCUSSES", "Shared Concept"), rel("COVERS_TECHNOLOGY", "Bravo"),
                   rel("MENTIONS", "Old Person")])
REV2 = extraction(["Charlie"], ["Bravo"], [], [],
                  [rel("DISCUSSES", "Charlie"), rel("COVERS_TECHNOLOGY", "Bravo")])


@unittest.skipUnless(os.environ.get("NEO4J_URI"), "needs Neo4j credentials")
class WebsiteLifecycleTest(unittest.TestCase):
    engine = None

    @classmethod
    def setUpClass(cls):
        import ingestion_engine
        cls.engine = ingestion_engine.IngestionEngine(tenant_id=TEST_TENANT_ID)
        cls.driver = cls.engine.driver
        cleanup_test_tenant(cls.driver)
        with mock.patch.object(ingestion_engine.b, "ExtractWebPage", return_value=REV1):
            cls.source_id = cls.engine.process_web_source(url=URL, content="rev1", content_hash="h1", owner_id="test-owner")
        cls.after_rev1 = cls._links()
        with cls.driver.session() as s:     # an untagged pre-S2-30 link, and a second owner for "Shared Concept"
            s.run("""MATCH (w:WebsiteSource {tenant_id: $t, node_id: $id})
                     MERGE (c:Concept {tenant_id: $t, name: 'Legacy Concept'}) ON CREATE SET c.node_id = randomUUID()
                     MERGE (w)-[:DISCUSSES]->(c)""", t=TEST_TENANT_ID, id=cls.source_id)
            s.run("""MATCH (c:Concept {tenant_id: $t, name: 'Shared Concept'})
                     MERGE (o:Topic {tenant_id: $t, name: 'Other Owner'}) ON CREATE SET o.node_id = randomUUID()
                     MERGE (o)-[:RELATED_TO]->(c)""", t=TEST_TENANT_ID)
        with mock.patch.object(ingestion_engine.b, "ExtractWebPage", return_value=REV2):
            cls.engine.process_web_source(url=URL, content="rev2", content_hash="h2", owner_id="test-owner")
        cls.after_rev2 = cls._links()

    @classmethod
    def tearDownClass(cls):
        if cls.engine is None:
            return
        cleanup_test_tenant(cls.driver)
        remaining = count_test_tenant_nodes(cls.driver)
        cls.engine.close()
        assert remaining == 0, f"{remaining} test-tenant nodes left behind"

    @classmethod
    def _links(cls):
        with cls.driver.session() as s:
            return {r["name"]: r["sid"] for r in s.run(
                """MATCH (w:WebsiteSource {tenant_id: $t})-[r]->(e)
                   WHERE type(r) IN ['DISCUSSES','COVERS_TECHNOLOGY','MENTIONS','HAS_REFERENCE']
                   RETURN coalesce(e.name, e.url) AS name, r.snapshot_id AS sid""", t=TEST_TENANT_ID)}

    def _exists(self, label, name):
        with self.driver.session() as s:
            return s.run(f"MATCH (n:{label} {{tenant_id: $t, name: $n}}) RETURN count(n) AS c", t=TEST_TENANT_ID, n=name).single()["c"] > 0

    def _current_snapshot(self):
        with self.driver.session() as s:
            return s.run("MATCH (w:WebsiteSource {tenant_id: $t}) RETURN w.current_snapshot_id AS sid", t=TEST_TENANT_ID).single()["sid"]

    def test_rev1_links_are_tagged_with_its_snapshot(self):
        self.assertEqual(set(self.after_rev1), {"Alpha", "Shared Concept", "Bravo", "Old Person", "https://example.org/ref-1"})
        self.assertEqual(len(set(self.after_rev1.values())), 1)
        self.assertIsNotNone(next(iter(self.after_rev1.values())))

    def test_rev2_keeps_only_reasserted_links_tagged_with_rev2(self):
        self.assertEqual(set(self.after_rev2), {"Bravo", "Charlie"})
        self.assertEqual(set(self.after_rev2.values()), {self._current_snapshot()})

    def test_stale_entities_deleted(self):
        for label, name in (("Concept", "Alpha"), ("Person", "Old Person"), ("Concept", "Legacy Concept")):
            self.assertFalse(self._exists(label, name), f"{label} {name} should be gone (orphaned by rev2)")
        with self.driver.session() as s:
            self.assertEqual(s.run("MATCH (l:ReferenceLink {tenant_id: $t}) RETURN count(l) AS c", t=TEST_TENANT_ID).single()["c"], 0)

    def test_entity_extracted_but_never_linked_is_not_left_behind(self):
        self.assertFalse(self._exists("Concept", "Unlinked One"))

    def test_entity_still_used_elsewhere_survives(self):
        self.assertNotIn("Shared Concept", self.after_rev2)
        self.assertTrue(self._exists("Concept", "Shared Concept"), "a node with other relationships must never be deleted")

    def test_no_orphan_entities_remain(self):
        with self.driver.session() as s:
            n = s.run("""MATCH (e {tenant_id: $t}) WHERE (e:Concept OR e:Technology OR e:Person OR e:ReferenceLink)
                         AND NOT (e)--() RETURN count(e) AS c""", t=TEST_TENANT_ID).single()["c"]
        self.assertEqual(n, 0)

    def test_document_lifecycle_defaults_unchanged(self):
        import inspect
        sig = inspect.signature(self.engine._apply_entity_lifecycle)
        self.assertEqual(sig.parameters["source_label"].default, "DocumentSource")


if __name__ == "__main__":
    unittest.main()
