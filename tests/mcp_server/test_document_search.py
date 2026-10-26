"""
Phase B M5 step 3: search_document_blocks (design §1.3.2 / §1.3.4). Mocked driver and embedding.

- every $param passed is referenced in its query, and every referenced param is passed (AP-2);
- the visibility rule is inside both queries, on the block and its document, per caller role (S2-42);
- only the current revision is searched;
- reciprocal rank fusion, the per-document cap and the top-k cap;
- server-built cite_url (#page=N for PDFs) and the AI-generated label on vision-model blocks;
- failures in-band; keyword syntax characters escaped; the MCP tool is off unless the flag is on.

    .venv/bin/python -m unittest tests.mcp_server.test_document_search -v
"""
import asyncio
import json
import os
import re
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

from tests.test_tenant import TEST_TENANT_ID, use_test_tenant  # noqa: E402
use_test_tenant()

from expert_tools import ExpertTools  # noqa: E402
from schema_guard import DOCUMENT_SEARCH_TOP_K, DOCUMENT_SEARCH_MAX_PER_SOURCE, DOCUMENT_EVIDENCE_MAX_CHARS  # noqa: E402

OWNER, INVITEE = "user_owner_test", "user_invitee_test"


def row(bid, source="d1", page=1, text="passage", derived_by="text", mime="application/pdf", description=None):
    return {"block_id": bid, "text": text, "description": description, "type": "paragraph", "derived_by": derived_by,
            "page": page, "section_path": ["Intro"], "source_id": source, "source_name": f"Doc {source}",
            "uri": f"https://example.com/{source}.pdf", "mime_type": mime, "revision_id": f"rev-{source}",
            "revision_date": "2026-10-20T00:00:00Z", "section": "Intro", "score": 0.9}


def tools(user=OWNER, guest="", allowed=None, vector=(), keyword=(), fail=False):
    t = ExpertTools.__new__(ExpertTools)
    t.tenant_id, t.requesting_user_id, t.guest_share_anchor, t.allowed_ids = TEST_TENANT_ID, user, guest, allowed
    t.get_embedding = mock.MagicMock(return_value=[0.1] * 3)
    t.driver = mock.MagicMock()
    results = [mock.MagicMock(records=list(vector)), mock.MagicMock(records=list(keyword))]
    if fail:
        t.driver.execute_query.side_effect = RuntimeError("index missing")
    else:
        t.driver.execute_query.side_effect = results
    return t


def calls(t):
    return [(c[0][0], c[1]) for c in t.driver.execute_query.call_args_list]


@mock.patch.dict(os.environ, {"OWNER_USER_ID": OWNER})
class QueryShapeTest(unittest.TestCase):
    def test_params_match_query_references(self):  # AP-2
        t = tools(user=INVITEE, allowed=["x"])
        t.search_document_blocks("What does the report say about Kafka?")
        for query, kwargs in calls(t):
            self.assertEqual(set(re.findall(r"\$(\w+)", query)), set(kwargs))

    def test_security_clause_on_block_and_document_per_role(self):
        t = tools(user=INVITEE, allowed=["x"])
        t.search_document_blocks("kafka")
        for query, kwargs in calls(t):
            self.assertIn("(b.node_id IN $allowed_ids OR b.tenant_id IN ['SYSTEM', 'PUBLIC'])", query)
            self.assertIn("(d.node_id IN $allowed_ids OR d.tenant_id IN ['SYSTEM', 'PUBLIC'])", query)
            self.assertNotIn("tenant_id", kwargs)
        t = tools(user=OWNER, allowed=["x"])
        t.search_document_blocks("kafka")
        for query, kwargs in calls(t):
            self.assertIn("$tenant_id", query)
            self.assertEqual(kwargs["tenant_id"], TEST_TENANT_ID)

    def test_guest_gets_strict_clause(self):
        t = tools(user="guest-auth", guest="anchor", allowed=["x"])
        t.search_document_blocks("kafka")
        for query, _ in calls(t):
            self.assertNotIn("$tenant_id", query)

    def test_current_revision_only(self):
        t = tools()
        t.search_document_blocks("kafka")
        for query, _ in calls(t):
            self.assertIn("b.revision_id = d.current_snapshot_id", query)

    def test_keyword_syntax_escaped(self):
        t = tools()
        t.search_document_blocks('What is "Kafka: Streams"? (v2) [beta]')
        self.assertEqual(calls(t)[1][1]["lucene"], "What is Kafka Streams v2 beta")

    def test_question_of_only_symbols_skips_keyword_query(self):
        t = tools(vector=[row("a")])
        t.search_document_blocks("???")
        self.assertEqual(len(calls(t)), 1)


