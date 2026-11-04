"""
Bento panel layouts chosen by the server (bridge-discovery-and-bento-panel-design-2026-11-03.md §4.2).

- Layout per node type: a document gets the document layout, an episode the podcast layout, a Company
  its override, an unknown or shared-only type the default.
- Every section id in the config has a renderer in the panel, and the reverse (PANEL_SECTION_IDS equals
  the keys of PANEL_SECTIONS in BentoDetailPanel.tsx).
- get_node_details returns panel_layout (and a document's outline) against the live graph (read-only).

    .venv/bin/python -m unittest tests.mcp_server.test_panel_layout -v
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

PANEL = open(os.path.join(ROOT, "cortex-chat-ui", "components", "BentoDetailPanel.tsx")).read()


def chosen(labels):
    return reg.get_panel_layout(labels)["layout"]


def section_ids(labels):
    return [s["id"] for s in reg.get_panel_layout(labels)["sections"]]


class LayoutChoiceTest(unittest.TestCase):
    def test_by_domain_from_the_node_labels(self):
        self.assertEqual(chosen(["DocumentSource"]), "domain:document")
        self.assertEqual(chosen(["Episode"]), "domain:podcast")
        self.assertEqual(chosen(["WebsiteSource"]), "domain:website")
        self.assertEqual(chosen(["Publication", "ThoughtLeadership", "Embeddable"]), "domain:professional")

    def test_type_overrides_come_first(self):
        self.assertEqual(chosen(["Company", "Embeddable"]), "type:Company")
        self.assertEqual(chosen(["Podcast"]), "type:Podcast")
        self.assertEqual(chosen(["Category"]), "type:Category")

    def test_shared_and_unknown_types_get_the_default(self):
        for labels in (["Technology"], ["Concept"], ["Person"], ["Publication"], ["SomethingNew"], []):
            self.assertEqual(chosen(labels), "default", labels)

    def test_document_layout_is_not_the_career_layout(self):
        doc = section_ids(["DocumentSource"])
        self.assertIn("source_document", doc)
        self.assertIn("sections_outline", doc)
        self.assertNotIn("tech_stack", doc)
        self.assertNotIn("timeline", doc)

    def test_returns_a_copy(self):
        reg.get_panel_layout(["Episode"])["sections"].clear()
        self.assertTrue(section_ids(["Episode"]))

    def test_every_layout_uses_known_sections_once(self):
        layouts = [reg.PANEL_LAYOUTS["default"], *reg.PANEL_LAYOUTS["domains"].values(),
                   *reg.PANEL_LAYOUTS["types"].values()]
        for layout in layouts:
            ids = [s["id"] for s in layout["sections"]]
            self.assertEqual(len(ids), len(set(ids)), ids)
            self.assertTrue(set(ids) <= set(reg.PANEL_SECTION_IDS), set(ids) - set(reg.PANEL_SECTION_IDS))
            self.assertTrue(layout.get("primary_action"))

    def test_layout_domains_are_content_domains(self):
        self.assertTrue(set(reg.PANEL_LAYOUTS["domains"]) <= set(reg.CONTENT_DOMAINS))


class PanelRenderersTest(unittest.TestCase):
    def test_section_ids_equal_panel_renderers(self):
        block = PANEL[PANEL.index("const PANEL_SECTIONS"):]
        block = block[:block.index("\n    };\n")]
        renderers = set(re.findall(r"^\s{8}'([a-z_]+)': \(title\)", block, re.M))
        self.assertEqual(renderers, set(reg.PANEL_SECTION_IDS))


@unittest.skipUnless(os.environ.get("NEO4J_URI"), "needs NEO4J_* in .env")
class NodeDetailsLayoutTest(unittest.TestCase):
    """Read-only, as an internal (whole-tenant) call."""

    @classmethod
    def setUpClass(cls):
        from expert_tools import ExpertTools
        cls.tools = ExpertTools(tenant_id=os.environ.get("TENANT_ID", ""))

    @classmethod
    def tearDownClass(cls):
        cls.tools.close()

    def details(self, label):
        rec = self.tools._exec_query(f"MATCH (n:{label}) RETURN n.node_id AS id LIMIT 1").records
        if not rec:
            self.skipTest(f"no {label} node")
        return json.loads(self.tools.get_node_details(node_id=rec[0]["id"]))[0]

    def test_document_gets_its_layout_and_outline(self):
        d = self.details("DocumentSource")
        self.assertEqual(d["panel_layout"]["layout"], "domain:document")
        self.assertIn("outline", d)
        self.assertLessEqual(len(d["outline"]["sections"]), reg.PANEL_OUTLINE_MAX)
        self.assertTrue(all(s["level"] >= reg.PANEL_OUTLINE_MIN_LEVEL for s in d["outline"]["sections"]))

    def test_episode_gets_the_podcast_layout_and_no_outline(self):
        d = self.details("Episode")
        self.assertEqual(d["panel_layout"]["layout"], "domain:podcast")
        self.assertNotIn("outline", d)


if __name__ == "__main__":
    unittest.main()
