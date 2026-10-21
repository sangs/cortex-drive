"""Enqueue one document ingestion (called by cortex-mcp's register_document_source).

cortex-mcp never parses (decision P4); it only hands the task to the worker:
  - DOCUMENT_INGEST_MODE=cloud_tasks (production): a Cloud Tasks HTTP task that calls the Cloud Run
    Admin API `jobs/{job}:run` with the task in a DOCUMENT_TASK env override. Cloud Tasks gives
    rate limiting and dedup (the task name is a hash of tenant + uri + hour, so a double click
    queues one run). Auth: the caller's metadata-server access token for the Tasks API; the task's
    OAuth token (DOCUMENT_INGEST_INVOKER_SA) for the Run API. httpx only — no new dependency
    in the cortex-mcp image.
  - DOCUMENT_INGEST_MODE=local (development only): starts `python -m worker.ingest_document` as a
    separate process, so Docling still never loads inside the MCP server process.
  - unset: disabled; register_document_source returns an error.
"""
import base64
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

import httpx

MODE_ENV = "DOCUMENT_INGEST_MODE"
MODE_CLOUD_TASKS = "cloud_tasks"
MODE_LOCAL = "local"
# Cloud Tasks / Cloud Run job settings (non-secret; --set-env-vars on cortex-mcp).
PROJECT_ENV = "DOCUMENT_INGEST_PROJECT"
REGION_ENV = "DOCUMENT_INGEST_REGION"
QUEUE_ENV = "DOCUMENT_INGEST_QUEUE"
JOB_ENV = "DOCUMENT_INGEST_JOB"
INVOKER_SA_ENV = "DOCUMENT_INGEST_INVOKER_SA"
REQUIRED_CLOUD_ENV = (PROJECT_ENV, REGION_ENV, QUEUE_ENV, JOB_ENV, INVOKER_SA_ENV)

TASK_ENV_VAR = "DOCUMENT_TASK"          # must match worker.ingest_document.TASK_ENV_VAR
LOCAL_DELAY_ENV_VAR = "DOCUMENT_TASK_DELAY_SECONDS"   # local mode only: the worker sleeps this long first
METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
CLOUD_TASKS_API = "https://cloudtasks.googleapis.com/v2"
CLOUD_RUN_API = "https://run.googleapis.com/v2"
CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
HTTP_TIMEOUT_SECONDS = 15.0


class EnqueueError(RuntimeError):
    pass


def ingest_mode() -> str:
    return os.environ.get(MODE_ENV, "").strip().lower()


def build_task(uri: str, tenant_id: str, owner_id: str, l2: str = "auto") -> dict:
    """An ingest task. l2: auto (synchronous for small PDFs, batch otherwise) | batch | off (no Claude calls)."""
    return {"mode": "ingest", "uri": uri, "tenant_id": tenant_id, "owner_id": owner_id, "l2": l2,
            "requested_at": datetime.now(timezone.utc).isoformat()}


def task_id(tenant_id: str, uri: str, now: datetime = None, extra: str = "") -> str:
    """Stable for one tenant + uri within one hour: Cloud Tasks rejects a duplicate name (dedup).
    `extra` separates task kinds: an ingest of a document must never block its batch collection."""
    hour = (now or datetime.now(timezone.utc)).strftime("%Y%m%d%H")
    return "doc-" + hashlib.sha256(f"{tenant_id}|{uri}|{hour}|{extra}".encode()).hexdigest()[:40]


def dedup_suffix(task: dict) -> str:
    """Ingest: none (one per document per hour). Collect: the batch and poll number. Describe-pending: the attempt."""
    mode = task.get("mode") or "ingest"
    if mode == "collect":
        return f"collect|{task.get('batch_id')}|{task.get('poll', 0)}"
    if mode == "describe_pending":
        return f"describe|{task.get('attempt', 0)}"
    return ""


def run_job_request(task: dict, *, project: str, region: str, job: str, invoker_sa: str) -> dict:
    """The Cloud Tasks httpRequest that starts one job execution with the task as an env override."""
    body = {"overrides": {"containerOverrides": [{"env": [{"name": TASK_ENV_VAR, "value": json.dumps(task)}]}]}}
    return {
        "httpMethod": "POST",
        "url": f"{CLOUD_RUN_API}/projects/{project}/locations/{region}/jobs/{job}:run",
        "headers": {"Content-Type": "application/json"},
        "body": base64.b64encode(json.dumps(body).encode()).decode(),
        "oauthToken": {"serviceAccountEmail": invoker_sa, "scope": CLOUD_PLATFORM_SCOPE},
    }


async def _access_token() -> str:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        resp = await client.get(METADATA_TOKEN_URL, headers={"Metadata-Flavor": "Google"})
        resp.raise_for_status()
        return resp.json()["access_token"]


async def _enqueue_cloud_tasks(task: dict, delay_seconds: int = 0) -> dict:
    missing = [v for v in REQUIRED_CLOUD_ENV if not os.environ.get(v)]
    if missing:
        raise EnqueueError(f"Document ingestion queue is not configured ({', '.join(missing)} missing).")
    project, region = os.environ[PROJECT_ENV], os.environ[REGION_ENV]
    queue = f"projects/{project}/locations/{region}/queues/{os.environ[QUEUE_ENV]}"
    name = f"{queue}/tasks/{task_id(task['tenant_id'], task['uri'], extra=dedup_suffix(task))}"
    payload = {"task": {"name": name, "httpRequest": run_job_request(
        task, project=project, region=region, job=os.environ[JOB_ENV], invoker_sa=os.environ[INVOKER_SA_ENV])}}
    if delay_seconds > 0:
        run_at = datetime.now(timezone.utc) + timedelta(seconds=delay_seconds)
        payload["task"]["scheduleTime"] = run_at.isoformat().replace("+00:00", "Z")
    token = await _access_token()
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        resp = await client.post(f"{CLOUD_TASKS_API}/{queue}/tasks", json=payload,
                                 headers={"Authorization": f"Bearer {token}"})
    if resp.status_code == 409:
        return {"queued": True, "duplicate": True, "task": name}
    if resp.status_code >= 300:
        raise EnqueueError(f"Cloud Tasks returned HTTP {resp.status_code}: {resp.text[:200]}")
    return {"queued": True, "duplicate": False, "task": resp.json().get("name", name)}


def _enqueue_local(task: dict, delay_seconds: int = 0) -> dict:
    server_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env = {**os.environ, TASK_ENV_VAR: json.dumps(task), LOCAL_DELAY_ENV_VAR: str(max(int(delay_seconds), 0))}
    proc = subprocess.Popen([sys.executable, "-m", "worker.ingest_document"], cwd=server_dir, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return {"queued": True, "duplicate": False, "task": f"local-pid-{proc.pid}"}


async def enqueue_document_ingestion(task: dict, delay_seconds: int = 0) -> dict:
    """Queue a worker run now, or after `delay_seconds` (batch collection, M4')."""
    mode = ingest_mode()
    if mode == MODE_CLOUD_TASKS:
        return await _enqueue_cloud_tasks(task, delay_seconds)
    if mode == MODE_LOCAL:
        if os.environ.get("K_SERVICE") or os.environ.get("CLOUD_RUN_JOB"):
            raise EnqueueError("DOCUMENT_INGEST_MODE=local is for development only (decision P4).")
        return _enqueue_local(task, delay_seconds)
    raise EnqueueError("Document sources are not enabled on this server.")
