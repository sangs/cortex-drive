"""
Phase B M4' unit tests: batch figure descriptions (worker/l2_batch.py), the shared request builder and
parser (parsing/visual_describer.py), the L2 mode rules, and delayed queue tasks (worker/enqueue.py).
No Neo4j, no network, no paid calls: the engine, Redis and the Batch API are fakes.

    .venv/bin/python -m unittest tests.ingestion.test_l2_batch -v
"""
import asyncio
import io
import json
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as NS
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

from parsing.visual_describer import ClaudeVisualDescriber, FigureDescription  # noqa: E402
from schema_guard import (  # noqa: E402
    DOCUMENT_BATCH_COLLECT_DELAY_SECONDS, DOCUMENT_BATCH_MAX_ATTEMPTS, DOCUMENT_DECORATIVE_FIGURE_DESCRIPTION,
    WORKER_MODE_COLLECT, WORKER_MODE_DESCRIBE_PENDING,
)
from worker import enqueue as enq  # noqa: E402
from worker import l2_batch  # noqa: E402
from worker.ingest_document import resolve_l2_mode, safe_enqueue  # noqa: E402

PAGE = (612.0, 792.0)


def blank_pdf(pages=2) -> bytes:
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument.new()
    for _ in range(pages):
        pdf.new_page(*PAGE)
    out = io.BytesIO()
    pdf.save(out)
    pdf.close()
    return out.getvalue()


PDF = blank_pdf()
BIG = [50, 50, 400, 400]        # well above the 2% area threshold
TINY = [10, 10, 30, 30]         # an icon: marked decorative without a call


def block(node_id, bbox=BIG, page=1):
    return {"node_id": node_id, "type": "figure", "page": page, "bbox": bbox, "text": "", "section_path": ["Intro"]}


class FakeEngine:
    def __init__(self, blocks, current_snapshot="snap-1"):
        self.blocks, self.current_snapshot, self.applied = blocks, current_snapshot, []

    def pending_visual_blocks(self, source_node_id, snapshot_id):
        return list(self.blocks)

    def apply_figure_descriptions(self, *, source_node_id, snapshot_id, title, descriptions):
        self.applied.append(dict(descriptions))
        return {"described": len(descriptions), "entities": 0, "grounded_links": 0}

    def _current_snapshot_id(self, label, source_node_id):
        return self.current_snapshot


class FakeRedis:
    def __init__(self):
        self.store = {}

    def setex(self, k, ttl, v):
        self.store[k] = v

    def get(self, k):
        return self.store.get(k)

    def delete(self, k):
        self.store.pop(k, None)


class FakeDescriber:
    """Has the real request_params (so requests are the real ones) but fake Batch API calls."""
    def __init__(self, status="in_progress", results=()):
        self.real = ClaudeVisualDescriber(client=mock.MagicMock())
        self.status, self.results, self.submitted = status, list(results), None

    def request_params(self, png, **kw):
        return self.real.request_params(png, **kw)

    def submit_batch(self, requests):
        self.submitted = requests
        return "batch_1"

    def batch_status(self, batch_id):
        return {"processing_status": self.status, "succeeded": 0, "errored": 0, "expired": 0, "canceled": 0, "processing": 1}

    def batch_results(self, batch_id):
        yield from self.results


class Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, task, delay):
        self.calls.append((task, delay))


TASK = {"uri": "https://8.8.8.8/doc.pdf", "tenant_id": "cortex-test-tenant", "owner_id": "o", "mode": "ingest"}


def submit(engine, describer=None, **kw):
    redis, rec = FakeRedis(), Recorder()
    describer = describer or FakeDescriber()
    out = l2_batch.submit_figure_batch(engine=engine, describer=describer, redis_client=redis, enqueue=rec,
                                       data=PDF, page_sizes={1: PAGE, 2: PAGE}, task=TASK,
                                       source_node_id="src-1", snapshot_id="snap-1", title="Doc", **kw)
    return out, redis, rec, describer


