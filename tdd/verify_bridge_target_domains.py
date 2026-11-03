"""
Live check of bridge target domains against Neo4j (bridge-discovery-and-bento-panel-design-2026-11-03.md §1).
Read-only. Uses TENANT_ID / OWNER_USER_ID from .env, like verify_q1_q2_q3_regression.py.
    ENABLE_DOCUMENT_DOMAIN=true .venv/bin/python -m unittest tdd.verify_bridge_target_domains -v
"""
import json
import os
import sys
import unittest

from dotenv import load_dotenv

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'src', 'mcp_server')))
from expert_tools import ExpertTools  # noqa: E402
import domain_registry as reg  # noqa: E402


class TestBridgeTargetDomains(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        load_dotenv('.env', override=True)
        tenant_id, owner_id = os.environ.get("TENANT_ID"), os.environ.get("OWNER_USER_ID")
        if not tenant_id or not owner_id:
            raise unittest.SkipTest("TENANT_ID or OWNER_USER_ID not set in .env")
        cls.expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=owner_id)

    @classmethod
    def tearDownClass(cls):
        cls.expert.close()

    def _source(self, label):
        rows = self.expert._exec_query(
            f"MATCH (n:{label}) WHERE COUNT {{ (n)--() }} > 0 "
            "RETURN n.node_id AS id, coalesce(n.name, n.title) AS name "
            "ORDER BY COUNT { (n)--() } DESC LIMIT 1").records
        if not rows:
            self.skipTest(f"no {label} node in this tenant")
        return rows[0]

    def _bridge(self, src, **kw):
        out = json.loads(self.expert.connect_knowledge_on_demand(
            source_node_id=src["id"], source_node_name=src["name"], **kw))
        self.assertNotIn("error", out)
        return out, [n for n in out["nodes"] if n.get("bridge_reason")]

    def _assert_shared_targets_have_provenance(self, targets):
        """Every shared-label target is linked, other than via the source, to its domain's exclusive label."""
        for t in targets:
            if not set(t.get("type") and [t["type"]]) & set(reg.SHARED_ENTITY_LABELS):
                continue
            exclusive = reg.get_exclusive_labels(t["bridge_domain"])
            hit = self.expert._exec_query(
                "MATCH (n) WHERE elementId(n) = $id "
                "RETURN EXISTS { MATCH (n)--(p) WHERE any(l IN labels(p) WHERE l IN $ex) } AS ok",
                id=t["id"], ex=exclusive).records[0]["ok"]
            self.assertTrue(hit, f"{t['type']} '{t['name']}' has no {t['bridge_domain']} link")

    def test_auto_never_targets_the_source_domain(self):
        for label, own in [("ThoughtLeadership", "professional"), ("Episode", "podcast")]:
            src = self._source(label)
            out, targets = self._bridge(src, target_domains=["auto"])
            self.assertNotIn(own, out["target_domains"])
            for t in targets:
                self.assertIn(t.get("bridge_domain"), out["target_domains"], t)
            self._assert_shared_targets_have_provenance(targets)

    def test_document_source_does_not_bridge_to_its_own_entities(self):
        if not reg.is_domain_enabled("document"):
            self.skipTest("ENABLE_DOCUMENT_DOMAIN is off")
        src = self._source("DocumentSource")
        out, targets = self._bridge(src, target_domains=["auto"])
        self.assertNotIn("document", out["target_domains"])
        self._assert_shared_targets_have_provenance(targets)

    def test_response_carries_show_more_fields(self):
        src = self._source("ThoughtLeadership")
        out, targets = self._bridge(src, target_domains=["auto"])
        for key in ("limit", "max_limit", "show_more_step", "has_more", "target_domains"):
            self.assertIn(key, out)
        self.assertLessEqual(len(targets), out["limit"])

    def test_targets_have_names(self):
        src = self._source("ThoughtLeadership")
        _, targets = self._bridge(src, target_domains=["auto"], limit=reg.BRIDGE_MAX_LIMIT)
        for t in targets:
            self.assertTrue(t.get("name"), t)

    def test_list_bridge_domains(self):
        out = json.loads(self.expert.list_bridge_domains())
        self.assertEqual([d["id"] for d in out["domains"]], reg.get_bridge_target_domains())
        self.assertEqual(out["max_limit"], reg.BRIDGE_MAX_LIMIT)


if __name__ == "__main__":
    unittest.main()
