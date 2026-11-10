"""
Search exclusion rule (cross-domain discovery design 2026-11-09 §4.4, Invariant 7).

In single-domain search_enterprise_graph, a node (match or neighbour) carrying a label exclusive to another
content domain and none of this domain's own is excluded at the query — the gateway domain guard stays a
safety net only. Same rule as bridges (classify_bridge_candidate).

Unit tests need no database. The live class is read-only (internal whole-tenant call) and is skipped
without NEO4J_* in .env.

    .venv/bin/python -m unittest tests.mcp_server.test_search_exclusion -v
"""
import json
import os
import re
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(ROOT, ".env"))

import domain_registry as reg  # noqa: E402


class OtherExclusiveLabelsTest(unittest.TestCase):
    def test_union_of_the_other_domains_exclusive_labels(self):
        for d in reg.CONTENT_DOMAINS:
            expected = set().union(*(reg.get_exclusive_labels(o) for o in reg.CONTENT_DOMAINS if o != d))
            self.assertEqual(set(reg.get_other_exclusive_labels(d)), expected - set(reg.get_exclusive_labels(d)), d)

    def test_never_includes_own_or_shared_labels(self):
        for d in reg.CONTENT_DOMAINS:
            other = set(reg.get_other_exclusive_labels(d))
            self.assertFalse(other & set(reg.get_exclusive_labels(d)), d)
            self.assertFalse(other & set(reg.SHARED_ENTITY_LABELS), d)

    def test_career_labels_are_other_for_podcast(self):
        self.assertIn("ThoughtLeadership", reg.get_other_exclusive_labels("podcast"))
        self.assertNotIn("Episode", reg.get_other_exclusive_labels("podcast"))

    def test_non_content_domains_have_none(self):
        for d in ("all", "", None, "cross_domain", "career"):
            self.assertEqual(reg.get_other_exclusive_labels(d), [], d)

    def test_bridge_rule_unchanged(self):
        # classify_bridge_candidate now uses the same helper; its verdicts must not change.
        self.assertEqual(reg.classify_bridge_candidate(["Publication", "ThoughtLeadership"], "podcast"), "no")
        self.assertEqual(reg.classify_bridge_candidate(["Episode"], "podcast"), "yes")
        self.assertEqual(reg.classify_bridge_candidate(["Technology"], "podcast"), "provenance")


def _matches(labels, domain):
    """Python mirror of the Cypher exclusion condition (for the unit test of the rule's logic)."""
    labels = set(labels)
    return not (labels & set(reg.get_other_exclusive_labels(domain)) and not labels & set(reg.get_exclusive_labels(domain)))


class ExclusionLogicTest(unittest.TestCase):
    def test_other_domain_content_is_excluded(self):
        self.assertFalse(_matches(["Publication", "ThoughtLeadership"], "podcast"))
        self.assertFalse(_matches(["WebsiteSource"], "podcast"))
        self.assertFalse(_matches(["Episode"], "professional"))

    def test_own_and_dual_labelled_content_is_kept(self):
        self.assertTrue(_matches(["Episode"], "podcast"))
        self.assertTrue(_matches(["Episode", "ThoughtLeadership"], "podcast"))   # a talk that is also an episode

    def test_shared_and_unlabelled_types_are_left_to_the_provenance_rule(self):
        for labels in (["Technology"], ["Person", "Embeddable"], ["Publication"], ["Concept"]):
            self.assertTrue(_matches(labels, "podcast"), labels)


class ClauseTest(unittest.TestCase):
    """The clause and its parameters (Invariant 4 / AP-2: every parameter is referenced)."""

    @classmethod
    def setUpClass(cls):
        from expert_tools import ExpertTools
        cls.ExpertTools = ExpertTools
        cls.tools = ExpertTools.__new__(ExpertTools)   # no driver: clause building only

    def test_clause_references_every_parameter(self):
        clause = self.tools._provenance_clause("node", "podcast")
        params = self.tools._provenance_params("podcast")
        self.assertEqual(set(params), {"shared_labels", "exclusive_labels", "other_exclusive_labels"})
        for p in params:
            self.assertIn(f"${p}", clause, p)
        self.assertIn("$other_exclusive_labels", clause)

    def test_all_and_unknown_domains_unchanged(self):
        for d in ("all", "career", "unknown"):
            self.assertEqual(self.tools._provenance_clause("node", d), "", d)
            self.assertEqual(self.tools._provenance_params(d), {}, d)

    def test_applied_to_matches_and_neighbours(self):
        src = open(os.path.join(ROOT, "src", "mcp_server", "expert_tools.py")).read()
        self.assertIn('self._provenance_clause("node", domain_intent)', src)
        self.assertIn('self._fragment_neighbor_aggregation(self._provenance_clause("neighbor", domain_intent))', src)


@unittest.skipUnless(os.environ.get("NEO4J_URI"), "needs NEO4J_* in .env")
class LiveSearchExclusionTest(unittest.TestCase):
    """Read-only, internal (whole-tenant) call: the query itself returns no other-domain content."""

    @classmethod
    def setUpClass(cls):
        from expert_tools import ExpertTools
        cls.tools = ExpertTools(tenant_id=os.environ.get("TENANT_ID", ""))

    @classmethod
    def tearDownClass(cls):
        cls.tools.close()

    def search(self, keyword, domain):
        return json.loads(self.tools.search_enterprise_graph(keyword=keyword, domain_intent=domain)).get("nodes", [])

    def labels_of(self, nodes):
        """Search output carries only the primary `type`, so read every returned node's full labels."""
        ids = [n["node_id"] for n in nodes if n.get("node_id")]
        self.assertEqual(len(ids), len(nodes), "every returned node has a node_id")
        rows = self.tools._exec_query("MATCH (n) WHERE n.node_id IN $ids RETURN n.node_id AS id, labels(n) AS labels",
                                      ids=ids).records
        return {r["id"]: set(r["labels"]) for r in rows}

    def assert_no_other_domain_content(self, nodes, domain):
        own, other = set(reg.get_exclusive_labels(domain)), set(reg.get_other_exclusive_labels(domain))
        labels = self.labels_of(nodes)
        leaked = [(n.get("name"), sorted(labels.get(n["node_id"], ()))) for n in nodes
                  if labels.get(n["node_id"], set()) & other and not labels.get(n["node_id"], set()) & own]
        self.assertEqual(leaked, [], f"{domain}: other-domain content returned by the query")

    def test_podcast_graph_databases_has_no_career_items(self):
        nodes = self.search("graph databases", "podcast")
        self.assertTrue(nodes, "podcast search returned nothing")
        self.assert_no_other_domain_content(nodes, "podcast")

    def test_podcast_thought_leadership_words_have_no_career_items(self):
        # The InfoQ / Ignite items were the 2026-11-03 leak; search their own words in podcast.
        for kw in ("architectural shifts", "ignite", "platform engineers"):
            self.assert_no_other_domain_content(self.search(kw, "podcast"), "podcast")

    def test_professional_search_has_no_podcast_items(self):
        self.assert_no_other_domain_content(self.search("graph databases", "professional"), "professional")


if __name__ == "__main__":
    unittest.main()
