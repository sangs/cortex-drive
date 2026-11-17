"""
OpenAI usage recording in Python (FinOps release 1, 2026-11-16): same costs as the gateway (shared fixture), allow-listed
fields only, never raises, BAML calls and retries recorded, every Python OpenAI call site wrapped.

    .venv/bin/python -m unittest tests.mcp_server.test_usage_log -v
"""
import json
import os
import re
import sys
import unittest
from types import SimpleNamespace

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))
import usage_log as ul  # noqa: E402

CASES = json.load(open(os.path.join(ROOT, "cortex-gateway", "tests", "fixtures", "openai_usage_cases.json")))["cases"]


def capture():
    lines = []
    return lines, lambda line: lines.append(json.loads(line))


class CostTest(unittest.TestCase):
    def test_shared_cases_match_the_gateway(self):
        for c in CASES:
            with self.subTest(c["name"]):
                f = ul.usage_fields("chat", c["model"], c["usage"], service="svc")
                for key, value in c["expect"].items():
                    self.assertEqual(f[key], value, key)

    def test_sdk_object_usage(self):
        usage = SimpleNamespace(prompt_tokens=100, completion_tokens=0, prompt_tokens_details=None)
        self.assertEqual(ul.tokens_of(usage)["prompt_tokens"], 100)

    def test_service_name(self):
        self.assertEqual(ul.service_name({"K_SERVICE": "cortex-mcp"}), "cortex-mcp")
        self.assertEqual(ul.service_name({"CLOUD_RUN_JOB": "cortex-ingest-worker"}), "cortex-ingest-worker")
        self.assertEqual(ul.service_name({}), "local")


class EventTest(unittest.TestCase):
    def test_entry_has_only_allowed_fields(self):
        lines, sink = capture()
        response = SimpleNamespace(model="text-embedding-3-small", usage={"prompt_tokens": 7},
                                   data=[SimpleNamespace(embedding=[0.1], text="SECRET")])
        out = ul.record_response(ul.FEATURE_SEARCH_EMBED, response, sink=sink)
        self.assertIs(out, response)
        self.assertEqual(len(lines), 1)
        e = lines[0]
        self.assertEqual((e["tag"], e["event"], e["feature"]), ("OPENAI_USAGE", "openai.usage", "search_embed"))
        allowed = {"severity", "message", "tag", "event"} | set(ul.CONFIG["events"]["openai.usage"]["fields"])
        self.assertLessEqual(set(e), allowed)
        self.assertNotIn("SECRET", json.dumps(e))

    def test_price_missing_warns(self):
        lines, sink = capture()
        ul.record_usage("chat", "gpt-9", {"prompt_tokens": 1}, sink=sink)
        self.assertEqual([l["event"] for l in lines], ["openai.usage", "openai.price_missing"])
        self.assertEqual(lines[1]["severity"], "WARNING")

    def test_never_raises(self):
        def broken(_):
            raise RuntimeError("sink down")
        self.assertIsNone(ul.record_usage("chat", "gpt-4o", object(), sink=broken))
        self.assertEqual(ul.record_response("chat", None, sink=broken), None)

    def test_mirror_matches_the_gateway_config(self):
        gw = os.path.join(ROOT, "cortex-gateway", "config")
        prices = json.load(open(os.path.join(gw, "openai_prices.json")))
        events = json.load(open(os.path.join(gw, "log_events.json")))["events"]
        self.assertEqual(ul.PRICES, prices)
        for name in ("openai.usage", "openai.price_missing"):
            self.assertEqual(ul.CONFIG["events"][name], events[name])


def _call(model, usage):
    body = SimpleNamespace(json=lambda: {"model": model, "messages": ["SECRET"]})
    return SimpleNamespace(client_name="GPT4o", usage=usage, http_request=SimpleNamespace(body=body))


