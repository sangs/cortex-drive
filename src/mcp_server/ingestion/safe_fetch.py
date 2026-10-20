"""SSRF-safe HTTP GET shared by every server-side fetch of a user-supplied URL (S2-21, 2026-10-20).

Used by the document fetcher (ingestion/adapters/document_url.py) and the website fetcher
(ingestion/adapters/web_url.py, which also serves view_source_live). Moved here from
document_url.py so both paths run the same code.

validate_public_url() checks one hostname once. A fetch that follows redirects on its own can be
sent from a public URL to 169.254.169.254 or localhost, so redirects are followed by hand and EVERY
hop is re-validated before it is requested. The cloud metadata server also requires a
`Metadata-Flavor: Google` header, which is never sent (defence in depth).

Accepted residual risk (tracker S2-28): DNS rebinding. The hostname is resolved by the check and
again by httpx to connect. Limited by the missing metadata header and by Cloud Run services/jobs
having no VPC connector (private ranges aren't routable).
"""
import ipaddress
import socket
from dataclasses import dataclass
from typing import Mapping, Optional
from urllib.parse import urljoin, urlparse

import httpx

REDIRECT_STATUSES = (301, 302, 303, 307, 308)


class SafeFetchError(ValueError):
    """The URL can't be fetched safely: non-public target, too many redirects, or too large."""


def validate_public_url(url: str) -> None:
    """Raises ValueError if url isn't safe to fetch server-side: rejects non-http(s) schemes and any
    hostname that resolves to a private/loopback/link-local/reserved/multicast address (covers the
    cloud metadata endpoint, 169.254.169.254, among others)."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Unsupported URL scheme: '{parsed.scheme or url}'. Only http/https are allowed.")
    hostname = parsed.hostname
    if not hostname:
        raise ValueError("URL has no hostname.")
    try:
        addrs = socket.getaddrinfo(hostname, None)
    except socket.gaierror as e:
        raise ValueError(f"Could not resolve hostname: {hostname}") from e
    for _family, _type, _proto, _canonname, sockaddr in addrs:
        ip = ipaddress.ip_address(sockaddr[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise ValueError(f"URL resolves to a non-public address ({ip}) — not allowed.")


@dataclass
class SafeResponse:
    status: int
    data: Optional[bytes]           # body for 200 responses only; None otherwise (e.g. 304, 404)
    final_url: str
    headers: httpx.Headers


def safe_get(url: str, *, max_bytes: int, max_redirects: int, timeout: float,
             headers: Optional[Mapping[str, str]] = None,
             transport: Optional[httpx.BaseTransport] = None) -> SafeResponse:
    """GET with the SSRF guard on every hop and a size cap (declared and streamed). Returns the final
    non-redirect response; the body is read only for 200. `transport` is for tests only."""
    current = url
    with httpx.Client(follow_redirects=False, timeout=timeout, transport=transport) as client:
        for _hop in range(max_redirects + 1):
            try:
                validate_public_url(current)
            except ValueError as e:
                raise SafeFetchError(str(e)) from e
            with client.stream('GET', current, headers=dict(headers or {})) as resp:
                if resp.status_code in REDIRECT_STATUSES:
                    location = resp.headers.get('location')
                    if not location:
                        raise SafeFetchError(f"Redirect without a Location header from {current}")
                    current = urljoin(current, location)
                    continue
                if resp.status_code != 200:
                    return SafeResponse(resp.status_code, None, current, resp.headers)
                declared = resp.headers.get('content-length')
                if declared and declared.isdigit() and int(declared) > max_bytes:
                    raise SafeFetchError(f"Response is larger than {max_bytes // (1024 * 1024)} MB")
                buf = bytearray()
                for chunk in resp.iter_bytes():
                    buf.extend(chunk)
                    if len(buf) > max_bytes:
                        raise SafeFetchError(f"Response is larger than {max_bytes // (1024 * 1024)} MB")
                return SafeResponse(200, bytes(buf), current, resp.headers)
    raise SafeFetchError(f"Too many redirects (more than {max_redirects})")
