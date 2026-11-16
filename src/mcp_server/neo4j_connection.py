"""
The one place that creates Neo4j drivers (neo4j-connection-factory-design-2026-11-16.md, tracker S2-79).

Every service (MCP server, Bento, worker), script and test gets its driver here; a test forbids
`GraphDatabase.driver(` anywhere else.

- **Explicit trust store.** `NEO4J_TRUST` = `certifi` (default: Mozilla's list, pinned in requirements) | `system` |
  an absolute path to a PEM file. The same on a laptop, in CI and in the containers — never "whatever OpenSSL finds"
  (on 2026-11-16 macOS's bundle lacked Aura's new root and every local call failed with a misleading error).
- **`neo4j+s://` limitation.** The driver refuses trust settings with the `+s` schemes, so `neo4j+s://h` becomes
  `neo4j://h` with `encrypted=True` and the chosen trust store: same encryption and routing. `+ssc` (accept any
  self-signed certificate) is refused. Plain `neo4j://` / `bolt://` (a local, unencrypted database) are passed as is.
- **One pool per process** (`get_driver`), re-created only if the settings change (tests). Callers never close it.
- **Failures say what failed** (`classify_error`): tls | auth | network | unavailable.
Credentials come only from the environment / Secret Manager (AP-24); the password is never logged.
"""
import os
import ssl
import threading
import time
from contextlib import contextmanager
from typing import Optional

from neo4j import GraphDatabase, TrustCustomCAs, TrustSystemCAs
from neo4j.exceptions import AuthError

from domain_registry import (NEO4J_TRUST_CERTIFI, NEO4J_TRUST_SYSTEM, NEO4J_TRUST_DEFAULT, NEO4J_MAX_POOL_SIZE,
                             NEO4J_CONNECTION_TIMEOUT_S, NEO4J_LIVENESS_CHECK_S, NEO4J_WARMUP_MAX_S, NEO4J_WARMUP_RETRY_S)

ENCRYPTED_SCHEMES = {"neo4j+s": "neo4j", "bolt+s": "bolt"}      # scheme → the same scheme with explicit TLS settings
REFUSED_SCHEMES = {"neo4j+ssc", "bolt+ssc"}                     # would accept any self-signed certificate
PLAIN_SCHEMES = {"neo4j", "bolt"}
CAUSE_TLS, CAUSE_AUTH, CAUSE_NETWORK, CAUSE_UNAVAILABLE = "tls", "auth", "network", "unavailable"

_lock = threading.Lock()
_driver = None
_driver_key = None


def trust_setting() -> str:
    return (os.environ.get("NEO4J_TRUST") or NEO4J_TRUST_DEFAULT).strip()


def trusted_certificates(value: str):
    """The driver trust object for a NEO4J_TRUST value. Anything unknown is refused (no silent fallback)."""
    if value == NEO4J_TRUST_CERTIFI:
        import certifi
        return TrustCustomCAs(certifi.where())
    if value == NEO4J_TRUST_SYSTEM:
        return TrustSystemCAs()
    if os.path.isabs(value) and os.path.isfile(value):
        return TrustCustomCAs(value)
    raise ValueError(f"NEO4J_TRUST must be '{NEO4J_TRUST_CERTIFI}', '{NEO4J_TRUST_SYSTEM}' or an existing absolute "
                     f"path to a PEM file; got {value!r}")


def driver_arguments(uri: str, trust: str) -> tuple:
    """(uri, keyword arguments) for GraphDatabase.driver, with the trust store applied to encrypted schemes."""
    scheme, sep, rest = uri.partition("://")
    if not sep:
        raise ValueError("NEO4J_URI must look like neo4j+s://host")
    scheme = scheme.lower()
    if scheme in REFUSED_SCHEMES:
        raise ValueError(f"{scheme}:// accepts any self-signed certificate and is not allowed")
    if scheme in ENCRYPTED_SCHEMES:
        return f"{ENCRYPTED_SCHEMES[scheme]}://{rest}", {"encrypted": True,
                                                        "trusted_certificates": trusted_certificates(trust)}
    if scheme in PLAIN_SCHEMES:
        return uri, {}
    raise ValueError(f"unsupported Neo4j URI scheme {scheme!r}")


def _settings():
    return os.environ["NEO4J_URI"], os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"], trust_setting()


def create_driver(connection_timeout: Optional[float] = None):
    """A new driver from the NEO4J_* settings. Only for callers that must own a separate pool (a health check with a
    short timeout); everything else uses get_driver()."""
    uri, user, password, trust = _settings()
    target, extra = driver_arguments(uri, trust)
    return GraphDatabase.driver(  # the only driver construction in the code base (test_neo4j_connection)
        target, auth=(user, password), liveness_check_timeout=NEO4J_LIVENESS_CHECK_S,
        max_connection_pool_size=NEO4J_MAX_POOL_SIZE,
        connection_timeout=NEO4J_CONNECTION_TIMEOUT_S if connection_timeout is None else connection_timeout, **extra)


def get_driver():
    """The process-wide driver (a thread-safe pool). Re-created if the settings change (e.g. in tests). Never close it
    from a caller; close_driver() is for process exit."""
    global _driver, _driver_key
    uri, user, _password, trust = _settings()
    key = (uri, user, trust)
    with _lock:
        if _driver is None or _driver_key != key:
            if _driver is not None:
                _driver.close()
            _driver = create_driver()
            _driver_key = key
        return _driver


def close_driver() -> None:
    global _driver, _driver_key
    with _lock:
        if _driver is not None:
            _driver.close()
        _driver, _driver_key = None, None


@contextmanager
def script_driver():
    """For scripts: the shared driver, closed when the script's work is done."""
    try:
        yield get_driver()
    finally:
        close_driver()


def classify_error(exc: BaseException) -> str:
    """tls | auth | network | unavailable — the driver reports most failures as 'routing information'."""
    seen = set()
    e = exc
    while e is not None and id(e) not in seen:
        seen.add(id(e))
        name = type(e).__name__
        if isinstance(e, ssl.SSLError) or name in ("SSLCertVerificationError", "BoltSecurityError"):
            return CAUSE_TLS
        if isinstance(e, AuthError):
            return CAUSE_AUTH
        if isinstance(e, (ConnectionRefusedError, TimeoutError, OSError)) and not isinstance(e, ssl.SSLError):
            return CAUSE_NETWORK
        e = e.__cause__ or e.__context__
    return CAUSE_UNAVAILABLE


def connection_check(timeout_s: Optional[float] = None) -> dict:
    """{"ok": bool, "cause": None | tls | auth | network | unavailable, "detail": exception class name}."""
    driver = create_driver(connection_timeout=timeout_s) if timeout_s is not None else get_driver()
    try:
        driver.verify_connectivity()
        return {"ok": True, "cause": None, "detail": ""}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "cause": classify_error(e), "detail": type(e).__name__}
    finally:
        if timeout_s is not None:
            driver.close()


def warm(max_seconds: Optional[float] = None) -> bool:
    """Open the shared pool before a service starts serving (Cloud Run sends traffic once the port opens). Retries until
    `max_seconds`; returns False if Neo4j is unreachable so the service still starts and reports why."""
    deadline = time.monotonic() + (NEO4J_WARMUP_MAX_S if max_seconds is None else max_seconds)
    while True:
        check = connection_check()
        if check["ok"]:
            return True
        if time.monotonic() >= deadline:
            print(f"[WARMUP] Neo4j not reachable (cause={check['cause']}, {check['detail']}); starting without a warm pool")
            return False
        time.sleep(NEO4J_WARMUP_RETRY_S)
