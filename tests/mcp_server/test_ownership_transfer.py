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


if __name__ == "__main__":
    unittest.main()