class BamlTest(unittest.TestCase):
    def test_every_attempt_recorded(self):
        lines, sink = capture()
        collector = SimpleNamespace(last=SimpleNamespace(calls=[
            _call("gpt-4o", SimpleNamespace(input_tokens=1000, output_tokens=0, cached_input_tokens=0)),
            _call("gpt-4o", SimpleNamespace(input_tokens=1000, output_tokens=100, cached_input_tokens=None)),
            _call("gpt-4o", None),   # no usage reported: nothing recorded
        ]))
        ul.record_baml(ul.FEATURE_EXTRACT, collector, sink=sink)
        self.assertEqual(len(lines), 2)
        self.assertEqual([l["cost_usd"] for l in lines], [0.0025, 0.0035])
        self.assertNotIn("SECRET", json.dumps(lines))

    def test_unreadable_body_falls_back_to_client_name(self):
        lines, sink = capture()
        call = SimpleNamespace(client_name="GPT4o", usage=SimpleNamespace(input_tokens=1, output_tokens=1),
                               http_request=None)
        ul.record_baml("baml_extract", SimpleNamespace(last=SimpleNamespace(calls=[call])), sink=sink)
        self.assertTrue(lines[0]["price_missing"])
        self.assertEqual(lines[0]["model"], "GPT4o")

    def test_baml_call_passes_a_collector_and_returns_the_result(self):
        seen = {}

        def fn(content, url, baml_options=None):
            seen["options"] = baml_options
            return "RESULT"
        self.assertEqual(ul.baml_call(ul.FEATURE_EXTRACT, fn, content="c", url="u"), "RESULT")
        self.assertIn("collector", seen["options"])

    def test_baml_call_records_even_when_the_call_fails(self):
        def fn(**_):
            raise ValueError("model error")
        with self.assertRaises(ValueError):
            ul.baml_call(ul.FEATURE_EXTRACT, fn)


class CallSitesTest(unittest.TestCase):
    def test_every_python_openai_call_is_recorded(self):
        base = os.path.join(ROOT, "src", "mcp_server")
        for name in ("expert_tools.py", "ingestion_engine.py"):
            src = open(os.path.join(base, name), encoding="utf-8").read()
            embeds = re.findall(r"embeddings\.create\(", src)
            wrapped = re.findall(r"record_response\(FEATURE_\w+, self\.client\.embeddings\.create\(", src)
            self.assertEqual(len(embeds), len(wrapped), name)
            self.assertEqual(re.findall(r"\bb\.Extract\w+\(", src), [], f"{name}: BAML calls go through baml_call")


class PauseTest(unittest.TestCase):
    """FinOps release 5: every OpenAI call is refused while the owner has paused spend."""

    def setUp(self):
        ul._pause_cache.update({"at": float("-inf"), "paused": False})
        self.t = 0.0

    def clock(self):
        return self.t

    def test_refused_while_paused_and_cached(self):
        reads = []
        flag = lambda: reads.append(1) or True
        with self.assertRaises(ul.OpenAIPaused) as ctx:
            ul.ensure_openai_allowed(flag, self.clock)
        self.assertEqual(str(ctx.exception), ul.CONFIG["pause"]["paused_message"])
        with self.assertRaises(ul.OpenAIPaused):
            ul.ensure_openai_allowed(flag, self.clock)
        self.assertEqual(len(reads), 1, "cached for cache_seconds")
        self.t += ul.CONFIG["pause"]["cache_seconds"]
        ul.ensure_openai_allowed(lambda: False, self.clock)   # resumed: no exception

    def test_fail_open_but_keeps_last_known_state(self):
        def down():
            raise ConnectionError("redis down")
        ul.ensure_openai_allowed(down, self.clock)   # never known paused: allowed
        ul._pause_cache.update({"at": float("-inf"), "paused": True})
        with self.assertRaises(ul.OpenAIPaused):
            ul.ensure_openai_allowed(down, self.clock)

    def test_baml_call_is_refused_before_calling(self):
        ul._pause_cache.update({"at": 0.0, "paused": True})
        import time
        ul._pause_cache["at"] = time.monotonic()
        called = []
        with self.assertRaises(ul.OpenAIPaused):
            ul.baml_call(ul.FEATURE_EXTRACT, lambda **_: called.append(1))
        self.assertEqual(called, [])

    def test_every_call_site_checks_the_pause(self):
        base = os.path.join(ROOT, "src", "mcp_server")
        for name in ("expert_tools.py", "ingestion_engine.py"):
            src = open(os.path.join(base, name), encoding="utf-8").read()
            self.assertEqual(len(re.findall(r"embeddings\.create\(", src)),
                             len(re.findall(r"ensure_openai_allowed\(\)   # owner's pause", src)), name)
        self.assertIn("    ensure_openai_allowed()\n    try:", open(os.path.join(base, "usage_log.py")).read(),
                      "baml_call checks first")

    def test_pause_config_comes_from_the_gateway(self):
        gw = json.load(open(os.path.join(ROOT, "cortex-gateway", "config", "finops.json")))["pause"]
        gw.pop("_comment", None)
        self.assertEqual(ul.CONFIG["pause"], gw)


if __name__ == "__main__":
    unittest.main()
