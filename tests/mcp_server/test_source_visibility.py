"""
Visibility chosen when adding a source (S2-44 phase 3 / M5 addendum M5-11, step 7). No network.

- IngestionEngine._register_with_permify: private → owner tuples only; organization → tenant_viewer only on
  the given root/entity ids (default: every node, the pre-M5 behaviour); public tier → no Permify writes.
- worker: engine_scope(task) picks the graph tenant (PUBLIC for public sources) and visibility; old tasks
  without a visibility keep the pre-M5 behaviour; build_task/collect/retry tasks carry it.
- MCP: _visibility_error per role.

    .venv/bin/python -m unittest tests.mcp_server.test_source_visibility -v
"""
import json
import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

from tests.test_tenant import use_test_tenant  # noqa: E402
use_test_tenant()

import permify_utils  # noqa: E402
from ingestion_engine import IngestionEngine  # noqa: E402
from schema_guard import (SOURCE_VISIBILITY_DEFAULT, SOURCE_VISIBILITY_ORGANIZATION, INGESTION_ENGINE_DEFAULT_VISIBILITY,  # noqa: E402
                          PUBLIC_TENANT_ID)

OWNER = "user_owner_test"
ORG = "org_test"


def engine(tenant=ORG, visibility=None):
    e = IngestionEngine.__new__(IngestionEngine)
    e.tenant_id = tenant
    e.visibility = visibility or INGESTION_ENGINE_DEFAULT_VISIBILITY
    e._fetch_node_metadata = mock.MagicMock(return_value=({}, [("root", "sec1"), ("sec1", "blk1")], []))
    return e


def register(e, node_ids, tenant_wide_ids=None):
    calls = {"owner": [], "org": [], "parent": []}

    async def owner(nid, sub): calls["owner"].append(nid)
    async def org(nid, tenant): calls["org"].append((nid, tenant))
    async def parent(child_node_id, parent_node_id): calls["parent"].append((child_node_id, parent_node_id))
    async def private(node_id, is_private): pass

    with mock.patch.dict(os.environ, {"PERMIFY_API_URL": "http://permify.local", "OWNER_USER_ID": OWNER}), \
            mock.patch.object(permify_utils, "register_node_owner", owner), \
            mock.patch.object(permify_utils, "make_tenant_wide", org), \
            mock.patch.object(permify_utils, "write_parent_tuple", parent), \
            mock.patch.object(permify_utils, "write_privacy_attribute", private):
        e._register_with_permify(node_ids, tenant_wide_ids=tenant_wide_ids)
    return calls


class RegisterTest(unittest.TestCase):
    NODES = ["root", "snap", "sec1", "blk1", "ent1"]

    def test_private_writes_owner_and_parents_only(self):
        c = register(engine(visibility="private"), self.NODES, tenant_wide_ids=["root", "ent1"])
        self.assertEqual(c["owner"], self.NODES)
        self.assertEqual(c["org"], [])
        self.assertEqual(c["parent"], [("sec1", "root"), ("blk1", "sec1")])  # inheritance chain kept

    def test_organization_marks_only_root_and_entities(self):
        c = register(engine(visibility="organization"), self.NODES, tenant_wide_ids=["root", "ent1"])
        self.assertEqual(c["org"], [("root", ORG), ("ent1", ORG)])

    def test_default_keeps_pre_m5_behaviour(self):
        self.assertEqual(INGESTION_ENGINE_DEFAULT_VISIBILITY, SOURCE_VISIBILITY_ORGANIZATION)
        c = register(engine(), self.NODES)  # podcast/seed callers: no tenant_wide_ids
        self.assertEqual([n for n, _ in c["org"]], self.NODES)

    def test_public_tier_writes_nothing(self):
        c = register(engine(tenant=PUBLIC_TENANT_ID, visibility="public"), self.NODES)
        self.assertEqual(c, {"owner": [], "org": [], "parent": []})

    def test_unknown_visibility_refused(self):
        with mock.patch("ingestion_engine.ExpertTools"), mock.patch("ingestion_engine.OpenAI"), \
                mock.patch("ingestion_engine.GraphDatabase"), \
                mock.patch.dict(os.environ, {"OPENAI_API_KEY": "x", "NEO4J_URI": "x", "NEO4J_USERNAME": "x", "NEO4J_PASSWORD": "x"}):
            with self.assertRaises(ValueError):
                IngestionEngine(tenant_id=ORG, visibility="everyone")


class WorkerTaskTest(unittest.TestCase):
    def test_build_task_defaults_private_and_carries_choice(self):
        from worker.enqueue import build_task
        self.assertEqual(build_task("https://x/a.pdf", ORG, OWNER)["visibility"], SOURCE_VISIBILITY_DEFAULT)
        self.assertEqual(build_task("https://x/a.pdf", ORG, OWNER, visibility="public")["visibility"], "public")

    def test_engine_scope(self):
        from worker.ingest_document import engine_scope
        self.assertEqual(engine_scope({"tenant_id": ORG, "visibility": "private"}), (ORG, "private"))
        self.assertEqual(engine_scope({"tenant_id": ORG, "visibility": "organization"}), (ORG, "organization"))
        self.assertEqual(engine_scope({"tenant_id": ORG, "visibility": "public"}), (PUBLIC_TENANT_ID, "public"))
        self.assertEqual(engine_scope({"tenant_id": ORG}), (ORG, INGESTION_ENGINE_DEFAULT_VISIBILITY))  # queued pre-M5
        with self.assertRaises(ValueError):
            engine_scope({"tenant_id": ORG, "visibility": "everyone"})

    def test_collect_task_carries_visibility(self):
        from worker.l2_batch import collect_task
        rec = {"batch_id": "b1", "uri": "u", "tenant_id": ORG, "owner_id": OWNER, "visibility": "public"}
        self.assertEqual(collect_task(rec, poll=1)["visibility"], "public")


@mock.patch.dict(os.environ, {"OWNER_USER_ID": OWNER})
class McpVisibilityTest(unittest.TestCase):
    def check(self, user, visibility):
        import cortex_os_mentalmodel_server_sse as sse
        token = sse.user_id_var.set(user)
        try:
            err = sse._visibility_error(visibility)
        finally:
            sse.user_id_var.reset(token)
        return json.loads(err)["error"] if err else None

    def test_rules(self):
        self.assertIsNone(self.check(OWNER, "private"))
        self.assertIsNone(self.check(OWNER, "organization"))
        self.assertIsNone(self.check(OWNER, "public"))
        self.assertIsNone(self.check("", "public"))                        # internal call
        self.assertIsNone(self.check("user_member", "private"))
        self.assertEqual(self.check("user_member", "public"), "Only the owner can choose 'public' visibility.")
        self.assertEqual(self.check("user_member", "organization"), "Only the owner can choose 'organization' visibility.")
        self.assertIn("visibility must be one of", self.check(OWNER, "everyone"))


if __name__ == "__main__":
    unittest.main()