@mock.patch.dict(os.environ, {"OWNER_USER_ID": OWNER})
class FusionAndCitationTest(unittest.TestCase):
    def test_rrf_prefers_blocks_found_by_both(self):
        t = tools(vector=[row("a"), row("b")], keyword=[row("b"), row("c")])
        out = t.search_document_blocks("q")
        self.assertEqual(out["blocks"][0]["citation"]["source_id"], "d1")
        order = [b["score"] for b in out["blocks"]]
        self.assertEqual(order, sorted(order, reverse=True))
        self.assertEqual(len(out["blocks"]), 3)
        top_text_ids = [b for b in out["blocks"]]
        self.assertGreater(top_text_ids[0]["score"], top_text_ids[1]["score"])

    def test_per_document_and_top_k_caps(self):
        vector = [row(f"a{i}", source="d1") for i in range(10)] + [row(f"b{i}", source="d2") for i in range(10)]
        out = tools(vector=vector).search_document_blocks("q", top_k=50)
        self.assertLessEqual(len(out["blocks"]), DOCUMENT_SEARCH_TOP_K)
        per = {}
        for b in out["blocks"]:
            per[b["citation"]["source_id"]] = per.get(b["citation"]["source_id"], 0) + 1
        self.assertTrue(all(v <= DOCUMENT_SEARCH_MAX_PER_SOURCE for v in per.values()))
        self.assertEqual({c["source_id"] for c in out["cited_sources"]}, {"d1", "d2"})

    def test_cite_url_built_server_side(self):
        out = tools(vector=[row("a", page=7), row("b", source="d2", page=3, mime="application/vnd.openxmlformats")]).search_document_blocks("q")
        urls = {b["citation"]["source_id"]: b["citation"]["cite_url"] for b in out["blocks"]}
        self.assertEqual(urls["d1"], "https://example.com/d1.pdf#page=7")
        self.assertEqual(urls["d2"], "https://example.com/d2.pdf")

    def test_vlm_blocks_labelled_and_text_capped(self):
        out = tools(vector=[row("f", page=4, text="", derived_by="vlm", description="A chart of Kafka throughput" + "x" * 2000)]).search_document_blocks("q")
        b = out["blocks"][0]
        self.assertEqual(b["label"], "AI-generated figure description (from the figure on p. 4)")
        self.assertEqual(len(b["text"]), DOCUMENT_EVIDENCE_MAX_CHARS)

    def test_failures_in_band(self):
        self.assertIn("error", tools(fail=True).search_document_blocks("q"))
        self.assertIn("error", tools().search_document_blocks("   "))


class FakeNode(dict):
    def __init__(self, eid, labels, **props):
        super().__init__(props)
        self.element_id, self.labels = eid, frozenset(labels) if len(labels) > 1 else labels


def graph_tools(records, user=OWNER, allowed=None):
    t = ExpertTools.__new__(ExpertTools)
    t.tenant_id, t.requesting_user_id, t.guest_share_anchor, t.allowed_ids = TEST_TENANT_ID, user, "", allowed
    t.driver = mock.MagicMock()
    t.driver.execute_query.return_value = mock.MagicMock(records=records)
    return t


@mock.patch.dict(os.environ, {"OWNER_USER_ID": OWNER})
class DocumentGraphTest(unittest.TestCase):
    def _records(self, n_entities=3):
        d = FakeNode("e:d1", ["DocumentSource"], node_id="d1", name="Kafka Report", uri="https://x/k.pdf")
        s = FakeNode("e:s1", ["Section"], node_id="s1", title="Kafka throughput")
        ents = [{"node": FakeNode(f"e:t{i}", ["Technology"], node_id=f"t{i}", name=f"Tech {i}"), "rel": "COVERS_TECHNOLOGY"}
                for i in range(n_entities)]
        return [{"d": d, "sections": [s], "entities": ents}]

    def test_shape_and_links(self):
        out = graph_tools(self._records())._search_document_graph("Kafka")
        types = [n["type"] for n in out["nodes"]]
        self.assertEqual(types, ["DocumentSource", "Section", "Technology", "Technology", "Technology"])
        self.assertTrue(out["nodes"][0]["is_anchor"])
        self.assertEqual(out["nodes"][1]["name"], "Kafka throughput")  # Section uses title
        self.assertEqual({l["type"] for l in out["links"]}, {"HAS_SECTION", "COVERS_TECHNOLOGY"})
        self.assertNotIn("ContentBlock", types)

    def test_node_cap(self):
        from schema_guard import DOCUMENT_GRAPH_MAX_NODES
        out = graph_tools(self._records(n_entities=100))._search_document_graph("kafka")
        self.assertLessEqual(len(out["nodes"]), DOCUMENT_GRAPH_MAX_NODES)
        ids = {n["id"] for n in out["nodes"]}
        self.assertTrue(all(l["source"] in ids and l["target"] in ids for l in out["links"]))

    def test_query_params_and_security_per_role(self):
        t = graph_tools([], user=INVITEE, allowed=["x"])
        t._search_document_graph("Kafka  Report")
        query, kwargs = t.driver.execute_query.call_args[0][0], t.driver.execute_query.call_args[1]
        self.assertEqual(set(re.findall(r"\$(\w+)", query)), set(kwargs))  # AP-2
        self.assertEqual(kwargs["keyword"], "kafka report")
        for var in ("d", "s", "e"):
            self.assertIn(f"({var}.node_id IN $allowed_ids OR {var}.tenant_id IN ['SYSTEM', 'PUBLIC'])", query)
        self.assertIn("s.revision_id = d.current_snapshot_id", query)


class McpToolFlagTest(unittest.TestCase):
    def test_tool_refuses_when_flag_off(self):
        import cortex_os_mentalmodel_server_sse as sse
        import domain_registry
        with mock.patch.object(domain_registry, "ENABLE_DOCUMENT_DOMAIN", False):
            out = json.loads(asyncio.run(sse.search_document_blocks(question="q", top_k=8)))
        self.assertEqual(out, {"error": "document search is not enabled"})


if __name__ == "__main__":
    unittest.main()
