"""
S2-42 / S2-39 (2026-10-23).

- Visibility (ExpertTools security clause): only the owner (and internal calls with no user) get the
  tenant_id fallback; every other signed-in user and every guest sees strictly the Permify allowlist,
  and nothing at all when Permify is unavailable (fail closed).
- connect_knowledge_on_demand's source lookup uses that same rule (it was tenant-wide for everyone).
- Permify deletes (permify_utils): exact single-entry filters with `ids` lists; unscoped deletes refused.
- Source registration is owner-only at the MCP layer as well as in the gateway.

No network, Neo4j or Permify needed.
    .venv/bin/python -m unittest tests.mcp_server.test_share_security -v
"""
import asyncio
import json
import os
import re
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

from tests.test_tenant import TEST_TENANT_ID, use_test_tenant  # noqa: E402
use_test_tenant()

from expert_tools import ExpertTools  # noqa: E402
import permify_utils  # noqa: E402

OWNER = "user_owner_test"
INVITEE = "user_invitee_test"
STRICT = "(n.node_id IN $allowed_ids OR n.tenant_id IN ['SYSTEM', 'PUBLIC'])"
DUAL = "(n.node_id IN $allowed_ids OR n.tenant_id IN ['SYSTEM', 'PUBLIC', $tenant_id])"
TENANT_ONLY = "(n.tenant_id IN ['SYSTEM', 'PUBLIC', $tenant_id])"
# The owner's tenant fallback skips nodes another user added (owner_id), 2026-10-28 (roles doc §4)
OWNER_FALLBACK = "(n.tenant_id = $tenant_id AND (n.owner_id IS NULL OR n.owner_id = $fallback_owner_id))"
OWNER_DUAL = f"(n.node_id IN $allowed_ids OR n.tenant_id IN ['SYSTEM', 'PUBLIC'] OR {OWNER_FALLBACK})"
OWNER_TENANT_ONLY = f"(n.tenant_id IN ['SYSTEM', 'PUBLIC'] OR {OWNER_FALLBACK})"


def tools(user="", guest="", allowed=None):
    t = ExpertTools.__new__(ExpertTools)
    t.tenant_id, t.requesting_user_id, t.guest_share_anchor, t.allowed_ids = TEST_TENANT_ID, user, guest, allowed
    return t


def params_used(clause):
    return set(re.findall(r"\$(\w+)", clause))


