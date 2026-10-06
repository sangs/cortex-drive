"""
Phase B M2 integration test: IngestionEngine.process_document_source() against the real Neo4j and
OpenAI (BAML GPT-4o + embeddings), writing ONLY under the shared test tenant and deleting
everything afterwards (tests/test_tenant.py).

    .venv/bin/python -m unittest tests.ingestion.test_document_ingestion -v

Needs: .env with NEO4J_* and OPENAI_API_KEY; the parser-eval documents (documents/ is local only).
Cost per run: two short GPT-4o extractions plus embeddings, a few cents.
"""
import hashlib
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

from tests.test_tenant import (  # noqa: E402
    TEST_TENANT_ID, use_test_tenant, cleanup_test_tenant, count_test_tenant_nodes,
)
use_test_tenant()                                  # before importing schema/ingestion modules

from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(ROOT, ".env"))
use_test_tenant()                                  # .env may set TEST_TENANT/PERMIFY_API_URL again

CHAI = os.path.join(ROOT, "documents", "eval", "parser-eval-2026-09-30", "source_docs", "02_chai_ai.pdf")
URI = "https://test.cortex-drive.invalid/m2/chai-deck.pdf"   # never fetched; identity key only
OTHER_TENANTS = ("SYSTEM", "test_org_123")


@unittest.skipUnless(os.path.exists(CHAI) and os.environ.get("NEO4J_URI") and os.environ.get("OPENAI_API_KEY"),
                     "needs the parser-eval documents, Neo4j and OpenAI credentials")
