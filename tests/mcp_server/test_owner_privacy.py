"""
Private is private, including from the platform owner (2026-10-28; roles doc §4, Invariant 13).

Against the live Neo4j, under the test tenant only (cleaned up before and after; no Permify writes,
no OpenAI calls):
- IngestionEngine._stamp_owner stamps who added a source on the nodes it just created.
- The owner's security clause (tenant fallback) skips nodes another user added, unless Permify
  allows them; nodes with no owner_id and the owner's own stay visible; internal calls see the tenant.
- A member sees only what Permify allows.
- nodes_in_tenant: the owner may not manage (share) another user's nodes.

    .venv/bin/python -m unittest tests.mcp_server.test_owner_privacy -v
"""
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

from expert_tools import ExpertTools  # noqa: E402
from ingestion_engine import IngestionEngine  # noqa: E402

OWNER = "user_owner_privacy_test"
MEMBER = "user_member_privacy_test"
NODES = {  # node_id: owner_id written at creation (None = created before 2026-10-28, i.e. the owner's)
    "priv-legacy": None,
    "priv-owner": OWNER,
    "priv-member-doc": MEMBER,
}
BLOCK = "priv-member-block"   # created without owner_id, then stamped by _stamp_owner


@unittest.skipUnless(os.environ.get("NEO4J_URI"), "needs NEO4J_* in .env")
@mock.patch.dict(os.environ, {"OWNER_USER_ID": OWNER})
class OwnerPrivacyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tools = ExpertTools(tenant_id=TEST_TENANT_ID)
        cleanup_test_tenant(cls.tools.driver)
        with cls.tools.driver.session() as s:
            for nid, owner in NODES.items():
                s.run("CREATE (n:PrivacyProbe {tenant_id: $t, node_id: $id}) SET n.owner_id = $owner",
                      t=TEST_TENANT_ID, id=nid, owner=owner)
            s.run("CREATE (n:PrivacyProbe {tenant_id: $t, node_id: $id})", t=TEST_TENANT_ID, id=BLOCK)
        engine = IngestionEngine.__new__(IngestionEngine)
        engine.driver, engine.tenant_id, engine.owner_id = cls.tools.driver, TEST_TENANT_ID, MEMBER
        engine._stamp_owner([BLOCK, None])

    @classmethod
    def tearDownClass(cls):
        cleanup_test_tenant(cls.tools.driver)
        assert count_test_tenant_nodes(cls.tools.driver) == 0
        cls.tools.close()

    def visible(self, user, allowed):
        t = ExpertTools.__new__(ExpertTools)
        t.driver, t.tenant_id, t.requesting_user_id, t.guest_share_anchor, t.allowed_ids = \
            self.tools.driver, TEST_TENANT_ID, user, "", allowed
        q = f"MATCH (n:PrivacyProbe) WHERE n.tenant_id = $tenant_id AND {t._get_security_clause('n')} RETURN n.node_id AS id"
        params = {**t._security_params(), "tenant_id": TEST_TENANT_ID}
        return {r["id"] for r in t._exec_query(q, **params).records}

    def test_stamp_owner_marks_new_structure_nodes(self):
        with self.tools.driver.session() as s:
            self.assertEqual(s.run("MATCH (n {tenant_id: $t, node_id: $id}) RETURN n.owner_id AS o",
                                   t=TEST_TENANT_ID, id=BLOCK).single()["o"], MEMBER)

    def test_owner_does_not_see_a_members_private_nodes(self):
        self.assertEqual(self.visible(OWNER, []), {"priv-legacy", "priv-owner"})
        self.assertEqual(self.visible(OWNER, None), {"priv-legacy", "priv-owner"})   # Permify down: still not

    def test_owner_sees_them_once_shared(self):
        self.assertEqual(self.visible(OWNER, ["priv-member-doc", BLOCK]),
                         {"priv-legacy", "priv-owner", "priv-member-doc", BLOCK})

    def test_member_sees_only_what_permify_allows(self):
        self.assertEqual(self.visible(MEMBER, ["priv-member-doc", BLOCK]), {"priv-member-doc", BLOCK})
        self.assertEqual(self.visible(MEMBER, []), set())

    def test_internal_calls_keep_the_whole_tenant(self):
        self.assertEqual(self.visible("", None), set(NODES) | {BLOCK})

    def test_owner_cannot_manage_a_members_nodes(self):
        own = self.tools.nodes_in_tenant(list(NODES) + [BLOCK], owner_id=OWNER)
        self.assertEqual(set(own["own"]), {"priv-legacy", "priv-owner"})
        self.assertEqual(own["everyone"], [])


if __name__ == "__main__":
    unittest.main()
