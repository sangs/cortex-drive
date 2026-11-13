"""
Domain registry contract (Invariant 2, M5 step 1, 2026-10-26).

- The gateway mirror (cortex-gateway/config/domain_manifests.json) matches domain_registry.py.
- The `document` domain (Phase B M5) is not part of universal discovery (M5-6): domain="all" unions
  of anchors/backbone are unchanged by it.
- ContentBlock is hidden from the graph only for `document` (M5-8).
No network.
    .venv/bin/python -m unittest tests.mcp_server.test_domain_registry_contract -v
"""
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

import domain_registry as reg  # noqa: E402
from schema_guard import DOCUMENT_GRAPH_NODES, DOCUMENT_ENTITY_LABELS  # noqa: E402

GATEWAY = json.load(open(os.path.join(ROOT, "cortex-gateway", "config", "domain_manifests.json")))


class GatewayMirrorTest(unittest.TestCase):
    def test_document_mirror(self):
        self.assertEqual(set(GATEWAY["document"]["node_types"]), set(DOCUMENT_GRAPH_NODES) | set(DOCUMENT_ENTITY_LABELS))
        self.assertEqual(reg.DOMAIN_MANIFESTS["document"]["node_set"], list(DOCUMENT_GRAPH_NODES))

    def test_website_mirror(self):
        self.assertEqual(set(GATEWAY["website"]["node_types"]) >= set(reg.DOMAIN_MANIFESTS["website"]["node_set"]), True)

    def test_document_node_set_has_no_shared_entity_labels(self):
        # §1.3.5: shared entity labels never widen the document domain's Cypher scope
        self.assertFalse(set(reg.DOMAIN_MANIFESTS["document"]["node_set"]) & set(DOCUMENT_ENTITY_LABELS))


class BridgeSourceKindsTest(unittest.TestCase):
    """Bridge plan design 2026-11-13 §4.1 rule 3c, §4.3: kind words and limits, registry ↔ gateway mirror."""

    PLAN = json.load(open(os.path.join(ROOT, "cortex-gateway", "config", "bridge_plan.json")))

    def test_gateway_mirror(self):
        for domain, signal in reg.GATEWAY_DOMAIN_SIGNALS.items():
            self.assertEqual(GATEWAY[signal].get("bridge_source_kinds", {}), reg.get_bridge_source_kinds(domain), domain)

    def test_every_content_domain_has_kinds(self):
        self.assertEqual(sorted(reg.GATEWAY_DOMAIN_SIGNALS), sorted(reg.CONTENT_DOMAINS))
        for domain in reg.CONTENT_DOMAINS:
            self.assertTrue(reg.get_bridge_source_kinds(domain), domain)

    def test_labels_belong_to_the_domain_and_are_in_the_routing_catalog(self):
        for domain, signal in reg.GATEWAY_DOMAIN_SIGNALS.items():
            for word, labels in reg.get_bridge_source_kinds(domain).items():
                self.assertEqual(word, word.lower().strip(), word)
                self.assertTrue(labels, word)
                for label in labels:
                    self.assertIn(label, reg.DOMAIN_MANIFESTS[domain]["node_set"], f"{domain}:{word}")
                    self.assertIn(label, reg.ROUTING_NAME_LABELS[signal], f"{domain}:{word}")

    def test_a_kind_word_names_one_domain(self):
        seen = {}
        for domain in reg.GATEWAY_DOMAIN_SIGNALS:
            for word in reg.get_bridge_source_kinds(domain):
                self.assertNotIn(word, seen, f"{word}: {seen.get(word)} and {domain}")
                seen[word] = domain

    def test_existing_source_labels_are_covered(self):
        # `bridge_source_labels` (the model path) stays until the switch; its labels must be reachable by a kind word.
        for domain, manifest in reg.DOMAIN_MANIFESTS.items():
            kinds = {l for labels in reg.get_bridge_source_kinds(domain).values() for l in labels}
            self.assertTrue(set(manifest.get("bridge_source_labels", [])) <= kinds, domain)

    def test_limits_mirror(self):
        self.assertEqual(self.PLAN["max_sources"], reg.BRIDGE_PLAN_MAX_SOURCES)
        self.assertEqual(self.PLAN["source_deadline_ms"], reg.BRIDGE_PLAN_SOURCE_DEADLINE_MS)
        self.assertEqual(self.PLAN["clarify_max_options"], reg.BRIDGE_PLAN_CLARIFY_MAX_OPTIONS)
        self.assertGreater(reg.BRIDGE_PLAN_MAX_SOURCES, 0)