@mock.patch.dict(os.environ, {"OWNER_USER_ID": OWNER})
class VisibilityClauseTest(unittest.TestCase):
    CASES = [
        # (label, user, guest, allowed_ids, expected clause, expected params)
        ("owner, Permify ok", OWNER, "", ["a"], OWNER_DUAL,
         {"allowed_ids": ["a"], "tenant_id": TEST_TENANT_ID, "fallback_owner_id": OWNER}),
        ("owner, Permify unavailable", OWNER, "", None, OWNER_TENANT_ONLY,
         {"tenant_id": TEST_TENANT_ID, "fallback_owner_id": OWNER}),
        ("internal call (no user), Permify ok", "", "", ["a"], DUAL, {"allowed_ids": ["a"], "tenant_id": TEST_TENANT_ID}),
        ("internal call (no user)", "", "", None, TENANT_ONLY, {"tenant_id": TEST_TENANT_ID}),
        ("invitee, Permify ok", INVITEE, "", ["a"], STRICT, {"allowed_ids": ["a"]}),
        ("invitee, Permify unavailable → nothing", INVITEE, "", None, STRICT, {"allowed_ids": []}),
        ("invitee, nothing shared", INVITEE, "", [], STRICT, {"allowed_ids": []}),
        ("trial identity", "trial-user", "", ["a"], STRICT, {"allowed_ids": ["a"]}),
        ("guest link", "guest-auth", "anchor-1", ["a"], STRICT, {"allowed_ids": ["a"]}),
        ("guest link carrying the owner id", OWNER, "anchor-1", ["a"], STRICT, {"allowed_ids": ["a"]}),
        ("guest link, Permify unavailable", "guest-auth", "anchor-1", None, STRICT, {"allowed_ids": []}),
    ]

    def test_clause_and_params_per_caller(self):
        for label, user, guest, allowed, clause, params in self.CASES:
            with self.subTest(label):
                t = tools(user, guest, allowed)
                self.assertEqual(t._get_security_clause("n"), clause)
                self.assertEqual(t._security_params(), params)
                # AP-2: every parameter the clause uses is supplied, and nothing extra is passed
                self.assertEqual(params_used(clause), set(params))

    def test_exec_query_supplies_fallback_owner_only_where_used(self):
        """AP-2: $fallback_owner_id reaches every query whose (inline-substituted) clause uses it, and no other."""
        t = tools(OWNER, "", ["a"])
        t.driver = mock.MagicMock()
        legacy = "MATCH (e:Episode) WHERE (elementId(e) IN $allowed_ids OR e.tenant_id IN ['SYSTEM', 'PUBLIC']) RETURN e"
        t._exec_query(legacy, allowed_ids=["a"], tenant_id=TEST_TENANT_ID)
        query, kwargs = t.driver.execute_query.call_args[0][0], t.driver.execute_query.call_args[1]
        self.assertEqual(params_used(query), set(kwargs))
        self.assertEqual(kwargs["fallback_owner_id"], OWNER)
        t._exec_query("MATCH (n) RETURN n", fallback_owner_id=OWNER)
        self.assertNotIn("fallback_owner_id", t.driver.execute_query.call_args[1])

    def test_no_owner_configured_means_no_tenant_visibility_for_users(self):
        with mock.patch.dict(os.environ, {"OWNER_USER_ID": ""}):
            self.assertEqual(tools(OWNER, "", ["a"])._get_security_clause("n"), STRICT)

    def test_legacy_clauses_are_rewritten_to_the_callers_rule(self):
        legacy = "MATCH (e:Episode) WHERE (elementId(e) IN $allowed_ids OR e.tenant_id IN ['SYSTEM', 'PUBLIC']) RETURN e"
        self.assertIn("e.node_id IN $allowed_ids OR e.tenant_id IN ['SYSTEM', 'PUBLIC'])", tools(INVITEE, "", ["a"])._apply_security(legacy, "e"))
        self.assertIn("$tenant_id", tools(OWNER, "", ["a"])._apply_security(legacy, "e"))


@mock.patch.dict(os.environ, {"OWNER_USER_ID": OWNER})
class BridgeSourceLookupTest(unittest.TestCase):
    """connect_knowledge_on_demand resolved its source node tenant-wide for everyone (incl. guests)."""

    def _first_query(self, t):
        t.driver = mock.MagicMock()
        empty = mock.MagicMock(records=[])
        t.driver.execute_query.return_value = empty
        try:
            t.connect_knowledge_on_demand(source_node_id="x", source_node_name="Secret", target_domain="podcast")
        except Exception:
            pass
        self.assertTrue(t.driver.execute_query.called, "the source lookup ran")
        query, kwargs = t.driver.execute_query.call_args_list[0][0][0], t.driver.execute_query.call_args_list[0][1]
        return query, kwargs

    def test_invitee_source_lookup_is_strict(self):
        query, kwargs = self._first_query(tools(INVITEE, "", ["a"]))
        self.assertIn("source.node_id IN $allowed_ids OR source.tenant_id IN ['SYSTEM', 'PUBLIC'])", query)
        self.assertNotIn("$tenant_id", query)
        self.assertNotIn("tenant_id", kwargs)

    def test_guest_source_lookup_is_strict(self):
        query, kwargs = self._first_query(tools("guest-auth", "anchor-1", ["a"]))
        self.assertNotIn("$tenant_id", query)
        self.assertNotIn("tenant_id", kwargs)

    def test_owner_source_lookup_keeps_tenant_fallback(self):
        query, kwargs = self._first_query(tools(OWNER, "", ["a"]))
        self.assertIn("$tenant_id", query)
        self.assertEqual(kwargs.get("tenant_id"), TEST_TENANT_ID)


