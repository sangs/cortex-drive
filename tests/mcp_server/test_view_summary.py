"""
Bento panel "in this view" summary (bridge-discovery-and-bento-panel-design-2026-11-03.md §3.2 A, §3.3).

- Renderer and id cleaning: no network.
- On-screen id recheck: against the live Neo4j, under the test tenant only (cleaned up before and
  after; no Permify writes, no OpenAI calls). A forged on-screen id for a node the viewer cannot
  open is dropped silently: its name never reaches the summary, for a member and for a guest link.

    .venv/bin/python -m unittest tests.mcp_server.test_view_summary -v
"""
import inspect
import json
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

import domain_registry as reg  # noqa: E402
from expert_tools import ExpertTools  # noqa: E402

render = ExpertTools._render_view_summary


def pair(vid, vname, s_name, vlabels=("Project",), s_degree=1, s_labels=("Technology",)):
    return {"v_id": vid, "v_name": vname, "v_labels": list(vlabels), "s_name": s_name, "s_degree": s_degree,
            "s_labels": list(s_labels)}


class RenderTest(unittest.TestCase):
    NODE = {"name": "BERT", "labels": ["DocumentSource"]}

    def test_counts_by_type_most_first(self):
        text = render(self.NODE, [{"labels": ["Episode"], "count": 2, "dated": []},
                                  {"labels": ["Technology", "Embeddable"], "count": 3, "dated": []}], [])
        self.assertIn("connects to 5 items you can see: 3 Technologies and 2 Episodes.", text)

    def test_extra_types_are_summed(self):
        rows = [{"labels": [f"T{i}"], "count": 1, "dated": []} for i in range(reg.CONTEXT_SUMMARY_MAX_TYPES + 2)]
        self.assertIn("and 2 other items", render(self.NODE, rows, []))

    def test_domains_named_only_when_more_than_one(self):
        one = render(self.NODE, [{"labels": ["Episode"], "count": 1, "dated": []}], [])
        self.assertNotIn("across", one)
        two = render(self.NODE, [{"labels": ["Episode"], "count": 1, "dated": []},
                                 {"labels": ["ThoughtLeadership"], "count": 1, "dated": []}], [])
        self.assertIn("across Career and Podcast content", two)

    def test_time_span_and_latest(self):
        rows = [{"labels": ["Episode"], "count": 3, "dated": [
            {"name": "A", "date": "2023-04-01"}, {"name": "B", "date": "2025"}, {"name": "C", "date": "undated"}]}]
        self.assertIn("Its 2 dated connections run from 2023 to 2025; the most recent is 'B' (2025).",
                      render(self.NODE, rows, []))

    def test_shared_neighbours_most_specific_first(self):
        pairs = [pair("p1", "Project X", "NLP", s_degree=12), pair("p1", "Project X", "Attention", s_degree=3),
                 pair("p1", "Project X", "Transformers", s_degree=5)]
        self.assertIn("Shares 3 connections (Attention, Transformers, NLP) with Project 'Project X' in this view.",
                      render(self.NODE, [], pairs))

    def test_one_specific_shared_neighbour_is_a_sentence(self):
        self.assertIn("Shares 1 connection (ML) with Project 'Project X' in this view.",
                      render(self.NODE, [], [pair("p1", "Project X", "ML")]))

    def test_hubs_and_categories_are_not_counted(self):
        # Production case (design §3.3b): the founder hub and a Category section header.
        hub = reg.CONTEXT_HUB_DEGREE_THRESHOLD
        weak_only = [pair("p1", "InfoQ", "Sangeetha Ramadurai", s_degree=hub + 50, s_labels=["Person"]),
                     pair("p1", "InfoQ", "Thought Leadership & Community", s_labels=["Category"])]
        self.assertNotIn("Shares", render(self.NODE, [], weak_only))
        mixed = weak_only[:1] + [pair("p2", "Agents", "ML"),
                                 pair("p2", "Agents", "Thought Leadership & Community", s_labels=["Category"]),
                                 pair("p2", "Agents", "Sangeetha Ramadurai", s_degree=hub, s_labels=["Person"])]
        text = render(self.NODE, [], mixed)
        self.assertIn("Shares 1 connection (ML) with Project 'Agents' in this view.", text)
        self.assertNotIn("Sangeetha", text)
        self.assertNotIn("Thought Leadership & Community", text)

    def test_weak_on_screen_nodes_get_no_sentence(self):
        # Live case (design §3.3b): InfoQ "shares" its certification with a Category and the founder hub.
        hub = reg.CONTEXT_HUB_DEGREE_THRESHOLD
        pairs = [pair("c1", "Education & Continuous Learning", "[2026] InfoQ Certified Architect", ["Category"]),
                 dict(pair("h1", "Sangeetha Ramadurai", "[2026] InfoQ Certified Architect", ["Person"]), v_degree=hub)]
        self.assertNotIn("Shares", render(self.NODE, [], pairs))

    def test_where_it_sits_ignores_hubs(self):
        node = {"name": "Doc A", "labels": ["DocumentSource"]}
        hub = reg.CONTEXT_HUB_DEGREE_THRESHOLD
        pairs = [pair("d2", "Doc B", "NLP", ["DocumentSource"]), pair("d3", "Doc C", "NLP", ["DocumentSource"]),
                 pair("d2", "Doc B", "Founder", ["DocumentSource"], s_degree=hub),
                 pair("d3", "Doc C", "Founder", ["DocumentSource"], s_degree=hub),
                 pair("d4", "Doc D", "Founder", ["DocumentSource"], s_degree=hub),
                 pair("d2", "Doc B", "Section A", ["DocumentSource"], s_labels=["Category"]),
                 pair("d3", "Doc C", "Section A", ["DocumentSource"], s_labels=["Category"]),
                 pair("d4", "Doc D", "Section A", ["DocumentSource"], s_labels=["Category"])]
        text = render(node, [], pairs)
        self.assertIn("One of 3 DocumentSources in this view connected to 'NLP'.", text)
        self.assertNotIn("connected to 'Founder'", text)
        self.assertNotIn("connected to 'Section A'", text)

    def test_nothing_to_say_is_empty(self):
        self.assertEqual(render(self.NODE, [], []), "")

    def test_no_llm_in_the_summary_path(self):
        for fn in (ExpertTools._render_view_summary, ExpertTools._collect_view_summary_rows,
                   ExpertTools._compose_narrative):
            src = inspect.getsource(fn)
            self.assertNotIn("self.client", src)
            self.assertNotIn("chat.completions", src)


