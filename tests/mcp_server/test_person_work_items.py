"""
person_work_items (bridge plan design 2026-11-13 §10, gap 1): a person's own items for "her thought leadership".
- Read-only query; every $param used (AP-2); security clause on the person and on every item.
- Labels limited to the manifests' bridge-source kinds; nothing to ask → no query.
- Consumption and similarity links are not work.
No network.
    .venv/bin/python -m unittest tests.mcp_server.test_person_work_items -v
"""
import json
import os
import re
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

import domain_registry as reg  # noqa: E402
from schema_guard import CONSUMPTION_RELATIONSHIPS, SIMILARITY_RELATIONSHIPS  # noqa: E402
from expert_tools import ExpertTools  # noqa: E402


def _tools(user_id="user_member", allowed_ids=("a",), records=()):
    t = ExpertTools.__new__(ExpertTools)
    t.tenant_id, t.requesting_user_id, t.guest_share_anchor = "org_x", user_id, ""
    t.allowed_ids = list(allowed_ids) if allowed_ids is not None else None
    t.driver = mock.MagicMock()
    t.driver.execute_query.return_value = mock.MagicMock(records=[dict(r) for r in records])
    return t


class PersonWorkItemsTest(unittest.TestCase):
    def test_query_params_and_security(self):
        t = _tools(records=[{"node_id": "tl1", "name": "Talk"}])
        with mock.patch.dict(os.environ, {"OWNER_USER_ID": "user_owner"}):
            out = json.loads(t.person_work_items(["p1"], ["ThoughtLeadership", "Salary"]))
        self.assertEqual(out["items"], [{"node_id": "tl1", "name": "Talk"}])
        self.assertFalse(out["truncated"])
        q, kw = t.driver.execute_query.call_args[0][0], t.driver.execute_query.call_args[1]
        used = set(re.findall(r"\$(\w+)", q))
        sent = {k for k in kw if k not in ("routing_", "database_", "result_transformer_", "impersonated_user_")}
        self.assertEqual(sent - used, set(), "orphaned parameter (AP-2)")
        self.assertEqual(kw["work_labels"], ["ThoughtLeadership"], "a label outside the bridge-source kinds is dropped")
        self.assertEqual(kw["not_work"], CONSUMPTION_RELATIONSHIPS + SIMILARITY_RELATIONSHIPS)
        self.assertEqual(kw["work_limit"], reg.BRIDGE_PLAN_WORK_ITEMS_MAX)
        self.assertIn("p.node_id IN $allowed_ids", q)
        self.assertIn("w.node_id IN $allowed_ids", q)
        for word in ("MERGE", "CREATE", "SET ", "DELETE"):
            self.assertNotIn(word, q.upper().replace("OFFSET", ""))

    def test_nothing_to_ask_runs_no_query(self):
        for ids, labels in ((["p1"], ["Salary"]), ([], ["ThoughtLeadership"]), (["p1"], []), ([None, ""], ["Project"])):
            t = _tools()
            self.assertEqual(json.loads(t.person_work_items(ids, labels)), {"items": []})
            t.driver.execute_query.assert_not_called()

    def test_error_is_reported_in_band(self):
        t = _tools()
        t.driver.execute_query.side_effect = RuntimeError("down")
        self.assertIn("error", json.loads(t.person_work_items(["p1"], ["Project"])))

    def test_kind_labels_are_the_manifest_union(self):
        labels = reg.get_bridge_source_kind_labels()
        self.assertIn("ThoughtLeadership", labels)
        self.assertIn("Episode", labels)
        self.assertNotIn("Salary", labels)
        self.assertNotIn("Person", labels)


if __name__ == "__main__":
    unittest.main()
