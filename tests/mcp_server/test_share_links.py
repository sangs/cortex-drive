"""
Unified shares phase 1 (2026-10-29): ExpertTools.share_roots and nodes_by_ids against the live Neo4j,
under the test tenant only (cleaned up before and after; no Permify writes, no OpenAI calls).

- share_roots: roots only (a node under another selected node is covered); SYSTEM/PUBLIC dropped;
  unknown (display-only) ids dropped; nodes another user added are flagged for a can_share check;
  total counts everything under the roots.
- nodes_by_ids: as a share link principal, only allowlisted + SYSTEM/PUBLIC nodes come back, with
  live fields and the relationships between them; nothing without an allowlist.

    .venv/bin/python -m unittest tests.mcp_server.test_share_links -v
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

from expert_tools import ExpertTools  # noqa: E402

SHARER = "user_share_links_test"
OTHER = "user_someone_else_test"
LINK = "share_link:00000000-0000-0000-0000-000000000001"


@unittest.skipUnless(os.environ.get("NEO4J_URI"), "needs NEO4J_* in .env")
class ShareLinksTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tools = ExpertTools(tenant_id=TEST_TENANT_ID)
        cleanup_test_tenant(cls.tools.driver)
        with cls.tools.driver.session() as s:
            s.run("""
                CREATE (r:ShareProbe {tenant_id: $t, node_id: 'sl-root', name: 'Root', description: 'v1', owner_id: $me})
                CREATE (c:ShareProbe {tenant_id: $t, node_id: 'sl-child', name: 'Child', owner_id: $me})
                CREATE (g:ShareProbe {tenant_id: $t, node_id: 'sl-grand', name: 'Grand', owner_id: $me})
                CREATE (x:ShareProbe {tenant_id: $t, node_id: 'sl-theirs', name: 'Theirs', owner_id: $other})
                CREATE (r)-[:HAS_SECTION]->(c)-[:HAS_BLOCK]->(g)
                CREATE (r)-[:RELATES_TO]->(x)
            """, t=TEST_TENANT_ID, me=SHARER, other=OTHER)
            rec = s.run("MATCH (n) WHERE n.tenant_id = 'PUBLIC' AND n.node_id IS NOT NULL RETURN n.node_id AS id LIMIT 1").single()
        cls.public_id = rec["id"] if rec else None

    @classmethod
    def tearDownClass(cls):
        cleanup_test_tenant(cls.tools.driver)
        assert count_test_tenant_nodes(cls.tools.driver) == 0
        cls.tools.close()

    def test_roots_only_and_drops(self):
        ids = ["sl-root", "sl-child", "sl-grand", "grouper-xyz"] + ([self.public_id] if self.public_id else [])
        r = self.tools.share_roots(ids, owner_id=SHARER)
        self.assertEqual(r["roots"], ["sl-root"])
        self.assertEqual(sorted(r["covered"]), ["sl-child", "sl-grand"])
        self.assertEqual(r["unknown"], ["grouper-xyz"])
        if self.public_id:
            self.assertEqual(r["everyone"], [self.public_id])
        self.assertEqual(r["total_nodes"], 3)   # root + child + grand (RELATES_TO is not composition)

    def test_other_users_node_flagged(self):
        r = self.tools.share_roots(["sl-root", "sl-theirs"], owner_id=SHARER)
        self.assertEqual(r["others"], ["sl-theirs"])
        self.assertEqual(sorted(r["roots"]), ["sl-root", "sl-theirs"])

    def _as_link(self, allowed):
        t = ExpertTools.__new__(ExpertTools)
        t.driver, t.tenant_id, t.requesting_user_id, t.guest_share_anchor, t.allowed_ids = \
            self.tools.driver, TEST_TENANT_ID, LINK, "", allowed
        return t

    def test_nodes_by_ids_respects_the_link_allowlist(self):
        g = self._as_link(["sl-root", "sl-child"]).nodes_by_ids(["sl-root", "sl-child", "sl-grand", "sl-theirs"])
        self.assertEqual(sorted(n["node_id"] for n in g["nodes"]), ["sl-child", "sl-root"])
        self.assertEqual([l["type"] for l in g["links"]], ["HAS_SECTION"])
        self.assertIn(next(n for n in g["nodes"] if n["node_id"] == "sl-root")["description"], ("v1", "v2"))

    def test_nodes_by_ids_is_live(self):
        with self.tools.driver.session() as s:
            s.run("MATCH (n {tenant_id: $t, node_id: 'sl-root'}) SET n.description = 'v2'", t=TEST_TENANT_ID)
        g = self._as_link(["sl-root"]).nodes_by_ids(["sl-root"])
        self.assertEqual(g["nodes"][0]["description"], "v2")

    def test_nodes_by_ids_fails_closed(self):
        self.assertEqual(self._as_link(None).nodes_by_ids(["sl-root"])["nodes"], [])
        self.assertEqual(self._as_link([]).nodes_by_ids(["sl-root"])["nodes"], [])


if __name__ == "__main__":
    unittest.main()