class UniversalDiscoveryTest(unittest.TestCase):
    def test_document_not_in_all_unions(self):
        for label in DOCUMENT_GRAPH_NODES:
            self.assertNotIn(label, reg.get_anchor_labels("all"))
            self.assertNotIn(label, reg.get_backbone_labels("all"))
        self.assertNotIn("DocumentSource", reg.DISCOVERY_LABELS)

    def test_all_unions_equal_the_pre_m5_domains(self):
        pre = [m for k, m in reg.DOMAIN_MANIFESTS.items() if k != "document"]
        self.assertEqual(set(reg.get_anchor_labels("all")), {l for m in pre for l in m.get("anchor_labels", [])})
        self.assertEqual(set(reg.get_backbone_labels("all")), {l for m in pre for l in m.get("backbone_labels", [])})

    def test_document_lookups(self):
        self.assertEqual(reg.get_anchor_labels("document"), ["DocumentSource", "Section"])
        self.assertEqual(reg.get_backbone_labels("document"), ["DocumentSource"])
        self.assertEqual(reg.get_authorized_labels("document"), list(DOCUMENT_GRAPH_NODES))


class VisualDenyListTest(unittest.TestCase):
    def test_content_block_hidden_only_for_document(self):
        self.assertIn("ContentBlock", reg.get_visual_deny_list("document"))
        for d in [None, "podcast", "professional", "website", "all"]:
            self.assertEqual(reg.get_visual_deny_list(d), reg.BRIDGE_LABELS)


class ProvenanceIsolationTest(unittest.TestCase):
    """M5-4 (design §1.3.5): shared-label nodes qualify for a single domain only by provenance."""

    def test_exclusive_labels(self):
        self.assertEqual(reg.get_exclusive_labels("podcast"), ["Chunk", "Episode", "Podcast", "Source"])
        self.assertEqual(reg.get_exclusive_labels("website"), ["SourceSnapshot", "WebsiteSource"])
        self.assertEqual(reg.get_exclusive_labels("document"), ["ContentBlock", "DocumentSource", "Section"])
        self.assertIn("Project", reg.get_exclusive_labels("professional"))
        for d in ("podcast", "professional", "website", "document"):
            ex = set(reg.get_exclusive_labels(d))
            self.assertFalse(ex & set(reg.SHARED_ENTITY_LABELS), d)
            self.assertFalse(ex & {"Category", "Technology", "Tool", "Concept", "Topic", "Institution", "Year"}, d)
        self.assertEqual(reg.get_exclusive_labels("all"), [])
        self.assertEqual(reg.get_exclusive_labels("federated"), [])

    def _main_query(self, domain):
        import re
        from unittest import mock
        from expert_tools import ExpertTools
        t = ExpertTools.__new__(ExpertTools)
        t.tenant_id, t.requesting_user_id, t.guest_share_anchor, t.allowed_ids = "org_x", "", "", None
        t.driver = mock.MagicMock()
        t.driver.execute_query.return_value = mock.MagicMock(records=[])
        t.get_embedding = mock.MagicMock(return_value=None)
        with mock.patch.dict(os.environ, {"OWNER_USER_ID": "user_owner"}):
            t.search_enterprise_graph("graph databases", domain_intent=domain)
        q, kw = t.driver.execute_query.call_args_list[0][0][0], t.driver.execute_query.call_args_list[0][1]
        return q, kw, set(re.findall(r"\$(\w+)", q))

    def test_single_domain_query_has_clause_and_params(self):  # AP-2
        q, kw, used = self._main_query("podcast")
        self.assertIn("EXISTS { MATCH (node)--(prov)", q)
        self.assertIn("EXISTS { MATCH (neighbor)--(prov)", q)
        self.assertEqual(kw["exclusive_labels"], ["Chunk", "Episode", "Podcast", "Source"])
        self.assertTrue({"shared_labels", "exclusive_labels"} <= used)
        self.assertEqual(used - set(kw), set())

    def test_universal_search_unchanged(self):
        q, kw, used = self._main_query("all")
        self.assertNotIn("(prov)", q)
        self.assertNotIn("exclusive_labels", kw)
        self.assertNotIn("shared_labels", kw)


if __name__ == "__main__":
    unittest.main()
