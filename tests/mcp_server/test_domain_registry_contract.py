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


if __name__ == "__main__":
    unittest.main()
