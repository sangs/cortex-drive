"""
FinOps daily push (S2-83 release 2): the MERGE body, the window, the guards. No live BigQuery here; the live check is
`python src/mcp_server/finops_push.py --dry-run` (BigQuery validates the query and permissions, writes nothing).

    .venv/bin/python -m unittest tests.mcp_server.test_finops_push -v
"""
import json
import os
import sys
import unittest
from datetime import datetime, timezone
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))
import finops_push as fp  # noqa: E402


class QueryTest(unittest.TestCase):
    def setUp(self):
        self.body = fp.build_query("usage-proj", "finops-proj", "2026-11-10", "cortex-drive-x")
        self.sql = self.body["query"]

    def test_tables(self):
        self.assertIn("MERGE `finops-proj.finops_landing.cortex_drive` t", self.sql)
        self.assertIn("`usage-proj.cortex_usage.run_googleapis_com_stdout`", self.sql)
        self.assertNotIn("__USAGE__", self.sql)

    def test_idempotent_window_and_dedupe(self):
        self.assertIn("WHEN NOT MATCHED BY SOURCE AND t.usage_date >= @since AND t.provider = @provider THEN DELETE", self.sql)
        self.assertIn("PARTITION BY insertId", self.sql)
        self.assertIn("jsonPayload.event = @event", self.sql)

    def test_every_parameter_is_used_and_typed(self):
        names = {p["name"] for p in self.body["queryParameters"]}
        self.assertEqual(names, {"since", "provider", "event", "run_id"})
        for name in names:
            self.assertIn(f"@{name}", self.sql, f"orphaned parameter {name} (Invariant 4 discipline)")
        values = {p["name"]: p["parameterValue"]["value"] for p in self.body["queryParameters"]}
        self.assertEqual(values["provider"], "OpenAI")
        self.assertEqual(values["event"], "openai.usage")

    def test_cost_guard_and_dry_run(self):
        self.assertEqual(self.body["maximumBytesBilled"], str(fp.CONFIG["max_bytes_billed"]))
        self.assertFalse(self.body["dryRun"])
        self.assertTrue(fp.build_query("u", "f", "2026-11-10", "r", dry_run=True)["dryRun"])

    def test_no_user_fields_leave(self):
        for field in ("user_type", "user_id", "tenant", "question", "prompt"):
            self.assertNotIn(field, self.sql)


class GuardTest(unittest.TestCase):
    def test_window_includes_today(self):
        now = datetime(2026, 11, 17, 1, 0, tzinfo=timezone.utc)
        self.assertEqual(fp.window_start(now, 7), "2026-11-11")
        self.assertEqual(fp.window_start(now, 1), "2026-11-17")

    def test_days_bounds(self):
        for bad in (0, fp.CONFIG["max_backfill_days"] + 1):
            with self.assertRaises(ValueError):
                fp.push(bad, env={"USAGE_PROJECT": "u", "FINOPS_PROJECT": "f"})

    def test_projects_have_no_default(self):
        with self.assertRaises(RuntimeError):
            fp.push(7, env={"USAGE_PROJECT": "u"})

    def test_failure_exits_1_and_logs_error(self):
        with mock.patch.object(fp, "push", side_effect=RuntimeError("BigQuery HTTP 403: denied")), \
                mock.patch("builtins.print") as printed:
            self.assertEqual(fp.main(["--dry-run"]), 1)
        line = json.loads(printed.call_args[0][0])
        self.assertEqual((line["severity"], line["tag"]), ("ERROR", "FINOPS_PUSH"))

    def test_success_exits_0(self):
        with mock.patch.object(fp, "push", return_value={"since": "2026-11-11", "changed_rows": "3"}), \
                mock.patch("builtins.print"):
            self.assertEqual(fp.main([]), 0)


if __name__ == "__main__":
    unittest.main()