class SubmitTest(unittest.TestCase):

    def test_submits_one_request_per_figure_keyed_by_block_id(self):
        out, redis, rec, d = submit(FakeEngine([block("b1"), block("b2", page=2), block("icon", TINY)]))
        self.assertEqual([cid for cid, _ in d.submitted], ["b1", "b2"])
        self.assertEqual(out["submitted"], 2)
        self.assertEqual(out["decorative"], 1)
        params = d.submitted[0][1]
        self.assertEqual(params["messages"][0]["content"][0]["type"], "image")

    def test_decorative_marked_without_a_call(self):
        engine = FakeEngine([block("icon", TINY)])
        out, _, rec, d = submit(engine)
        self.assertIsNone(d.submitted)
        self.assertEqual(engine.applied, [{"icon": DOCUMENT_DECORATIVE_FIGURE_DESCRIPTION}])
        self.assertEqual(out["submitted"], 0)
        self.assertEqual(rec.calls, [], "nothing to collect")

    def test_record_and_delayed_collect(self):
        out, redis, rec, _ = submit(FakeEngine([block("b1")]))
        record = json.loads(redis.get(l2_batch.batch_key("batch_1")))
        self.assertEqual((record["snapshot_id"], record["source_node_id"], record["attempt"]), ("snap-1", "src-1", 1))
        task, delay = rec.calls[0]
        self.assertEqual((task["mode"], task["batch_id"], task["poll"]), (WORKER_MODE_COLLECT, "batch_1", 1))
        self.assertEqual(delay, DOCUMENT_BATCH_COLLECT_DELAY_SECONDS)

    def test_cap_leaves_the_rest_pending(self):
        with mock.patch.object(l2_batch, "DOCUMENT_BATCH_L2_MAX_FIGURES", 2):
            out, _, _, d = submit(FakeEngine([block(f"b{i}") for i in range(5)]))
        self.assertEqual(len(d.submitted), 2)
        self.assertEqual(out["left_pending_cap"], 3)

    def test_request_is_identical_to_the_synchronous_request(self):
        client = mock.MagicMock()
        client.messages.create.return_value = NS(stop_reason="end_turn", usage=NS(input_tokens=1, output_tokens=1),
                                                 content=[NS(type="text", text='{"kind":"chart","title":"","visible_text":[],"description":"x"}')])
        d = ClaudeVisualDescriber(client=client)
        d.describe(b"png", section_path=["A"], figure_text="t")
        self.assertEqual(client.messages.create.call_args.kwargs, d.request_params(b"png", section_path=["A"], figure_text="t"))


def seed_record(redis, attempt=1, submitted_at=None):
    rec = {"batch_id": "batch_1", "tenant_id": "cortex-test-tenant", "owner_id": "o", "uri": TASK["uri"],
           "source_node_id": "src-1", "snapshot_id": "snap-1", "title": "Doc", "attempt": attempt, "figures": 3,
           "submitted_at": (submitted_at or datetime.now(timezone.utc)).isoformat()}
    redis.setex(l2_batch.batch_key("batch_1"), 1, json.dumps(rec))


def desc(text):
    return FigureDescription(kind="chart", title="", visible_text=[], description=text)


class CollectTest(unittest.TestCase):

    def collect(self, describer, engine=None, attempt=1, submitted_at=None, poll=1):
        redis, rec, statuses = FakeRedis(), Recorder(), []
        seed_record(redis, attempt, submitted_at)
        engine = engine or FakeEngine([])
        out = l2_batch.collect_batch(task={"batch_id": "batch_1", "poll": poll}, engine=engine, describer=describer,
                                     redis_client=redis, enqueue=rec,
                                     write_status=lambda *a, **k: statuses.append((a, k)))
        return out, redis, rec, engine, statuses

    def test_unfinished_batch_polls_again(self):
        out, redis, rec, engine, _ = self.collect(FakeDescriber("in_progress"), poll=3)
        self.assertEqual(out["state"], "waiting")
        self.assertEqual((rec.calls[0][0]["poll"], rec.calls[0][1]), (4, DOCUMENT_BATCH_COLLECT_DELAY_SECONDS))
        self.assertEqual(engine.applied, [])

    def test_gives_up_after_26_hours(self):
        out, redis, rec, _, _ = self.collect(FakeDescriber("in_progress"),
                                             submitted_at=datetime.now(timezone.utc) - timedelta(hours=27))
        self.assertEqual(out["state"], "gave_up")
        self.assertEqual(rec.calls, [])
        self.assertIsNone(redis.get(l2_batch.batch_key("batch_1")))

    def test_stale_revision_discarded(self):
        engine = FakeEngine([], current_snapshot="snap-2")
        out, redis, rec, engine, _ = self.collect(FakeDescriber("ended", [("b1", desc("x"), "succeeded", 5, 5)]), engine)
        self.assertEqual(out["state"], "discarded_stale_revision")
        self.assertEqual(engine.applied, [])

    def test_ended_applies_results_and_retries_failures(self):
        results = [("b1", desc("A chart of revenue"), "succeeded", 100, 20),
                   ("b2", FigureDescription(kind="other", title="", description="decorative"), "succeeded", 50, 5),
                   ("b3", None, "errored", 0, 0)]
        out, redis, rec, engine, statuses = self.collect(FakeDescriber("ended", results))
        self.assertEqual(engine.applied[0]["b2"], DOCUMENT_DECORATIVE_FIGURE_DESCRIPTION)
        self.assertIn("revenue", engine.applied[0]["b1"])
        self.assertNotIn("b3", engine.applied[0])
        self.assertEqual((out["failed"], out["l2_batch_input_tokens"], out["l2_batch_output_tokens"]), (1, 150, 25))
        retry, delay = rec.calls[0]
        self.assertEqual((retry["mode"], retry["attempt"], delay), (WORKER_MODE_DESCRIBE_PENDING, 2, 0))
        self.assertEqual(statuses[0][1]["figures"]["state"], "applied", "spend is written to the job status")
        self.assertIsNone(redis.get(l2_batch.batch_key("batch_1")))

    def test_no_retry_after_max_attempts(self):
        out, _, rec, _, _ = self.collect(FakeDescriber("ended", [("b3", None, "expired", 0, 0)]),
                                         attempt=DOCUMENT_BATCH_MAX_ATTEMPTS)
        self.assertFalse(out["retry_queued"])
        self.assertEqual(rec.calls, [])

    def test_unknown_batch(self):
        out = l2_batch.collect_batch(task={"batch_id": "nope"}, engine=FakeEngine([]), describer=FakeDescriber(),
                                     redis_client=FakeRedis(), enqueue=Recorder())
        self.assertEqual(out["state"], "unknown_batch")