class NodesInTenantTest(unittest.TestCase):
    """Bento /nodes_in_tenant (owner share checks, S2-43): one parameterized query, capped."""

    def test_query_and_params(self):
        t = tools()
        t.driver = mock.MagicMock()
        t.driver.execute_query.return_value = mock.MagicMock(records=[
            {"node_id": "a", "in_tenant": True, "by_owner": True},
            {"node_id": "m", "in_tenant": True, "by_owner": False},     # another user's source (2026-10-28)
            {"node_id": "p", "in_tenant": False, "by_owner": True}])
        self.assertEqual(t.nodes_in_tenant(["a", "", None, "m", "p"], owner_id=OWNER), {"own": ["a"], "everyone": ["p"]})
        query, kwargs = t.driver.execute_query.call_args[0][0], t.driver.execute_query.call_args[1]
        self.assertEqual(params_used(query), {"node_ids", "tenant_id", "everyone_tenants", "owner_id"})  # AP-2
        self.assertEqual(kwargs, {"node_ids": ["a", "m", "p"], "tenant_id": TEST_TENANT_ID,
                                  "everyone_tenants": ["SYSTEM", "PUBLIC"], "owner_id": OWNER})

    def test_empty_and_cap(self):
        from schema_guard import NODES_IN_TENANT_MAX_IDS
        t = tools()
        t.driver = mock.MagicMock()
        self.assertEqual(t.nodes_in_tenant([]), {"own": [], "everyone": []})
        t.driver.execute_query.assert_not_called()
        t.driver.execute_query.return_value = mock.MagicMock(records=[])
        t.nodes_in_tenant([f"n{i}" for i in range(NODES_IN_TENANT_MAX_IDS + 50)])
        self.assertEqual(len(t.driver.execute_query.call_args[1]["node_ids"]), NODES_IN_TENANT_MAX_IDS)


class PermifyDeleteFilterTest(unittest.TestCase):
    def test_exact_tuple_filter_uses_id_lists(self):
        f = permify_utils._exact_tuple_filter({"entity": {"type": "node", "id": "n1"}, "relation": "shared_viewer",
                                               "subject": {"type": "group", "id": "g1", "relation": "member"}})
        self.assertEqual(f, {"entity": {"type": "node", "ids": ["n1"]}, "relation": "shared_viewer",
                             "subject": {"type": "group", "ids": ["g1"], "relation": "member"}})

    def test_unscoped_deletes_are_refused(self):
        bad = [
            {"entity": {"type": "node", "id": ""}, "relation": "shared_viewer", "subject": {"type": "user", "id": "u"}},
            {"entity": {"type": "node", "id": "n1"}, "relation": "shared_viewer", "subject": {"type": "user", "id": ""}},
            {"entity": {"type": "node", "id": "n1"}, "relation": "", "subject": {"type": "user", "id": "u"}},
        ]
        for tup in bad:
            with self.subTest(tup=tup), self.assertRaises(ValueError):
                permify_utils._exact_tuple_filter(tup)
        with self.assertRaises(ValueError):
            permify_utils._exact_attribute_filter({"entity": {"type": "node", "id": ""}, "attribute": "is_private"})

    def test_requests_sent_by_revoke_and_privacy_off(self):
        sent = []

        class FakeClient:
            def __init__(self, *a, **k): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False
            async def post(self, url, json=None, headers=None):
                sent.append((url.split("/v1/tenants/")[1], json))
                return mock.MagicMock(raise_for_status=lambda: None)

        env = {"PERMIFY_API_URL": "http://permify.local", "PERMIFY_TENANT_ID": "t"}
        with mock.patch.dict(os.environ, env), mock.patch.object(permify_utils.httpx, "AsyncClient", FakeClient), \
                mock.patch.object(permify_utils, "_get_headers", mock.AsyncMock(return_value={})):
            asyncio.run(permify_utils.revoke("n1", "user:alice", "shared_viewer"))
            asyncio.run(permify_utils.revoke_agent_session("s1", ["n1", "n2"]))
            asyncio.run(permify_utils.write_privacy_attribute("n1", False))
            with self.assertRaises(ValueError):
                asyncio.run(permify_utils.revoke_agent_session("", ["n1"]))
        self.assertEqual(sent, [
            ("t/relationships/delete", {"filter": {"entity": {"type": "node", "ids": ["n1"]}, "relation": "shared_viewer",
                                                   "subject": {"type": "user", "ids": ["alice"]}}}),
            ("t/relationships/delete", {"filter": {"entity": {"type": "node", "ids": ["n1"]}, "relation": "shared_viewer",
                                                   "subject": {"type": "agent", "ids": ["s1"]}}}),
            ("t/relationships/delete", {"filter": {"entity": {"type": "node", "ids": ["n2"]}, "relation": "shared_viewer",
                                                   "subject": {"type": "agent", "ids": ["s1"]}}}),
            ("t/data/delete", {"tuple_filter": {}, "attribute_filter": {"entity": {"type": "node", "ids": ["n1"]},
                                                                        "attributes": ["is_private"]}}),
        ])


