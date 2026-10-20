"""
S2-21: the website fetcher (fetch_and_extract, used by Add Source → Website and view_source_live)
goes through the shared SSRF-safe fetcher, so every redirect hop is re-validated. No network: HTTP
is served by httpx.MockTransport at IP-literal URLs (the SSRF check needs no DNS).

    .venv/bin/python -m unittest tests.ingestion.test_web_url_fetch -v
"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

import httpx  # noqa: E402

from ingestion.adapters.web_url import fetch_and_extract  # noqa: E402
from schema_guard import WEB_FETCH_MAX_BYTES, WEB_FETCH_MAX_REDIRECTS  # noqa: E402

PUBLIC = "https://8.8.8.8"
ARTICLE = ("<html><head><title>Graph databases</title></head><body><article><h1>Graph databases</h1>"
           + "".join(f"<p>Paragraph {i}: a graph database stores nodes and relationships, and queries traverse "
                     f"them directly instead of joining tables. This is sentence {i} of the test article.</p>"
                     for i in range(12))
           + '<img src="/diagram.png"></article></body></html>')


class Recorder:
    def __init__(self, routes):
        self.routes, self.seen = routes, []

    def __call__(self, request):
        self.seen.append(str(request.url))
        r = self.routes.get(str(request.url))
        return r(request) if callable(r) else (r or httpx.Response(404))


def html(text=ARTICLE, **headers):
    return httpx.Response(200, content=text.encode(), headers={"content-type": "text/html; charset=utf-8", **headers})


class WebsiteSsrfTest(unittest.TestCase):

    def run_fetch(self, url, routes):
        rec = Recorder(routes)
        return rec, (lambda: fetch_and_extract(url, transport=httpx.MockTransport(rec)))

    def test_redirect_to_metadata_refused_and_never_requested(self):
        rec, go = self.run_fetch(f"{PUBLIC}/page", {f"{PUBLIC}/page": httpx.Response(302, headers={"location": "http://169.254.169.254/computeMetadata/v1/"})})
        with self.assertRaises(RuntimeError) as ctx:
            go()
        self.assertIn("non-public", str(ctx.exception))
        self.assertEqual(rec.seen, [f"{PUBLIC}/page"], "the metadata server must never be requested")

    def test_redirect_to_localhost_refused(self):
        rec, go = self.run_fetch(f"{PUBLIC}/page", {f"{PUBLIC}/page": httpx.Response(301, headers={"location": "http://127.0.0.1:8080/admin"})})
        with self.assertRaises(RuntimeError):
            go()
        self.assertEqual(len(rec.seen), 1)

    def test_private_start_url_refused_without_request(self):
        for url in ("http://10.0.0.5/", "http://169.254.169.254/", "http://localhost/", "file:///etc/passwd"):
            rec, go = self.run_fetch(url, {})
            with self.assertRaises(RuntimeError, msg=url):
                go()
            self.assertEqual(rec.seen, [], url)

    def test_too_many_redirects(self):
        routes = {f"{PUBLIC}/r{i}": httpx.Response(302, headers={"location": f"/r{i + 1}"})
                  for i in range(WEB_FETCH_MAX_REDIRECTS + 2)}
        _, go = self.run_fetch(f"{PUBLIC}/r0", routes)
        with self.assertRaises(RuntimeError) as ctx:
            go()
        self.assertIn("Too many redirects", str(ctx.exception))

    def test_oversize_refused(self):
        _, go = self.run_fetch(f"{PUBLIC}/big", {f"{PUBLIC}/big": html(**{"content-length": str(WEB_FETCH_MAX_BYTES + 1)})})
        with self.assertRaises(RuntimeError):
            go()

    def test_public_redirect_followed_and_extracted(self):
        rec, go = self.run_fetch(f"{PUBLIC}/old", {f"{PUBLIC}/old": httpx.Response(301, headers={"location": "/new"}),
                                                   f"{PUBLIC}/new": html()})
        text, content_hash, images = go()
        self.assertIn("graph database stores nodes", text)
        self.assertEqual(len(content_hash), 64)
        self.assertEqual(images, [f"{PUBLIC}/diagram.png"])
        self.assertEqual(rec.seen, [f"{PUBLIC}/old", f"{PUBLIC}/new"])

    def test_http_error_refused(self):
        _, go = self.run_fetch(f"{PUBLIC}/missing", {})
        with self.assertRaises(RuntimeError):
            go()


if __name__ == "__main__":
    unittest.main()
