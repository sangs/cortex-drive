"""
Phase B M3' unit tests: the document fetcher's SSRF guard (every redirect hop), size cap, file-type
detection and conditional requests; the enqueue and status helpers. No Neo4j, no paid API, no
network: HTTP is served by httpx.MockTransport and every URL uses an IP literal, so the SSRF check
needs no DNS.

    .venv/bin/python -m unittest tests.ingestion.test_document_url_fetch -v
"""
import io
import json
import os
import sys
import unittest
import zipfile
from datetime import datetime, timezone
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

import httpx  # noqa: E402

from ingestion.adapters.document_url import (  # noqa: E402
    DocumentFetchError, detect_document_mime_type, fetch_public_document,
)
from parsing.structure_parser import MIME_DOCX, MIME_PDF, MIME_PPTX  # noqa: E402
from schema_guard import DOCUMENT_FETCH_MAX_BYTES, DOCUMENT_FETCH_MAX_REDIRECTS  # noqa: E402
from worker import enqueue, status  # noqa: E402

PUBLIC = "https://8.8.8.8"           # public IP literal: passes validate_public_url without DNS
PDF_BYTES = b"%PDF-1.7\n% test document\n%%EOF"


def ooxml(part: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr(part, "<x/>")
    return buf.getvalue()


class Recorder:
    """MockTransport handler that records every requested URL."""

    def __init__(self, routes):
        self.routes, self.seen = routes, []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(str(request.url))
        handler = self.routes.get(str(request.url))
        if handler is None:
            return httpx.Response(404)
        return handler(request) if callable(handler) else handler


def fetch(url, routes, **kw):
    rec = Recorder(routes)
    try:
        return fetch_public_document(url, transport=httpx.MockTransport(rec), **kw), rec
    except DocumentFetchError:
        raise


class SsrfGuardTest(unittest.TestCase):
    """Unsafe targets are refused BEFORE any request is made to them."""

    def assertRefusedWithoutRequest(self, url):
        rec = Recorder({})
        with self.assertRaises(DocumentFetchError):
            fetch_public_document(url, transport=httpx.MockTransport(rec))
        self.assertEqual(rec.seen, [], f"{url} must never be requested")

    def test_localhost_refused(self):
        self.assertRefusedWithoutRequest("http://127.0.0.1:8080/admin.pdf")

    def test_localhost_name_refused(self):
        self.assertRefusedWithoutRequest("http://localhost/x.pdf")

    def test_cloud_metadata_refused(self):
        self.assertRefusedWithoutRequest("http://169.254.169.254/computeMetadata/v1/")

    def test_private_network_refused(self):
        for url in ("http://10.0.0.5/x.pdf", "http://192.168.1.10/x.pdf", "http://172.16.0.1/x.pdf",
                    "http://[::1]/x.pdf"):
            self.assertRefusedWithoutRequest(url)

    def test_non_http_schemes_refused(self):
        for url in ("file:///etc/passwd", "ftp://8.8.8.8/x.pdf", "gopher://8.8.8.8/"):
            self.assertRefusedWithoutRequest(url)

    def test_redirect_to_metadata_refused_and_never_followed(self):
        rec = Recorder({f"{PUBLIC}/doc.pdf": httpx.Response(302, headers={"location": "http://169.254.169.254/token"})})
        with self.assertRaises(DocumentFetchError):
            fetch_public_document(f"{PUBLIC}/doc.pdf", transport=httpx.MockTransport(rec))
        self.assertEqual(rec.seen, [f"{PUBLIC}/doc.pdf"], "the private redirect target must never be requested")

    def test_redirect_to_localhost_refused(self):
        rec = Recorder({f"{PUBLIC}/doc.pdf": httpx.Response(307, headers={"location": "http://127.0.0.1/doc.pdf"})})
        with self.assertRaises(DocumentFetchError):
            fetch_public_document(f"{PUBLIC}/doc.pdf", transport=httpx.MockTransport(rec))
        self.assertEqual(len(rec.seen), 1)

    def test_public_relative_redirect_followed(self):
        doc, rec = fetch(f"{PUBLIC}/a.pdf", {
            f"{PUBLIC}/a.pdf": httpx.Response(301, headers={"location": "/b.pdf"}),
            f"{PUBLIC}/b.pdf": httpx.Response(200, content=PDF_BYTES)})
        self.assertEqual(doc.mime_type, MIME_PDF)
        self.assertEqual(doc.final_url, f"{PUBLIC}/b.pdf")

    def test_too_many_redirects(self):
        routes = {f"{PUBLIC}/r{i}": httpx.Response(302, headers={"location": f"/r{i + 1}"})
                  for i in range(DOCUMENT_FETCH_MAX_REDIRECTS + 2)}
        with self.assertRaises(DocumentFetchError) as ctx:
            fetch(f"{PUBLIC}/r0", routes)
        self.assertIn("Too many redirects", str(ctx.exception))


class ContentChecksTest(unittest.TestCase):

    def test_declared_size_over_cap_refused(self):
        with self.assertRaises(DocumentFetchError):
            fetch(f"{PUBLIC}/big.pdf", {f"{PUBLIC}/big.pdf": httpx.Response(
                200, headers={"content-length": str(DOCUMENT_FETCH_MAX_BYTES + 1)}, content=PDF_BYTES)})

    def test_streamed_size_over_cap_refused(self):
        with mock.patch("ingestion.adapters.document_url.DOCUMENT_FETCH_MAX_BYTES", 10):
            with self.assertRaises(DocumentFetchError):
                fetch(f"{PUBLIC}/big.pdf", {f"{PUBLIC}/big.pdf": httpx.Response(200, content=PDF_BYTES)})

    def test_html_refused_even_if_labelled_pdf(self):
        with self.assertRaises(DocumentFetchError):
            fetch(f"{PUBLIC}/x.pdf", {f"{PUBLIC}/x.pdf": httpx.Response(
                200, headers={"content-type": "application/pdf"}, content=b"<html>login</html>")})

    def test_http_error_refused(self):
        with self.assertRaises(DocumentFetchError):
            fetch(f"{PUBLIC}/missing.pdf", {})

    def test_mime_detected_from_bytes(self):
        self.assertEqual(detect_document_mime_type(PDF_BYTES), MIME_PDF)
        self.assertEqual(detect_document_mime_type(ooxml("word/document.xml")), MIME_DOCX)
        self.assertEqual(detect_document_mime_type(ooxml("ppt/presentation.xml")), MIME_PPTX)
        self.assertIsNone(detect_document_mime_type(ooxml("xl/workbook.xml")))
        self.assertIsNone(detect_document_mime_type(b"PK\x03\x04 not a zip"))

    def test_fetch_returns_hash_validators_and_filename(self):
        doc, _ = fetch(f"{PUBLIC}/files/report.pdf", {f"{PUBLIC}/files/report.pdf": httpx.Response(
            200, headers={"etag": '"v1"', "last-modified": "Tue, 06 Oct 2026 10:00:00 GMT"}, content=PDF_BYTES)})
        self.assertEqual(len(doc.content_hash), 64)
        self.assertEqual((doc.etag, doc.filename), ('"v1"', "report.pdf"))
        self.assertFalse(doc.not_modified)

    def test_conditional_request_not_modified(self):
        def handler(request):
            self.assertEqual(request.headers.get("if-none-match"), '"v1"')
            return httpx.Response(304)
        doc, _ = fetch(f"{PUBLIC}/r.pdf", {f"{PUBLIC}/r.pdf": handler}, etag='"v1"')
        self.assertTrue(doc.not_modified)
        self.assertIsNone(doc.data)


class EnqueueAndStatusTest(unittest.TestCase):

    def test_task_id_dedups_within_the_hour_only(self):
        t1 = datetime(2026, 10, 8, 10, 5, tzinfo=timezone.utc)
        t2 = datetime(2026, 10, 8, 10, 55, tzinfo=timezone.utc)
        t3 = datetime(2026, 10, 8, 11, 1, tzinfo=timezone.utc)
        self.assertEqual(enqueue.task_id("org_a", "u", t1), enqueue.task_id("org_a", "u", t2))
        self.assertNotEqual(enqueue.task_id("org_a", "u", t1), enqueue.task_id("org_a", "u", t3))
        self.assertNotEqual(enqueue.task_id("org_a", "u", t1), enqueue.task_id("org_b", "u", t1))

    def test_run_job_request_carries_task_as_env_override(self):
        task = enqueue.build_task("https://8.8.8.8/x.pdf", "org_a", "user_1")
        req = enqueue.run_job_request(task, project="p", region="r", job="j", invoker_sa="sa@p")
        self.assertEqual(req["url"], "https://run.googleapis.com/v2/projects/p/locations/r/jobs/j:run")
        body = json.loads(__import__("base64").b64decode(req["body"]))
        env = body["overrides"]["containerOverrides"][0]["env"][0]
        self.assertEqual(env["name"], enqueue.TASK_ENV_VAR)
        self.assertEqual(json.loads(env["value"])["tenant_id"], "org_a")
        self.assertEqual(req["oauthToken"]["serviceAccountEmail"], "sa@p")

    def test_task_env_var_matches_worker(self):
        from worker.ingest_document import TASK_ENV_VAR
        self.assertEqual(enqueue.TASK_ENV_VAR, TASK_ENV_VAR)

    def test_disabled_when_mode_unset(self):
        import asyncio
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(enqueue.MODE_ENV, None)
            with self.assertRaises(enqueue.EnqueueError):
                asyncio.run(enqueue.enqueue_document_ingestion(enqueue.build_task("u", "t", "o")))

    def test_local_mode_refused_on_cloud_run(self):
        import asyncio
        with mock.patch.dict(os.environ, {enqueue.MODE_ENV: "local", "K_SERVICE": "cortex-mcp"}):
            with self.assertRaises(enqueue.EnqueueError):
                asyncio.run(enqueue.enqueue_document_ingestion(enqueue.build_task("u", "t", "o")))

    def test_cloud_mode_requires_configuration(self):
        import asyncio
        env = {enqueue.MODE_ENV: "cloud_tasks"}
        with mock.patch.dict(os.environ, env):
            for v in enqueue.REQUIRED_CLOUD_ENV:
                os.environ.pop(v, None)
            with self.assertRaises(enqueue.EnqueueError):
                asyncio.run(enqueue.enqueue_document_ingestion(enqueue.build_task("u", "t", "o")))

    def test_status_key_is_tenant_scoped(self):
        self.assertNotEqual(status.status_key("org_a", "u"), status.status_key("org_b", "u"))
        rec = json.loads(status.status_record("queued", "u"))
        self.assertEqual(rec["state"], "queued")
        with self.assertRaises(ValueError):
            status.status_record("bogus", "u")


class LockRedis:
    """In-memory stand-in for the Redis calls the lock uses; `down=True` simulates an outage."""

    def __init__(self, down=False):
        self.store, self.down = {}, down

    def _check(self):
        if self.down:
            raise ConnectionError("redis down")

    def set(self, key, value, nx=False, ex=None):
        self._check()
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    def get(self, key):
        self._check()
        return self.store.get(key)

    def expire(self, key, ttl):
        self._check()
        return key in self.store

    def eval(self, script, numkeys, key, token):
        self._check()
        if self.store.get(key) == token:
            del self.store[key]
            return 1
        return 0


class IngestLockTest(unittest.TestCase):
    """One worker per (tenant, document); refuse to run without Redis; a retry of the same Cloud Run
    execution takes over its own lock (user decisions 2026-10-08)."""

    def env(self, execution=None):
        e = {k: v for k, v in os.environ.items() if k != "CLOUD_RUN_EXECUTION"}
        if execution:
            e["CLOUD_RUN_EXECUTION"] = execution
        return mock.patch.dict(os.environ, e, clear=True)

    def test_second_run_is_locked_out(self):
        r = LockRedis()
        with self.env():
            first = status.acquire_ingest_lock("org_a", "u", r)
            self.assertIsNotNone(first)
            self.assertIsNone(status.acquire_ingest_lock("org_a", "u", r))
            self.assertIsNotNone(status.acquire_ingest_lock("org_b", "u", r), "locks are per tenant")

    def test_release_only_own_lock(self):
        r = LockRedis()
        with self.env():
            token = status.acquire_ingest_lock("org_a", "u", r)
            status.release_ingest_lock("org_a", "u", "someone-else", r)
            self.assertIsNone(status.acquire_ingest_lock("org_a", "u", r), "a foreign token must not release it")
            status.release_ingest_lock("org_a", "u", token, r)
            self.assertIsNotNone(status.acquire_ingest_lock("org_a", "u", r))

    def test_redis_down_refuses(self):
        with self.env(), self.assertRaises(status.LockUnavailableError):
            status.acquire_ingest_lock("org_a", "u", LockRedis(down=True))

    def test_retry_of_same_execution_takes_over(self):
        r = LockRedis()
        with self.env("cortex-ingest-worker-abc12"):
            self.assertIsNotNone(status.acquire_ingest_lock("org_a", "u", r))   # attempt 1 crashed holding it
            self.assertIsNotNone(status.acquire_ingest_lock("org_a", "u", r))   # attempt 2 takes over
        with self.env("cortex-ingest-worker-zzz99"):
            self.assertIsNone(status.acquire_ingest_lock("org_a", "u", r), "another execution stays locked out")

    def test_lock_outlives_job_timeout(self):
        from schema_guard import DOCUMENT_INGEST_JOB_TIMEOUT_SECONDS, DOCUMENT_INGEST_LOCK_TTL_SECONDS
        self.assertGreater(DOCUMENT_INGEST_LOCK_TTL_SECONDS, DOCUMENT_INGEST_JOB_TIMEOUT_SECONDS)

    def test_worker_refuses_to_run_without_redis(self):
        from worker.ingest_document import run
        task = {"uri": "https://8.8.8.8/x.pdf", "tenant_id": "cortex-test-tenant", "owner_id": "o"}
        rec = Recorder({})
        with self.env(), self.assertRaises(status.LockUnavailableError):
            run(task, parser=object(), describer=object(), transport=httpx.MockTransport(rec),
                redis_client=LockRedis(down=True))
        self.assertEqual(rec.seen, [], "nothing may be fetched without the lock")

    def test_worker_locked_out_does_nothing(self):
        from worker.ingest_document import run
        task = {"uri": "https://8.8.8.8/x.pdf", "tenant_id": "cortex-test-tenant", "owner_id": "o"}
        r, rec = LockRedis(), Recorder({})
        r.store[status.status_key("cortex-test-tenant", task["uri"]) + ":lock"] = "local:other"
        with self.env():
            result = run(task, parser=object(), describer=object(), transport=httpx.MockTransport(rec), redis_client=r)
        self.assertEqual(result, {"state": "skipped_already_running"})
        self.assertEqual(rec.seen, [])


class DescriberCredentialsTest(unittest.TestCase):
    """L2 must never silently use an ambient ANTHROPIC_API_KEY (found 2026-10-08: it billed the
    coding session's workspace), and never any static key on Cloud Run (WIF task 9)."""

    def setUp(self):
        from parsing.visual_describer import ClaudeVisualDescriber, LOCAL_API_KEY_OPT_IN_ENV, WIF_ENV_VARS
        self.C, self.opt_in, self.wif = ClaudeVisualDescriber, LOCAL_API_KEY_OPT_IN_ENV, WIF_ENV_VARS
        self.clean = {k: v for k, v in os.environ.items()
                      if k not in ("K_SERVICE", "CLOUD_RUN_JOB", "ANTHROPIC_WIF_IMPERSONATE", LOCAL_API_KEY_OPT_IN_ENV)
                      and k not in WIF_ENV_VARS}

    def test_ambient_key_not_used_without_opt_in(self):
        with mock.patch.dict(os.environ, {**self.clean, "ANTHROPIC_API_KEY": "sk-ambient"}, clear=True):
            self.assertFalse(self.C.available())

    def test_local_key_used_with_explicit_opt_in(self):
        with mock.patch.dict(os.environ, {**self.clean, "ANTHROPIC_API_KEY": "sk-x", self.opt_in: "true"}, clear=True):
            self.assertTrue(self.C.available())

    def test_cloud_run_requires_wif_identifiers(self):
        with mock.patch.dict(os.environ, {**self.clean, "CLOUD_RUN_JOB": "w", "ANTHROPIC_API_KEY": "sk-x", self.opt_in: "true"}, clear=True):
            self.assertFalse(self.C.available())
        with mock.patch.dict(os.environ, {**self.clean, "CLOUD_RUN_JOB": "w", **{v: "id" for v in self.wif}}, clear=True):
            self.assertTrue(self.C.available())

    def test_static_key_refused_on_cloud_run(self):
        env = {**self.clean, "CLOUD_RUN_JOB": "w", "ANTHROPIC_API_KEY": "sk-x", **{v: "id" for v in self.wif}}
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(RuntimeError):
                self.C._build_client()


if __name__ == "__main__":
    unittest.main()
