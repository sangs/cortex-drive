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
        ("owner, Permify ok", OWNER, "", ["a"], DUAL, {"allowed_ids": ["a"], "tenant_id": TEST_TENANT_ID}),
        ("owner, Permify unavailable", OWNER, "", None, TENANT_ONLY, {"tenant_id": TEST_TENANT_ID}),
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
    def test_only_owner_or_internal_may_add_sources(self):
        import cortex_os_mentalmodel_server_sse as sse
        for user, refused in [(OWNER, False), ("", False), (INVITEE, True), ("trial-user", True), ("guest-auth", True)]:
            with self.subTest(user=user):
                token = sse.user_id_var.set(user)
                try:
                    err = sse._source_writer_error()
                finally:
                    sse.user_id_var.reset(token)
                self.assertEqual(err is not None, refused)
                if refused:
                    self.assertEqual(json.loads(err)["error"], "Only the owner can add sources.")


if __name__ == "__main__":
    unittest.main()