class CleanIdsTest(unittest.TestCase):
    def test_strings_only_deduped_capped(self):
        ids = ["a", "a", 3, None, "", {"x": 1}] + [f"n{i}" for i in range(reg.CONTEXT_VISIBLE_IDS_MAX + 5)]
        out = ExpertTools._clean_visible_ids(ids)
        self.assertEqual(out[0], "a")
        self.assertEqual(len(out), reg.CONTEXT_VISIBLE_IDS_MAX)
        self.assertTrue(all(isinstance(i, str) and i for i in out))

    def test_not_a_list(self):
        self.assertEqual(ExpertTools._clean_visible_ids("a,b"), [])
        self.assertEqual(ExpertTools._clean_visible_ids(None), [])


MEMBER = "user_view_summary_member"
OWNER = "user_view_summary_owner"
IDS = {"target": "vs-target", "a": "vs-shared-a", "b": "vs-shared-b", "seen": "vs-peer-seen", "hidden": "vs-peer-hidden"}
HIDDEN_NAME = "VS Hidden Peer Project"


@unittest.skipUnless(os.environ.get("NEO4J_URI"), "needs NEO4J_* in .env")
@mock.patch.dict(os.environ, {"OWNER_USER_ID": OWNER})
class VisibleIdsRecheckTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tools = ExpertTools(tenant_id=TEST_TENANT_ID)
        cleanup_test_tenant(cls.tools.driver)
        names = {"target": "VS Target Project", "a": "VS Concept A", "b": "VS Concept B",
                 "seen": "VS Seen Peer Project", "hidden": HIDDEN_NAME}
        labels = {"target": "Project", "a": "Concept", "b": "Concept", "seen": "Project", "hidden": "Project"}
        with cls.tools.driver.session() as s:
            for key, nid in IDS.items():
                s.run(f"CREATE (n:{labels[key]} {{tenant_id: $t, node_id: $id, name: $name}})",
                      t=TEST_TENANT_ID, id=nid, name=names[key])
            for peer in ("target", "seen", "hidden"):
                for c in ("a", "b"):
                    s.run("MATCH (p {node_id: $p, tenant_id: $t}), (c {node_id: $c, tenant_id: $t}) "
                          "CREATE (p)-[:USES_TOOL]->(c)", p=IDS[peer], c=IDS[c], t=TEST_TENANT_ID)
            # The hidden peer was added by another member: the tenant fallback does not reach it.
            s.run("MATCH (n {node_id: $id, tenant_id: $t}) SET n.owner_id = 'user_someone_else'",
                  id=IDS["hidden"], t=TEST_TENANT_ID)

    @classmethod
    def tearDownClass(cls):
        cleanup_test_tenant(cls.tools.driver)
        assert count_test_tenant_nodes(cls.tools.driver) == 0
        cls.tools.close()

    def summary(self, user, allowed, guest_anchor=""):
        t = ExpertTools.__new__(ExpertTools)
        t.driver, t.tenant_id, t.requesting_user_id, t.guest_share_anchor, t.allowed_ids = \
            self.tools.driver, TEST_TENANT_ID, user, guest_anchor, allowed
        visible = [IDS["seen"], IDS["hidden"], "forged-node-id"]
        return json.loads(t.get_node_details(node_id=IDS["target"], visible_node_ids=visible))[0]["panel_narrative"]

    def test_internal_call_sees_both_peers(self):
        text = self.summary("", None)
        self.assertIn("VS Seen Peer Project", text)
        self.assertIn(HIDDEN_NAME, text)

    def test_member_forged_id_is_dropped(self):
        allowed = [IDS["target"], IDS["a"], IDS["b"], IDS["seen"]]
        text = self.summary(MEMBER, allowed)
        self.assertIn("VS Seen Peer Project", text)
        self.assertNotIn(HIDDEN_NAME, text)
        self.assertNotIn("forged", text)

    def test_owner_does_not_see_another_members_node_via_the_list(self):
        self.assertNotIn(HIDDEN_NAME, self.summary(OWNER, []))

    def test_guest_link_forged_id_outside_scope_is_dropped(self):
        allowed = [IDS["target"], IDS["a"], IDS["b"], IDS["seen"]]
        text = self.summary("share_link:test", allowed, guest_anchor=IDS["target"])
        self.assertIn("VS Seen Peer Project", text)
        self.assertNotIn(HIDDEN_NAME, text)

    def test_counts_do_not_include_the_hidden_peer(self):
        # Concept A/B each link to target, seen and hidden; the member's count of target's own
        # neighbours is unaffected (2 Concepts), and nothing reveals a third Project.
        allowed = [IDS["target"], IDS["a"], IDS["b"], IDS["seen"]]
        self.assertIn("connects to 2 items you can see: 2 Concepts.", self.summary(MEMBER, allowed))


if __name__ == "__main__":
    unittest.main()
