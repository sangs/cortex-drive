"""cortex-drive alert setup (RV-17): config consistency and dry-run safety. No network.

Run: .venv/bin/python -m unittest tests.mcp_server.test_setup_alerts
"""
import json
import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import setup_alerts  # noqa: E402


class FakeApi(setup_alerts.Api):
    """Records calls; answers GETs from a dict; never touches the network."""
    def __init__(self, apply=False, state=None):
        super().__init__("cortex-drive-496915", apply=apply, token="test")
        self.calls, self.state = [], state or {}

    def call(self, method, url, body=None, write=False):
        self.calls.append((method, url, write))
        if write and not self.apply:
            return None
        if method == "GET":
            for key, value in self.state.items():
                if key in url:
                    return value
            return None
        return {"name": "projects/cortex-drive-496915/created/x"}


class AlertConfigTest(unittest.TestCase):
    def setUp(self):
        self.cfg = setup_alerts.load_config("cortex-drive-496915")

    def test_policies_are_prefixed_and_reference_known_metrics(self):
        names = {m["name"] for m in self.cfg["log_metrics"]}
        for p in self.cfg["policies"]:
            f = p["condition"]["conditionThreshold"]["filter"]
            if "logging.googleapis.com/user/" in f:
                self.assertIn(f.split("user/")[1].split('"')[0], names, p["name"])
        self.assertTrue(self.cfg["policy_prefix"].startswith("cortex"))
        self.assertEqual(len(self.cfg["policies"]), 5)

    def test_error_codes_match_the_gateway_classes(self):
        classes = json.load(open(os.path.join(ROOT, "cortex-gateway", "config", "user_errors.json")))["classes"]
        for p in self.cfg["policies"]:
            f = p["condition"]["conditionThreshold"]["filter"]
            for code in ("ai_unavailable", "internal", "timeout", "ai_busy"):
                if f'"{code}"' in f:
                    self.assertIn(code, classes)

    def test_uptime_match_is_what_system_status_returns(self):
        # GET /api/system-status: res.send({ mcp: 'up', neo4j: ... }) → compact JSON, so the match must have no spaces.
        self.assertEqual(self.cfg["uptime_check"]["content"], '"neo4j":"up"')
        index = open(os.path.join(ROOT, "cortex-gateway", "index.js")).read()
        self.assertIn("neo4j: mcpHealth.neo4j === 'up' ? 'up' : 'down'", index)
        self.assertGreaterEqual(len(self.cfg["uptime_check"]["regions"]), 3)   # Cloud Monitoring needs at least 3

    def test_project_is_filled_in_the_denied_filter(self):
        f = next(m for m in self.cfg["log_metrics"] if m["name"] == "cortex_sa_denied")["filter"]
        self.assertIn(r"@cortex-drive-496915\.iam\.gserviceaccount\.com$", f)
        self.assertNotIn("{{PROJECT}}", json.dumps(self.cfg))
        with self.assertRaises(SystemExit):
            setup_alerts.load_config("bad.project")


class DryRunTest(unittest.TestCase):
    def setUp(self):
        self.cfg = setup_alerts.load_config("cortex-drive-496915")

    def writes(self, api):
        return [c for c in api.calls if c[2]]

    def test_setup_dry_run_makes_no_writes_and_needs_no_email(self):
        api = FakeApi(apply=False)
        setup_alerts.setup(api, self.cfg, email=None)
        self.assertTrue(self.writes(api))                                 # it says what it would do …
        self.assertTrue(all(m == "GET" for m, _, w in api.calls if not w))  # … and only reads

    def test_apply_needs_the_owner_email(self):
        with self.assertRaises(SystemExit):
            setup_alerts.setup(FakeApi(apply=True), self.cfg, email=None)

    def test_update_never_reenables_a_switched_off_policy(self):
        pols = {"alertPolicies": [{"name": f"projects/p/alertPolicies/{i}", "displayName": "cortex: " + p["name"],
                                   "enabled": False} for i, p in enumerate(self.cfg["policies"])]}
        api = FakeApi(apply=True, state={"alertPolicies": pols, "notificationChannels": {"notificationChannels": [
            {"name": "projects/p/notificationChannels/1", "type": "email", "displayName": self.cfg["channel_display_name"],
             "labels": {"email_address": "owner@example.com"}}]}})
        sent = []
        orig = api.call
        api.call = lambda m, u, body=None, write=False: (sent.append((m, u, body)), orig(m, u, body, write))[1]
        setup_alerts.setup(api, self.cfg, email="owner@example.com")
        patches = [b for m, u, b in sent if m == "PATCH"]
        self.assertEqual(len(patches), 5)
        self.assertTrue(all("enabled" not in b for b in patches))

    def test_remove_matches_only_our_names(self):
        state = {"alertPolicies": {"alertPolicies": [
            {"name": "projects/p/alertPolicies/1", "displayName": "cortex: job failed"},
            {"name": "projects/p/alertPolicies/2", "displayName": "finops: alert raised"}]}}
        api = FakeApi(apply=False, state=state)
        setup_alerts.remove(api, self.cfg)
        deleted = [u for m, u, w in api.calls if m == "DELETE"]
        self.assertTrue(any("alertPolicies/1" in u for u in deleted))
        self.assertFalse(any("alertPolicies/2" in u for u in deleted))

    def test_snooze_takes_a_duration(self):
        with self.assertRaises(SystemExit):
            setup_alerts.snooze(FakeApi(), self.cfg, "forever")
        api = FakeApi(apply=False)
        setup_alerts.snooze(api, self.cfg, "2h")   # no policies yet: nothing to snooze, no write
        self.assertFalse(any(m == "POST" for m, u, w in api.calls))
        state = {"alertPolicies": {"alertPolicies": [{"name": "projects/p/alertPolicies/1", "displayName": "cortex: job failed"}]}}
        api = FakeApi(apply=False, state=state)
        setup_alerts.snooze(api, self.cfg, "2h")
        self.assertTrue(any(m == "POST" and "snoozes" in u for m, u, w in api.calls))

    def test_wrapper_and_no_email_in_repo(self):
        sh = open(os.path.join(ROOT, "scripts", "setup-alerts.sh")).read()
        self.assertIn("scripts/setup_alerts.py", sh)
        for path in ("scripts/alerts.json", "scripts/setup_alerts.py", "scripts/setup-alerts.sh"):
            self.assertNotRegex(open(os.path.join(ROOT, path)).read(), r"[\w.]+@gmail\.com")


if __name__ == "__main__":
    unittest.main()