class ResultsParsingTest(unittest.TestCase):

    def test_batch_results_mapping(self):
        ok = NS(custom_id="b1", result=NS(type="succeeded", message=NS(
            stop_reason="end_turn", usage=NS(input_tokens=7, output_tokens=3),
            content=[NS(type="text", text='{"kind":"diagram","title":"T","visible_text":["a"],"description":"d"}')])))
        refused = NS(custom_id="b2", result=NS(type="succeeded", message=NS(
            stop_reason="refusal", usage=NS(input_tokens=1, output_tokens=0), content=[])))
        err = NS(custom_id="b3", result=NS(type="errored"))
        client = mock.MagicMock()
        client.messages.batches.results.return_value = iter([ok, refused, err])
        out = list(ClaudeVisualDescriber(client=client).batch_results("batch_1"))
        self.assertEqual(out[0][0:3], ("b1", FigureDescription("diagram", "T", ["a"], "d"), "succeeded"))
        self.assertEqual(out[1][1:3], (None, "succeeded"))
        self.assertEqual(out[2], ("b3", None, "errored", 0, 0))


class L2ModeAndQueueTest(unittest.TestCase):

    def test_l2_mode_rules(self):
        self.assertEqual(resolve_l2_mode({}), "auto")
        self.assertEqual(resolve_l2_mode({"sync_l2": True}), "auto")
        self.assertEqual(resolve_l2_mode({"sync_l2": False}), "off", "legacy no-Claude commands must stay free")
        self.assertEqual(resolve_l2_mode({"l2": "batch"}), "batch")
        with self.assertRaises(ValueError):
            resolve_l2_mode({"l2": "always"})

    def test_new_tasks_are_explicit(self):
        t = enq.build_task("u", "t", "o")
        self.assertEqual((t["mode"], t["l2"]), ("ingest", "auto"))

    def test_task_ids_separate_kinds_and_polls(self):
        base = dict(TASK)
        ids = {enq.task_id("t", "u", extra=enq.dedup_suffix(x)) for x in (
            base, {**base, "mode": "collect", "batch_id": "b", "poll": 1}, {**base, "mode": "collect", "batch_id": "b", "poll": 2},
            {**base, "mode": "describe_pending", "attempt": 2})}
        self.assertEqual(len(ids), 4)

    def test_delayed_cloud_task_has_schedule_time(self):
        sent = {}

        class FakeClient:
            def __init__(self, *a, **k): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False
            async def post(self, url, json=None, headers=None):
                sent.update(json)
                return NS(status_code=200, json=lambda: {"name": json["task"]["name"]}, text="")

        async def token():
            return "t"
        env = {enq.MODE_ENV: "cloud_tasks", enq.PROJECT_ENV: "p", enq.REGION_ENV: "r", enq.QUEUE_ENV: "q",
               enq.JOB_ENV: "j", enq.INVOKER_SA_ENV: "sa@p"}
        with mock.patch.dict(os.environ, env), mock.patch.object(enq, "_access_token", token), \
                mock.patch.object(enq.httpx, "AsyncClient", FakeClient):
            asyncio.run(enq.enqueue_document_ingestion({**TASK, "mode": "collect", "batch_id": "b", "poll": 1}, 900))
        when = datetime.fromisoformat(sent["task"]["scheduleTime"].replace("Z", "+00:00"))
        self.assertAlmostEqual((when - datetime.now(timezone.utc)).total_seconds(), 900, delta=30)

    def test_safe_enqueue_never_raises(self):
        def broken(task, delay):
            raise RuntimeError("queue not configured")
        safe_enqueue(broken)({"mode": "collect"}, 900)   # must not raise


if __name__ == "__main__":
    unittest.main()