@mock.patch.dict(os.environ, {"OWNER_USER_ID": OWNER})
class SourceWriterTest(unittest.TestCase):
    def test_owner_and_organization_people_may_add_sources(self):
        """2026-10-28 (roles doc §3): owner, org admins and org members add sources; collaborators,
        guests and the trial key never, whatever user id they carry."""
        import cortex_os_mentalmodel_server_sse as sse
        cases = [(OWNER, "", False), ("", "", False), ("user_member", "org_member", False), ("user_admin", "org_admin", False),
                 (INVITEE, "", True), (INVITEE, "collaborator", True), ("trial-user", "trial", True),
                 ("guest-auth", "guest", True), ("user_x", "made_up", True)]
        for user, user_type, refused in cases:
            with self.subTest(user=user, user_type=user_type):
                token, type_token = sse.user_id_var.set(user), sse.user_type_var.set(user_type)
                try:
                    err = sse._source_writer_error()
                finally:
                    sse.user_id_var.reset(token)
                    sse.user_type_var.reset(type_token)
                self.assertEqual(err is not None, refused)
                if refused:
                    self.assertEqual(json.loads(err)["error"], "Only members of an organization can add sources.")


@mock.patch.dict(os.environ, {"OWNER_USER_ID": OWNER})
class ForeignSourceTest(unittest.TestCase):
    """Re-adding an address someone else already added is refused, without saying more (2026-10-28)."""

    def check(self, requester, existing_owner):
        import cortex_os_mentalmodel_server_sse as sse
        records = [] if existing_owner is False else [{"owner_id": existing_owner}]
        driver = mock.MagicMock()
        driver.execute_query.return_value = mock.MagicMock(records=records)
        with mock.patch.object(sse.GraphDatabase, "driver", return_value=driver), \
                mock.patch.dict(os.environ, {"NEO4J_URI": "bolt://x", "NEO4J_USERNAME": "u", "NEO4J_PASSWORD": "p"}):
            err = sse._foreign_source_error("DocumentSource", "uri", "https://x/a.pdf", TEST_TENANT_ID, requester)
        return json.loads(err)["error"] if err else None

    def test_rules(self):
        self.assertIsNone(self.check("user_member", False))                      # new address
        self.assertIsNone(self.check("user_member", "user_member"))              # their own source: new revision
        self.assertEqual(self.check("user_member", "user_other"), "This source can't be added.")
        self.assertEqual(self.check("user_member", None), "This source can't be added.")   # pre-2026-10-28 = owner's
        self.assertIsNone(self.check(OWNER, "user_other"))                       # owner/internal not checked here
        self.assertIsNone(self.check("", "user_other"))
        with self.assertRaises(ValueError):
            import cortex_os_mentalmodel_server_sse as sse
            sse._foreign_source_error("Episode", "uri", "x", TEST_TENANT_ID, "user_member")


if __name__ == "__main__":
    unittest.main()
