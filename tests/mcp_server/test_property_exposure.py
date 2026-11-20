"""
S2-98 (2026-11-20): which node properties each caller gets back
(documents/security/node-property-exposure-design-2026-11-20.md).

Found 2026-11-20: a share-link viewer clicking the founder's PUBLIC Person node got email, linkedin, owner_id and the
1,536-number metadata_embedding from get_node_details. Now vectors are never returned, and everyone except the
tenant owner / internal calls gets only schema_guard.SHARED_VIEW_PROPERTY_ALLOWLIST.

Part 1 is pure (no network). Part 2 runs get_node_details and expand_node_topology against the live Neo4j under the
test tenant only (cleaned up before and after; no Permify writes, no OpenAI calls).

    .venv/bin/python -m unittest tests.mcp_server.test_property_exposure -v
"""
import os
import sys
import json
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

from tests.test_tenant import TEST_TENANT_ID, use_test_tenant, cleanup_test_tenant, count_test_tenant_nodes  # noqa: E402
use_test_tenant()

from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(ROOT, ".env"))

from property_policy import visible_properties  # noqa: E402
from schema_guard import SHARED_VIEW_PROPERTY_ALLOWLIST  # noqa: E402

OWNER = "user_property_exposure_owner"
MEMBER = "user_property_exposure_member"
SECRET = ("email", "phone", "linkedin", "owner_id", "tenant_id", "revision_id", "content_hash",
          "employer_source", "metadata_embedding", "embedding", "episodeFastRPEmbedding", "simple_embedding")
PERSON = {
    "node_id": "s298-person", "name": "S298 Probe Person", "description": "A probe person.", "bio": "Bio text.",
    "location": "Somewhere", "url": "https://example.com/p", "email": "probe@example.com", "phone": "+1 555 0100",
    "linkedin": "https://linkedin.example/in/probe", "owner_id": OWNER, "revision_id": "r1", "content_hash": "h",
    "employer_source": "curation:x", "metadata_embedding": [0.1, 0.2], "embedding": [0.3], "simple_embedding": [0.4],
    "episodeFastRPEmbedding": [0.5],
}


class PolicyTest(unittest.TestCase):
    def test_non_owner_gets_only_the_allowlist(self):
        got = visible_properties({**PERSON, "tenant_id": "PUBLIC"}, full_access=False)
        self.assertTrue(set(got) <= SHARED_VIEW_PROPERTY_ALLOWLIST)
        for key in SECRET:
            self.assertNotIn(key, got)
        self.assertEqual(got["name"], "S298 Probe Person")
        self.assertEqual(got["bio"], "Bio text.")

    def test_unknown_future_property_is_hidden_from_non_owners(self):
        self.assertEqual(visible_properties({"name": "x", "salary_band": "L7"}, False), {"name": "x"})

    def test_owner_keeps_everything_but_vectors(self):
        got = visible_properties({**PERSON, "tenant_id": "PUBLIC"}, full_access=True)
        for key in ("email", "linkedin", "owner_id", "tenant_id", "employer_source"):
            self.assertIn(key, got)
        for key in ("metadata_embedding", "embedding", "simple_embedding", "episodeFastRPEmbedding"):
            self.assertNotIn(key, got)

    def test_bad_input(self):
        self.assertEqual(visible_properties(None, False), {})
        self.assertEqual(visible_properties(None, True), {})

    def test_allowlist_has_no_contact_or_bookkeeping_keys(self):
        for key in SECRET:
            self.assertNotIn(key, SHARED_VIEW_PROPERTY_ALLOWLIST)


@unittest.skipUnless(os.environ.get("NEO4J_URI"), "needs NEO4J_* in .env")
@mock.patch.dict(os.environ, {"OWNER_USER_ID": OWNER})
class LiveExposureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from expert_tools import ExpertTools
        cls.ExpertTools = ExpertTools
        cls.base = ExpertTools(tenant_id=TEST_TENANT_ID)
        cleanup_test_tenant(cls.base.driver)
        with cls.base.driver.session() as s:
            s.run("CREATE (p:Person) SET p = $props, p.tenant_id = $t "
                  "CREATE (c:Project {node_id: 's298-project', name: 'S298 Probe Project', tenant_id: $t, "
                  "                   owner_id: $owner, metadata_embedding: [0.9], email: 'x@example.com'}) "
                  "CREATE (p)-[:CURRENTLY_BUILDING]->(c)",
                  props=PERSON, t=TEST_TENANT_ID, owner=OWNER)

    @classmethod
    def tearDownClass(cls):
        cleanup_test_tenant(cls.base.driver)
        assert count_test_tenant_nodes(cls.base.driver) == 0
        cls.base.close()

    def tools(self, user, allowed, guest_anchor=""):
        return self.ExpertTools(tenant_id=TEST_TENANT_ID, requesting_user_id=user,
                                guest_share_anchor=guest_anchor, allowed_ids=allowed)

    def details(self, tools):
        out = json.loads(tools.get_node_details(node_id="s298-person"))
        self.assertIsInstance(out, list, out)
        return out[0]["properties"]

    def test_share_link_viewer(self):
        props = self.details(self.tools("share_link:s298", ["s298-person"]))
        for key in SECRET:
            self.assertNotIn(key, props)
        self.assertEqual((props["name"], props["description"]), ("S298 Probe Person", "A probe person."))

    def test_member(self):
        props = self.details(self.tools(MEMBER, ["s298-person"]))
        for key in SECRET:
            self.assertNotIn(key, props)

    def test_owner(self):
        props = self.details(self.tools(OWNER, None))
        self.assertEqual(props["email"], "probe@example.com")
        self.assertNotIn("metadata_embedding", props)

    def test_expand_neighbours_for_a_member(self):
        rows = json.loads(self.tools(MEMBER, ["s298-person", "s298-project"]).expand_node_topology(node_id="s298-person"))
        self.assertTrue(rows, "the probe project is a neighbour")
        for row in rows:
            for key in SECRET:
                self.assertNotIn(key, row["Details"])

    def test_expand_neighbours_for_the_owner(self):
        rows = json.loads(self.tools(OWNER, None).expand_node_topology(node_id="s298-person"))
        self.assertTrue(rows)
        self.assertTrue(all("metadata_embedding" not in r["Details"] for r in rows))
        self.assertTrue(any(r["Details"].get("email") == "x@example.com" for r in rows))


if __name__ == "__main__":
    unittest.main()
