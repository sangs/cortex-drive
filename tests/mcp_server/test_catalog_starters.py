"""S2-102: routing catalog fields used by starter questions (src/mcp_server/entity_catalog.py), test tenant only.

- source entries carry `added` (YYYY-MM-DD) from last_synced_at / published_date, for newest-first suggestions;
- a website<->podcast bridge entity lists the sources on each side (`bridge_anchors`) with tier and owner, so the
  gateway can check the asker opens at least one per side (AP-30).
No Permify writes, no OpenAI. Deletes everything it creates.

    .venv/bin/python -m unittest tests.mcp_server.test_catalog_starters -v
"""
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

import entity_catalog  # noqa: E402

OWNER = "user_s2102OwnerTestAAAAAAAAAAAAAAAA"
TECH = "S2102 Starter Tech"


@unittest.skipUnless(os.environ.get("NEO4J_URI"), "needs NEO4J_* in .env")
class CatalogStarterFieldsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from neo4j_connection import create_driver
        cls.driver = create_driver()
        cleanup_test_tenant(cls.driver)
        cls.driver.execute_query(
            "CREATE (w:WebsiteSource {node_id: 's2102-web', name: 'S2102 Lakehouse Site', tenant_id: $t, owner_id: $o, "
            "        last_synced_at: datetime('2026-09-24T10:00:00Z')})-[:DISCUSSES]->"
            "       (:Technology {node_id: 's2102-tech-w', name: $tech, tenant_id: $t}) "
            "CREATE (e:Episode {node_id: 's2102-ep', name: 'S2102 Episode One', tenant_id: $t, owner_id: $o, "
            "        published_date: date('2025-08-14'), aired_date: '08/2025'})-[:HAS_TOPIC]->"
            "       (:Topic {node_id: 's2102-topic', name: 'S2102 Topic', tenant_id: $t})-[:COVERS_TECHNOLOGY]->"
            "       (:Technology {node_id: 's2102-tech-p', name: $tech, tenant_id: $t}) "
            "CREATE (:Episode {node_id: 's2102-ep-nodate', name: 'S2102 Episode Undated', tenant_id: $t, aired_date: '05/2025'})",
            t=TEST_TENANT_ID, o=OWNER, tech=TECH)
        cls.catalog = entity_catalog.build_entity_catalog(cls.driver, TEST_TENANT_ID)

    @classmethod
    def tearDownClass(cls):
        cleanup_test_tenant(cls.driver)
        assert count_test_tenant_nodes(cls.driver) == 0
        cls.driver.close()

    def entry(self, node_id):
        return next(e for e in self.catalog["entries"] if e["node_id"] == node_id)

    def test_added_dates(self):
        self.assertEqual(self.entry("s2102-web").get("added"), "2026-09-24", "website: last_synced_at")
        self.assertEqual(self.entry("s2102-ep").get("added"), "2025-08-14", "episode: published_date")
        self.assertNotIn("added", self.entry("s2102-ep-nodate"), "a date in another format is not ranked")

    def test_bridge_anchors(self):
        key = TECH.lower()
        self.assertEqual(self.catalog["bridge_entities"].get(key), ["website", "podcast"])
        anchors = self.catalog["bridge_anchors"][key]
        self.assertEqual([a["node_id"] for a in anchors["website"]], ["s2102-web"])
        self.assertEqual([a["node_id"] for a in anchors["podcast"]], ["s2102-ep"], "sources only, never the Topic")
        self.assertEqual((anchors["website"][0]["tier"], anchors["website"][0]["owner_id"]), ("org", OWNER))


if __name__ == "__main__":
    unittest.main()
