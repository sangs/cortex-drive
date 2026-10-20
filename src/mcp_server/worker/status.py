"""Document-ingestion job status, kept in Redis (never in the graph) so the UI can show
queued → running → done/unchanged/failed for an "Add Source" request. Written by cortex-mcp
(queued) and the worker (the rest); read by cortex-mcp's get_document_source_status tool."""
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from typing import Optional

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from schema_guard import (  # noqa: E402
    DOCUMENT_INGEST_LOCK_TTL_SECONDS, DOCUMENT_INGEST_STATUSES, DOCUMENT_INGEST_STATUS_KEY_PREFIX,
    DOCUMENT_INGEST_STATUS_TTL_SECONDS,
)

class LockUnavailableError(RuntimeError):
    """Redis can't be reached: the worker refuses to ingest without the per-document lock (user
    decision 2026-10-08: duplicate revisions are worse than a delayed ingestion)."""


# Delete the lock only if it still holds our token (never another run's lock after an expiry).
_RELEASE_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"


def status_key(tenant_id: str, uri: str) -> str:
    return f"{DOCUMENT_INGEST_STATUS_KEY_PREFIX}:{tenant_id}:{hashlib.sha256(uri.encode()).hexdigest()[:32]}"


def status_record(state: str, uri: str, **detail) -> str:
    if state not in DOCUMENT_INGEST_STATUSES:
        raise ValueError(f"state must be one of {DOCUMENT_INGEST_STATUSES}")
    return json.dumps({"state": state, "uri": uri, "updated_at": datetime.now(timezone.utc).isoformat(), **detail})


def connect():
    import redis
    return redis.Redis.from_url(os.environ.get("REDIS_URL", "redis://localhost:6379"),
                                socket_connect_timeout=5, socket_timeout=5)


def lock_owner_token() -> str:
    """Cloud Run job retries keep the same execution name (CLOUD_RUN_EXECUTION), so a retry after a
    crash (e.g. out of memory, which skips the release) recognises and takes over its own lock instead
    of waiting for it to expire. Locally every run gets a random token."""
    import secrets
    execution = os.environ.get("CLOUD_RUN_EXECUTION")
    return f"exec:{execution}" if execution else f"local:{secrets.token_hex(16)}"


def acquire_ingest_lock(tenant_id: str, uri: str, redis_client) -> Optional[str]:
    """Returns the token when this run owns the document (a fresh claim, or this execution's own lock
    left by a crashed attempt), None when another run holds it. Raises LockUnavailableError when Redis
    can't be reached: the caller must not ingest."""
    token = lock_owner_token()
    key = status_key(tenant_id, uri) + ":lock"
    try:
        if redis_client.set(key, token, nx=True, ex=DOCUMENT_INGEST_LOCK_TTL_SECONDS):
            return token
        held = redis_client.get(key)
    except Exception as e:  # noqa: BLE001
        raise LockUnavailableError(f"Redis unavailable; refusing to ingest {uri} without the lock: {e}") from e
    if isinstance(held, bytes):
        held = held.decode()
    if token.startswith("exec:") and held == token:
        print(f"[worker/status] retry of {token} taking over its own lock for {uri}")
        redis_client.expire(key, DOCUMENT_INGEST_LOCK_TTL_SECONDS)
        return token
    return None


def release_ingest_lock(tenant_id: str, uri: str, token: Optional[str], redis_client) -> None:
    if not token:
        return
    try:
        redis_client.eval(_RELEASE_SCRIPT, 1, status_key(tenant_id, uri) + ":lock", token)
    except Exception as e:  # noqa: BLE001
        print(f"[worker/status] could not release lock for {uri} (it expires on its own): {e}")


def write_status(tenant_id: str, uri: str, state: str, redis_client=None, **detail) -> None:
    """Synchronous write (the worker). Best-effort: a status write must never fail an ingestion."""
    try:
        if redis_client is None:
            redis_client = connect()
        redis_client.setex(status_key(tenant_id, uri), DOCUMENT_INGEST_STATUS_TTL_SECONDS,
                           status_record(state, uri, **detail))
    except Exception as e:  # noqa: BLE001
        print(f"[worker/status] could not write status '{state}' for {uri}: {e}")


def parse_status(raw: Optional[str]) -> Optional[dict]:
    return json.loads(raw) if raw else None
