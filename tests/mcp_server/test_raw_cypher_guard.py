"""
S2-20 / AP-26: run_cypher_query is owner-only, refuses write/admin keywords, runs in a READ-access
transaction, and withholds other tenants' nodes.

Unit tests use a mocked driver (no network). The DatabaseEnforcementTest class runs against the real
Neo4j under the test tenant and proves the database itself rejects a write in the READ path, even with
the keyword guard bypassed; it creates nothing (and cleans the test tenant regardless).

    .venv/bin/python -m unittest tests.mcp_server.test_raw_cypher_guard -v
"""
import json
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
use_test_tenant()

from expert_tools import ExpertTools  # noqa: E402
from schema_guard import RAW_CYPHER_WRITE_PATTERNS  # noqa: E402

OWNER = "user_owner_test"


def tools_with_mock_driver(records=None, tenant=TEST_TENANT_ID):
    """An ExpertTools without real clients: driver.execute_query returns `records`."""
    t = ExpertTools.__new__(ExpertTools)
    t.tenant_id, t.requesting_user_id, t.guest_share_anchor, t.allowed_ids = tenant, OWNER, "", None
    t.driver = mock.MagicMock()
    result = mock.MagicMock()
    result.records = [mock.MagicMock(data=mock.MagicMock(return_value=r)) for r in (records or [])]
    t.driver.execute_query.return_value = result
    return t


class RawCypherGuardTest(unittest.TestCase):

    def setUp(self):
        self.env = mock.patch.dict(os.environ, {"OWNER_USER_ID": OWNER})
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def run_q(self, tools, query, user=OWNER):
        return json.loads(tools.run_cypher_query(query, requesting_user_id=user))

    def test_non_owner_refused_without_touching_the_database(self):
        t = tools_with_mock_driver()
        for user in ("", "guest-auth", "trial-user", "user_someone_else"):
            self.assertIn("restricted to the workspace owner", self.run_q(t, "MATCH (n) RETURN n LIMIT 1", user)["error"])
        t.driver.execute_query.assert_not_called()

    def test_owner_refused_when_owner_unconfigured(self):
        with mock.patch.dict(os.environ, {"OWNER_USER_ID": ""}):
            t = tools_with_mock_driver()
            self.assertIn("error", self.run_q(t, "MATCH (n) RETURN n", ""))

    def test_write_and_admin_keywords_refused(self):
        t = tools_with_mock_driver()
        for q in ("CREATE (n:X)", "MATCH (n) DETACH DELETE n", "MATCH (n) SET n.x = 1", "MERGE (n:X {a:1})",
                  "MATCH (n) REMOVE n.x", "DROP INDEX foo", "LOAD CSV FROM 'http://169.254.169.254/' AS r RETURN r",
                  "MATCH (n) FOREACH (x IN [1] | SET n.y = x)", "CALL apoc.periodic.iterate('a','b',{})",
                  "CALL dbms.security.createUser('x','y')", "match (n) call { with n delete n } in transactions",
                  "GRANT ROLE admin TO x"):
            self.assertIn("read-only", self.run_q(t, q)["error"], q)
        t.driver.execute_query.assert_not_called()
        self.assertGreater(len(RAW_CYPHER_WRITE_PATTERNS), 10)

    def test_read_runs_in_read_access_mode(self):
        from neo4j import RoutingControl
        t = tools_with_mock_driver([{"c": 3}])
        out = self.run_q(t, "MATCH (n {tenant_id: $tenant_id}) RETURN count(n) AS c")
        self.assertEqual(out["rows"], [{"c": 3}])
        self.assertEqual(t.driver.execute_query.call_args.kwargs["routing_"], RoutingControl.READ)

    def test_foreign_tenant_nodes_withheld(self):
        rows = [{"n": {"name": "mine", "tenant_id": TEST_TENANT_ID}},
                {"n": {"name": "theirs", "tenant_id": "org_other"}},
                {"n": {"name": "landmark", "tenant_id": "SYSTEM"}},
                {"ns": [{"name": "a", "tenant_id": "org_other"}, {"name": "b", "tenant_id": TEST_TENANT_ID}]},
                {"c": 42}]
        out = self.run_q(tools_with_mock_driver(rows), "MATCH (n) RETURN n")
        names = json.dumps(out["rows"])
        self.assertNotIn("theirs", names)
        self.assertNotIn('"a"', names)
        for kept in ("mine", "landmark", '"b"', "42"):
            self.assertIn(kept, names)
        self.assertEqual(out["withheld_nodes"], 2)


@unittest.skipUnless(os.environ.get("NEO4J_URI"), "needs Neo4j credentials")
class DatabaseEnforcementTest(unittest.TestCase):
    """The database, not just the keyword list, rejects writes on the READ path."""

    @classmethod
    def setUpClass(cls):
        cls.tools = ExpertTools(tenant_id=TEST_TENANT_ID, requesting_user_id=OWNER)
        cleanup_test_tenant(cls.tools.driver)

    @classmethod
    def tearDownClass(cls):
        cleanup_test_tenant(cls.tools.driver)
        remaining = count_test_tenant_nodes(cls.tools.driver)
        cls.tools.close()
        assert remaining == 0, f"{remaining} test-tenant nodes left behind"

    def test_write_rejected_by_database_in_read_path(self):
        probe = "CREATE (:RawCypherProbe {tenant_id: $tenant_id}) RETURN 1 AS ok"
        with self.assertRaises(Exception) as ctx:
            self.tools._run_read_only(probe)          # bypasses the keyword guard on purpose
        self.assertRegex(str(ctx.exception), r"(?i)access ?mode|read access|not allowed|write")
        self.assertEqual(count_test_tenant_nodes(self.tools.driver), 0, "the probe write must not have happened")

    def test_owner_read_works(self):
        with mock.patch.dict(os.environ, {"OWNER_USER_ID": OWNER}):
            out = json.loads(self.tools.run_cypher_query(
                "MATCH (n {tenant_id: $tenant_id}) RETURN count(n) AS c", requesting_user_id=OWNER))
        self.assertEqual(out["rows"], [{"c": 0}])


if __name__ == "__main__":
    unittest.main()