class DocumentIngestionTest(unittest.TestCase):
    engine = None

    @classmethod
    def setUpClass(cls):
        from ingestion_engine import IngestionEngine
        from parsing.docling_parser import DoclingParser
        from parsing.structure_parser import MIME_PDF
        cls.engine = IngestionEngine(tenant_id=TEST_TENANT_ID)
        cls.driver = cls.engine.driver
        cleanup_test_tenant(cls.driver)                       # start clean even after an aborted run
        cls.other_before = cls._other_tenant_counts()
        with open(CHAI, "rb") as f:
            data = f.read()
        parser = DoclingParser()
        cls.rev1 = parser.parse(data, MIME_PDF, "chai.pdf", page_range=(14, 17))   # tech-stack slide (p16)
        cls.rev2 = parser.parse(data, MIME_PDF, "chai.pdf", page_range=(1, 3))     # SAP / Salesforce / Workday
        cls.result1 = cls.engine.process_document_source(
            uri=URI, parsed=cls.rev1, mime_type=MIME_PDF, filename="chai.pdf", owner_id="test-owner",
            content_hash=hashlib.sha256(b"rev1").hexdigest())
        cls.after_rev1 = cls._entity_names()
        cls.result2 = cls.engine.process_document_source(
            uri=URI, parsed=cls.rev2, mime_type=MIME_PDF, filename="chai.pdf", owner_id="test-owner",
            content_hash=hashlib.sha256(b"rev2").hexdigest())
        cls.after_rev2 = cls._entity_names()

    @classmethod
    def tearDownClass(cls):
        if cls.engine is None:
            return
        cleanup_test_tenant(cls.driver)
        remaining = count_test_tenant_nodes(cls.driver)
        other_after = cls._other_tenant_counts()
        cls.engine.close()
        assert remaining == 0, f"{remaining} test-tenant nodes left behind"
        assert other_after == cls.other_before, f"other tenants changed: {cls.other_before} -> {other_after}"

    # ---------------------------------------------------------------- helpers

    @classmethod
    def _q(cls, query, **params):
        with cls.driver.session() as s:
            return [r.data() for r in s.run(query, t=TEST_TENANT_ID, **params)]

    @classmethod
    def _other_tenant_counts(cls):
        with cls.driver.session() as s:
            return {t: s.run("MATCH (n {tenant_id: $t}) RETURN count(n) AS c", t=t).single()["c"] for t in OTHER_TENANTS}

    @classmethod
    def _entity_names(cls):
        rows = cls._q("MATCH (d:DocumentSource {tenant_id: $t})-[r]->(e) WHERE e:Concept OR e:Technology OR e:Person "
                      "RETURN toLower(e.name) AS name")
        return {r["name"] for r in rows}

    # ---------------------------------------------------------------- structure (Cypher §17)

    def test_one_current_snapshot(self):                                        # §17.1
        rows = self._q("MATCH (d:DocumentSource {tenant_id: $t}) OPTIONAL MATCH (d)-[:HAS_SNAPSHOT]->"
                       "(s:SourceSnapshot {is_current: true}) RETURN count(s) AS c")
        self.assertEqual(rows, [{"c": 1}])
        total = self._q("MATCH (:DocumentSource {tenant_id: $t})-[:HAS_SNAPSHOT]->(s) RETURN count(s) AS c")
        self.assertEqual(total, [{"c": 2}], "both revisions are kept as history")

    def test_blocks_have_page_bbox_revision(self):                              # §17.3
        bad = self._q("MATCH (b:ContentBlock {tenant_id: $t}) WHERE b.page IS NULL OR b.bbox IS NULL "
                      "OR b.revision_id IS NULL RETURN count(b) AS c")
        self.assertEqual(bad, [{"c": 0}])
        self.assertGreater(self.result2["blocks"], 0)

    def test_only_current_revision_blocks_remain(self):                         # §17.4
        rows = self._q("MATCH (d:DocumentSource {tenant_id: $t})-[:HAS_SNAPSHOT]->(s:SourceSnapshot {is_current: true}) "
                       "MATCH (d)-[:HAS_SECTION]->(sec:Section)-[:HAS_BLOCK]->(b) "
                       "RETURN count(CASE WHEN b.revision_id <> s.node_id THEN 1 END) AS stale, "
                       "       count(CASE WHEN sec.revision_id <> s.node_id THEN 1 END) AS stale_sections")
        self.assertEqual(rows, [{"stale": 0, "stale_sections": 0}])
        pages = {r["p"] for r in self._q("MATCH (b:ContentBlock {tenant_id: $t}) RETURN DISTINCT b.page AS p")}
        self.assertTrue(pages <= {1, 2, 3}, f"revision-1 pages (14-17) must be gone, got {pages}")

    def test_embeddings_written(self):
        rows = self._q("MATCH (b:ContentBlock {tenant_id: $t}) WHERE b.text <> '' "
                       "RETURN count(b) AS n, count(b.embedding) AS with_emb")
        self.assertEqual(rows[0]["n"], rows[0]["with_emb"])

    # ---------------------------------------------------------------- entity lifecycle (§17.6, §17.7)

    def test_links_belong_to_current_snapshot(self):                            # §17.6
        rows = self._q("MATCH (d:DocumentSource {tenant_id: $t})-[:HAS_SNAPSHOT]->(s:SourceSnapshot {is_current: true}) "
                       "MATCH (d)-[r]->(e) WHERE type(r) IN ['DISCUSSES','COVERS_TECHNOLOGY','MENTIONS','HAS_REFERENCE'] "
                       "AND coalesce(r.snapshot_id,'') <> s.node_id RETURN count(r) AS c")
        self.assertEqual(rows, [{"c": 0}])

    def test_revision_two_entities_present_and_revision_one_only_entities_removed(self):
        self.assertTrue({"sap", "salesforce", "workday"} & self.after_rev2, f"rev2 entities missing: {self.after_rev2}")
        # Data-driven: whatever revision 1 linked that revision 2 didn't re-assert must be gone.
        # (Which entities BAML finds is measured separately by the entity-extraction check.)
        only_rev1 = self.after_rev1 - self.after_rev2
        self.assertTrue(only_rev1, f"revisions should differ: rev1={self.after_rev1} rev2={self.after_rev2}")
        still = self._q("MATCH (e {tenant_id: $t}) WHERE toLower(e.name) IN $names RETURN e.name AS n",
                        names=sorted(only_rev1))
        self.assertEqual(still, [], "entities only revision 1 mentioned must be deleted (orphans)")
        self.assertGreater(self.result2["removed_stale_links"], 0)

    def test_no_orphan_entities(self):                                          # §17.7
        rows = self._q("MATCH (e {tenant_id: $t}) WHERE (e:Concept OR e:Technology OR e:Person OR e:ReferenceLink) "
                       "AND NOT (e)--() RETURN count(e) AS c")
        self.assertEqual(rows, [{"c": 0}])

    def test_blocks_grounded_to_entities(self):                                 # §17.8
        rows = self._q("MATCH (b:ContentBlock {tenant_id: $t})-[:GROUNDED_TO]->(e) RETURN count(*) AS c")
        self.assertGreater(rows[0]["c"], 0)

    # ---------------------------------------------------------------- invariants (§17.9, §17.10)

    def test_visual_blocks_pending_with_provenance(self):                       # §17.5 / §17.9
        rows = self._q("MATCH (b:ContentBlock {tenant_id: $t}) WHERE b.type IN ['figure','chart'] "
                       "RETURN count(b) AS n, count(CASE WHEN b.description_status = 'pending' THEN 1 END) AS pending")
        self.assertEqual(rows[0]["n"], rows[0]["pending"])
        bad = self._q("MATCH (b:ContentBlock {tenant_id: $t}) WHERE NOT b.derived_by IN ['text','ocr','vlm'] "
                      "RETURN count(b) AS c")
        self.assertEqual(bad, [{"c": 0}])

    def test_nothing_written_outside_test_tenant(self):                         # §17.10 + isolation
        self.assertEqual(self._other_tenant_counts(), self.other_before)
        rows = self._q("MATCH (d:DocumentSource {tenant_id: $t})-[*1..3]-(n) WHERE n.tenant_id <> $t "
                       "RETURN count(n) AS c")
        self.assertEqual(rows, [{"c": 0}], "document graph must not link to other tenants' nodes")


if __name__ == "__main__":
    unittest.main()
