"""S2-50: src/mcp_server/ownership.py (Bento /owner_ids, /owned_nodes, /transfer_owner) against the test tenant only.

Creates nodes under TEST_TENANT_ID owned by a made-up departed id, moves them to a made-up steward and checks:
the owner changes, the former owner's name and the transfer id are kept on each node, the tier never changes,
no node or relationship is created, a second run changes nothing, other people's nodes are untouched, and
refusals (no from id, steward = same person, SYSTEM/PUBLIC target) write nothing. No Permify writes, no OpenAI.

    .venv/bin/python -m unittest tests.mcp_server.test_ownership_transfer -v
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

import ownership  # noqa: E402

GONE = "user_s250GoneTestAAAAAAAAAAAAAAAAAA"
STEWARD = "user_s250StewardTestBBBBBBBBBBBBBB"
OTHER = "user_s250OtherTestCCCCCCCCCCCCCCCCC"


@unittest.skipUnless(os.environ.get("NEO4J_URI"), "needs NEO4J_* in .env")
class OwnershipTransferTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from neo4j_connection import create_driver
        cls.driver = create_driver()

    @classmethod
    def tearDownClass(cls):
        cleanup_test_tenant(cls.driver)
        assert count_test_tenant_nodes(cls.driver) == 0
        cls.driver.close()

    def setUp(self):
        cleanup_test_tenant(self.driver)
        self.driver.execute_query(
            "CREATE (:WebsiteSource {node_id: 's250-src', tenant_id: $t, owner_id: $gone})-[:CONTAINS]->"
            "(:Section {node_id: 's250-sec', tenant_id: $t, owner_id: $gone}) "
            "CREATE (:WebsiteSource {node_id: 's250-legacy', tenant_id: $t}) "
            "CREATE (:WebsiteSource {node_id: 's250-other', tenant_id: $t, owner_id: $other})",
            t=TEST_TENANT_ID, gone=GONE, other=OTHER)

    def props(self, node_id):
        records, _, _ = self.driver.execute_query("MATCH (n {node_id: $id}) RETURN properties(n) AS p", id=node_id)
        return records[0]["p"]

    def shape(self):
        records, _, _ = self.driver.execute_query(
            "MATCH (n {tenant_id: $t}) OPTIONAL MATCH (n)-[r]->() RETURN count(DISTINCT n) AS n, count(r) AS r", t=TEST_TENANT_ID)
        return records[0]["n"], records[0]["r"]

    def test_owner_ids_and_owned_nodes(self):
        self.assertIn(GONE, ownership.owner_ids(self.driver))
        owned = ownership.owned_nodes(self.driver, GONE, ["s250-legacy"])
        self.assertEqual(sorted(n["node_id"] for n in owned), ["s250-legacy", "s250-sec", "s250-src"],
                         "owner_id matches plus Permify-only owner nodes")
        self.assertTrue(all(n["tenant_id"] == TEST_TENANT_ID for n in owned))

    def test_transfer(self):
        before = self.shape()
        ids = ["s250-src", "s250-sec", "s250-legacy", "s250-other"]   # s250-other is someone else's: must not move
        changed = ownership.transfer_owner(self.driver, GONE, [
            {"tenant_id": TEST_TENANT_ID, "to_sub": STEWARD, "transfer_id": "t-1", "from_name": "Ada L", "node_ids": ids}])
        self.assertEqual(sorted(changed[TEST_TENANT_ID]), ["s250-legacy", "s250-sec", "s250-src"])
        p = self.props("s250-src")
        self.assertEqual((p["owner_id"], p["transferred_from_sub"], p["transferred_from_name"], p["transfer_id"], p["tenant_id"]),
                         (STEWARD, GONE, "Ada L", "t-1", TEST_TENANT_ID))
        self.assertIn("transferred_at", p)
        self.assertEqual(self.props("s250-other")["owner_id"], OTHER, "another person's node untouched")
        self.assertEqual(self.shape(), before, "no node or relationship created")
        again = ownership.transfer_owner(self.driver, GONE, [
            {"tenant_id": TEST_TENANT_ID, "to_sub": STEWARD, "transfer_id": "t-2", "from_name": "Ada L", "node_ids": ids}])
        self.assertEqual(again[TEST_TENANT_ID], [], "second run changes nothing")
        self.assertEqual(self.props("s250-src")["transfer_id"], "t-1")

    def test_node_tenants(self):
        self.assertEqual(ownership.node_tenants(self.driver, ["s250-src", "s250-other", "no-such-node", ""]),
                         {"s250-src": TEST_TENANT_ID, "s250-other": TEST_TENANT_ID})
        self.assertEqual(ownership.node_tenants(self.driver, []), {})

    def test_refusals(self):
        for bad_from, t in [("", {"tenant_id": TEST_TENANT_ID, "to_sub": STEWARD}),
                            (GONE, {"tenant_id": TEST_TENANT_ID, "to_sub": GONE}),
                            (GONE, {"tenant_id": "PUBLIC", "to_sub": STEWARD}),
                            (GONE, {"tenant_id": "", "to_sub": STEWARD})]:
            with self.assertRaises(ValueError):
                ownership.transfer_owner(self.driver, bad_from, [{**t, "node_ids": ["s250-src"]}])
        self.assertEqual(self.props("s250-src")["owner_id"], GONE, "nothing written on refusal")
        with self.assertRaises(ValueError):
            ownership.owned_nodes(self.driver, "")


@unittest.skipUnless(os.environ.get("NEO4J_URI"), "needs NEO4J_* in .env")
class StewardReviewTest(unittest.TestCase):
    """S2-50 §3b: list, keep and delete a transfer's sources; in-review content stays out of the steward's chat."""
    TID = "t-review"

    @classmethod
    def setUpClass(cls):
        from neo4j_connection import create_driver
        cls.driver = create_driver()

    @classmethod
    def tearDownClass(cls):
        cleanup_test_tenant(cls.driver)
        assert count_test_tenant_nodes(cls.driver) == 0
        cls.driver.close()

    def setUp(self):
        cleanup_test_tenant(self.driver)
        self.driver.execute_query("MATCH (n:Concept {node_id: 'rv-system'}) DETACH DELETE n")
        tr = "tenant_id: $t, owner_id: $steward, transfer_id: $tid, transferred_from_sub: $gone, transferred_from_name: 'Ada L'"
        self.driver.execute_query(
            f"CREATE (w1:WebsiteSource {{node_id: 'rv-w1', name: 'Site One', {tr}}}) "
            f"CREATE (w2:WebsiteSource {{node_id: 'rv-w2', name: 'Site Two', {tr}}}) "
            f"CREATE (snap:SourceSnapshot {{node_id: 'rv-snap', {tr}}}) "
            f"CREATE (tech:Technology {{node_id: 'rv-tech', name: 'RV Tech', {tr}}}) "
            f"CREATE (shared:Concept {{node_id: 'rv-shared', name: 'RV Shared', {tr}}}) "
            "CREATE (ep:Episode {node_id: 'rv-own-ep', name: 'Steward Episode', tenant_id: $t, owner_id: $steward}) "
            "CREATE (sys:Concept {node_id: 'rv-system', name: 'RV System Concept', tenant_id: 'SYSTEM'}) "
            "CREATE (w1)-[:HAS_SNAPSHOT]->(snap), (w1)-[:DISCUSSES]->(tech), (ep)-[:COVERS_TECHNOLOGY]->(tech), "
            "       (w1)-[:DISCUSSES]->(shared), (w2)-[:DISCUSSES]->(shared), (w1)-[:DISCUSSES]->(sys)",
            t=TEST_TENANT_ID, steward=STEWARD, tid=self.TID, gone=GONE)

    def tearDown(self):
        self.driver.execute_query("MATCH (n:Concept {node_id: 'rv-system'}) DETACH DELETE n")

    def ids(self):
        records, _, _ = self.driver.execute_query(
            "MATCH (n) WHERE n.tenant_id = $t OR n.node_id = 'rv-system' RETURN n.node_id AS id", t=TEST_TENANT_ID)
        return sorted(r["id"] for r in records)

    def test_items(self):
        items = ownership.transfer_items(self.driver, STEWARD, self.TID, TEST_TENANT_ID)
        self.assertEqual([(s["node_id"], s["type"], s["nodes"]) for s in items["sources"]],
                         [("rv-w1", "WebsiteSource", 4), ("rv-w2", "WebsiteSource", 2)])
        self.assertEqual(items["total_nodes"], 5)
        with self.assertRaises(ValueError):
            ownership.transfer_items(self.driver, STEWARD, self.TID, "SYSTEM")
        self.assertEqual(ownership.transfer_items(self.driver, OTHER, self.TID, TEST_TENANT_ID)["total_nodes"], 0,
                         "another person sees nothing of it")

    def test_delete_keeps_what_others_use(self):
        out = ownership.delete_transferred_sources(self.driver, STEWARD, self.TID, TEST_TENANT_ID, ["rv-w1"])
        self.assertEqual(out["deleted"], ["rv-snap", "rv-w1"], "source and what only it uses")
        self.assertEqual(out["kept_in_use"], ["rv-tech"], "the steward's own episode still uses the technology")
        left = self.ids()
        for kept in ("rv-w2", "rv-shared", "rv-tech", "rv-own-ep", "rv-system"):
            self.assertIn(kept, left)
        with self.assertRaises(ValueError):
            ownership.delete_transferred_sources(self.driver, STEWARD, self.TID, TEST_TENANT_ID, ["rv-own-ep"])
        with self.assertRaises(ValueError):
            ownership.delete_transferred_sources(self.driver, STEWARD, self.TID, TEST_TENANT_ID, [])

    def test_keep_removes_provenance(self):
        changed = ownership.keep_transferred(self.driver, STEWARD, self.TID, TEST_TENANT_ID, ["rv-w2"])
        self.assertEqual(sorted(changed), ["rv-shared", "rv-w2"])
        p = self.driver.execute_query("MATCH (n {node_id: 'rv-w2'}) RETURN properties(n) AS p").records[0]["p"]
        self.assertFalse(any(k in p for k in ownership.TRANSFER_PROVENANCE_PROPS), "name and transfer id gone")
        self.assertEqual(p["owner_id"], STEWARD)
        rest = ownership.transfer_items(self.driver, STEWARD, self.TID, TEST_TENANT_ID)
        self.assertEqual([s["node_id"] for s in rest["sources"]], ["rv-w1"])
        ownership.keep_transferred(self.driver, STEWARD, self.TID, TEST_TENANT_ID)
        self.assertEqual(ownership.transfer_items(self.driver, STEWARD, self.TID, TEST_TENANT_ID)["total_nodes"], 0)

    def test_chat_excludes_in_review_for_the_steward_only(self):
        from expert_tools import ExpertTools
        ids = ["rv-w1", "rv-w2", "rv-own-ep"]

        def visible(user, exclude):
            e = ExpertTools(tenant_id=TEST_TENANT_ID, requesting_user_id=user, allowed_ids=ids)
            e.exclude_in_review_transfers = exclude
            try:
                q = f"MATCH (n) WHERE n.node_id IN $ids AND ({e._get_security_clause('n')}) RETURN n.node_id AS id"
                return sorted(r["id"] for r in e._exec_query(q, ids=ids, **e._security_params()).records)
            finally:
                e.close()
        self.assertEqual(visible(STEWARD, True), ["rv-own-ep"], "steward's chat: in-review transfer left out")
        self.assertEqual(visible(STEWARD, False), ids and sorted(ids), "node details / transfer view: still theirs")
        self.assertEqual(visible(OTHER, True), sorted(ids), "someone it was shared with: unchanged")


if __name__ == "__main__":
    unittest.main()
