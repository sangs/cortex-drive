"""Ingestion worker entry point: one document per run (Phase B M3').

Cloud Run job: Cloud Tasks starts an execution with the task in the DOCUMENT_TASK env var
(worker/enqueue.py). Locally:
    cd src/mcp_server && DOCUMENT_TASK='{"uri": "...", "tenant_id": "...", "owner_id": "..."}' \
        ../../.venv/bin/python -m worker.ingest_document

Stage 1: fetch (SSRF-guarded) → has_changed → Docling (L1) → BAML on the text (L3) → Neo4j + Permify.
Synchronous L2 (the user is waiting): PDF figures of documents up to DOCUMENT_SYNC_L2_MAX_PAGES are
described by Claude now; everything else keeps description_status=pending for the M4' batch.
Exit code 0 = done or unchanged; 1 = failed (the status record says why).
"""
import json
import os
import sys
import time
from typing import Optional

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from schema_guard import (  # noqa: E402
    DOCUMENT_DECORATIVE_FIGURE_DESCRIPTION, DOCUMENT_FIGURE_MIN_AREA_FRACTION, DOCUMENT_INGEST_STATUS_DONE,
    DOCUMENT_INGEST_STATUS_FAILED, DOCUMENT_INGEST_STATUS_RUNNING, DOCUMENT_INGEST_STATUS_UNCHANGED,
    DOCUMENT_SYNC_L2_MAX_FIGURES, DOCUMENT_SYNC_L2_MAX_PAGES, L2_MODE_AUTO, L2_MODE_BATCH, L2_MODE_OFF,
    L2_MODES, TEST_TENANT_ID_PREFIX, WORKER_MODE_COLLECT, WORKER_MODE_DESCRIBE_PENDING, WORKER_MODE_INGEST,
    WORKER_MODES,
)
from worker.status import acquire_ingest_lock, connect, release_ingest_lock, write_status  # noqa: E402
from entity_catalog import bump_version as bump_catalog_version  # noqa: E402

TASK_ENV_VAR = "DOCUMENT_TASK"
REQUIRED_TASK_FIELDS = ("uri", "tenant_id", "owner_id")
MAX_ERROR_CHARS = 300


def load_task(raw: Optional[str] = None) -> dict:
    task = json.loads(raw if raw is not None else os.environ.get(TASK_ENV_VAR, "") or "{}")
    missing = [f for f in REQUIRED_TASK_FIELDS if not task.get(f)]
    if missing:
        raise ValueError(f"task is missing {', '.join(missing)}")
    return task


def describe_figures_sync(*, engine, describer, data: bytes, parsed, source_node_id: str, snapshot_id: str,
                          title: str) -> dict:
    """Synchronous L2 for one PDF revision. Tiny figures are marked decorative without a call;
    a refused or unusable description leaves the block pending (a later batch retries it)."""
    from worker.l2_batch import figure_jobs
    jobs, descriptions, skipped_cap = figure_jobs(engine, data, parsed.page_sizes, source_node_id, snapshot_id,
                                                  DOCUMENT_SYNC_L2_MAX_FIGURES)
    unusable = 0
    for block, png in jobs:
        result = describer.describe(png, section_path=block.get("section_path") or [], figure_text=block.get("text") or "")
        if result is None:
            unusable += 1
        elif result.is_decorative:
            descriptions[block["node_id"]] = DOCUMENT_DECORATIVE_FIGURE_DESCRIPTION
        else:
            descriptions[block["node_id"]] = result.as_block_text()
    applied = engine.apply_figure_descriptions(source_node_id=source_node_id, snapshot_id=snapshot_id,
                                               title=title, descriptions=descriptions)
    return {**applied, "mode": "sync", "left_pending_cap": skipped_cap, "left_pending_unusable": unusable,
            "l2_input_tokens": getattr(describer, "input_tokens", 0),
            "l2_output_tokens": getattr(describer, "output_tokens", 0)}


def resolve_l2_mode(task: dict) -> str:
    """The task's "l2" (auto | batch | off). Legacy "sync_l2": false → off, so commands written before
    M4' (which meant "no Claude calls") can never start spending; true or absent → auto."""
    mode = task.get("l2")
    if mode is None:
        mode = L2_MODE_AUTO if task.get("sync_l2", True) else L2_MODE_OFF
    if mode not in L2_MODES:
        raise ValueError(f"l2 must be one of {L2_MODES}, got {mode!r}")
    return mode


def default_enqueue(task: dict, delay_seconds: int) -> None:
    """Queue a worker run (collect / describe_pending) through Cloud Tasks (or local mode)."""
    import asyncio
    from worker.enqueue import enqueue_document_ingestion
    asyncio.run(enqueue_document_ingestion(task, delay_seconds))


def safe_enqueue(enqueue):
    """Queueing a follow-up must never fail the run: without a configured queue (e.g. the feature flag is
    off) the batch still exists and can be collected with a manual `collect` run."""
    def _enqueue(task: dict, delay_seconds: int) -> None:
        try:
            enqueue(task, delay_seconds)
        except Exception as e:  # noqa: BLE001
            print(f"[worker] follow-up {task.get('mode')} not queued ({type(e).__name__}: {e}); "
                  f"run it manually: DOCUMENT_TASK={json.dumps(task)}")
    return _enqueue


def build_describer():
    from parsing.visual_describer import ClaudeVisualDescriber
    return ClaudeVisualDescriber() if ClaudeVisualDescriber.available() else None


def run(task: dict, *, parser=None, describer=None, transport=None, redis_client=None, enqueue=None) -> dict:
    """Ingest one document. `parser`, `describer`, `transport` and `redis_client` are injectable for
    tests; in production they are built here. Returns the summary written to the status record.
    Holds a per-document lock for the whole run (see DOCUMENT_INGEST_LOCK_TTL_SECONDS)."""
    uri, tenant_id, owner_id = task["uri"], task["tenant_id"], task["owner_id"]
    _prepare_tenant(tenant_id)
    started = time.monotonic()
    redis_client = redis_client or connect()
    lock = acquire_ingest_lock(tenant_id, uri, redis_client)   # raises LockUnavailableError: never ingest unlocked
    if lock is None:
        print(f"[worker] another run is already ingesting {uri}; exiting without changes")
        return {"state": "skipped_already_running"}
    try:
        return _run_locked(task, parser=parser, describer=describer, transport=transport,
                           redis_client=redis_client, started=started, enqueue=safe_enqueue(enqueue or default_enqueue))
    finally:
        release_ingest_lock(tenant_id, uri, lock, redis_client)


def _run_locked(task: dict, *, parser, describer, transport, redis_client, started: float, enqueue) -> dict:
    from ingestion.adapters.document_url import DocumentUrlAdapter, title_hint_from
    from ingestion_engine import IngestionEngine
    from parsing.structure_parser import MIME_PDF

    uri, tenant_id, owner_id = task["uri"], task["tenant_id"], task["owner_id"]
    write_status(tenant_id, uri, DOCUMENT_INGEST_STATUS_RUNNING, redis_client)
    if parser is None:
        from parsing.docling_parser import DoclingParser
        parser = DoclingParser()
    graph_tenant, visibility = engine_scope(task)
    adapter = DocumentUrlAdapter(uri, os.environ["NEO4J_URI"], os.environ["NEO4J_USERNAME"],
                                 os.environ["NEO4J_PASSWORD"], graph_tenant, owner_id,
                                 parser=parser, transport=transport)
    engine = IngestionEngine(tenant_id=graph_tenant, visibility=visibility)
    try:
        if not adapter.get_unprocessed_items():
            summary = {"seconds": round(time.monotonic() - started, 1)}
            write_status(tenant_id, uri, DOCUMENT_INGEST_STATUS_UNCHANGED, redis_client, **summary)
            return {"state": DOCUMENT_INGEST_STATUS_UNCHANGED, **summary}
        result = adapter.process_item(uri, engine)
        bump_catalog_version(redis_client, graph_tenant)   # S2-60: the title routes from the next question
        parsed = result.pop("parsed")
        summary = {k: result[k] for k in ("source_node_id", "blocks", "entities", "grounded_links")}
        summary["pages"] = parsed.page_count
        doc = adapter.last_fetch
        title = title_hint_from(parsed) or doc.filename or uri
        l2 = resolve_l2_mode(task)
        is_pdf = doc.mime_type == MIME_PDF
        small = (parsed.page_count or 0) <= DOCUMENT_SYNC_L2_MAX_PAGES
        if l2 == L2_MODE_OFF or not is_pdf:
            summary["figures"] = {"described": 0, "reason": "l2 off" if l2 == L2_MODE_OFF
                                  else "figure crops are PDF-only; left pending"}
        else:
            if describer is None:
                describer = build_describer()
            if describer is None:
                summary["figures"] = {"described": 0, "reason": "no L2 credentials configured"}
            elif l2 == L2_MODE_AUTO and small:
                summary["figures"] = describe_figures_sync(
                    engine=engine, describer=describer, data=doc.data, parsed=parsed,
                    source_node_id=result["source_node_id"], snapshot_id=result["snapshot_id"], title=title)
            else:
                from worker.l2_batch import submit_figure_batch
                summary["figures"] = submit_figure_batch(
                    engine=engine, describer=describer, redis_client=redis_client, enqueue=enqueue,
                    data=doc.data, page_sizes=parsed.page_sizes, task=task,
                    source_node_id=result["source_node_id"], snapshot_id=result["snapshot_id"], title=title)
        summary["seconds"] = round(time.monotonic() - started, 1)
        write_status(tenant_id, uri, DOCUMENT_INGEST_STATUS_DONE, redis_client, **summary)
        return {"state": DOCUMENT_INGEST_STATUS_DONE, **summary}
    except Exception as e:  # noqa: BLE001 — recorded for the user, then re-raised for the job's exit code
        write_status(tenant_id, uri, DOCUMENT_INGEST_STATUS_FAILED, redis_client,
                     error=f"{type(e).__name__}: {e}"[:MAX_ERROR_CHARS])
        raise
    finally:
        engine.close()
        adapter.close()


def engine_scope(task: dict) -> tuple:
    """(graph tenant, visibility) for this task's IngestionEngine (S2-44 / M5-11). A public document is
    stored in the PUBLIC tier; status records stay under the requesting organization (task tenant_id).
    Tasks queued before 2026-10-26 carry no visibility: they keep the pre-M5 behaviour (organization)."""
    from schema_guard import (PUBLIC_TENANT_ID, SOURCE_VISIBILITY_PUBLIC, INGESTION_ENGINE_DEFAULT_VISIBILITY,
                              SOURCE_VISIBILITIES)
    visibility = task.get("visibility") or INGESTION_ENGINE_DEFAULT_VISIBILITY
    if visibility not in SOURCE_VISIBILITIES:
        raise ValueError(f"unknown visibility {visibility!r}")
    return (PUBLIC_TENANT_ID if visibility == SOURCE_VISIBILITY_PUBLIC else task["tenant_id"]), visibility


def _prepare_tenant(tenant_id: str) -> None:
    if tenant_id.startswith(TEST_TENANT_ID_PREFIX):
        os.environ.pop("PERMIFY_API_URL", None)   # test tenants never write Permify tuples (user rule)
        os.environ["TEST_TENANT"] = tenant_id


def run_collect(task: dict, *, describer=None, redis_client=None, enqueue=None) -> dict:
    """One poll of a figure batch (M4'). No per-document lock: writes are scoped to the batch's revision,
    and a stale revision's results are discarded."""
    from ingestion_engine import IngestionEngine
    from worker.l2_batch import collect_batch
    _prepare_tenant(task["tenant_id"])
    describer = describer or build_describer()
    if describer is None:
        raise RuntimeError("no L2 credentials configured; can't collect a batch")
    graph_tenant, visibility = engine_scope(task)
    engine = IngestionEngine(tenant_id=graph_tenant, visibility=visibility)
    try:
        return collect_batch(task=task, engine=engine, describer=describer, redis_client=redis_client or connect(),
                             enqueue=safe_enqueue(enqueue or default_enqueue), write_status=write_status)
    finally:
        engine.close()


def run_describe_pending(task: dict, *, describer=None, redis_client=None, enqueue=None, transport=None) -> dict:
    """Re-submit still-pending figures of the CURRENT revision (retry of failed batch items). Re-fetches the
    document for the crops; if its content no longer matches the current snapshot, does nothing (the new
    revision's own ingest handles its figures)."""
    from ingestion.adapters.document_url import fetch_public_document
    from ingestion_engine import IngestionEngine
    from parsing.structure_parser import MIME_PDF
    from worker.l2_batch import pdf_page_sizes, submit_figure_batch
    _prepare_tenant(task["tenant_id"])
    describer = describer or build_describer()
    if describer is None:
        raise RuntimeError("no L2 credentials configured")
    graph_tenant, visibility = engine_scope(task)
    engine = IngestionEngine(tenant_id=graph_tenant, visibility=visibility)
    try:
        with engine.driver.session() as session:
            rec = session.run("""MATCH (d:DocumentSource {tenant_id: $t, uri: $u})
                                 MATCH (d)-[:HAS_SNAPSHOT]->(s:SourceSnapshot {is_current: true})
                                 RETURN d.node_id AS source_id, d.name AS title, s.node_id AS snapshot_id,
                                        s.content_hash AS content_hash""", t=graph_tenant, u=task["uri"]).single()
        if not rec:
            return {"state": "no_current_revision"}
        doc = fetch_public_document(task["uri"], transport=transport)
        if doc.mime_type != MIME_PDF or doc.content_hash != rec["content_hash"]:
            return {"state": "skipped_document_changed_or_not_pdf"}
        return submit_figure_batch(engine=engine, describer=describer, redis_client=redis_client or connect(),
                                   enqueue=safe_enqueue(enqueue or default_enqueue), data=doc.data,
                                   page_sizes=pdf_page_sizes(doc.data), task=task, source_node_id=rec["source_id"],
                                   snapshot_id=rec["snapshot_id"], title=rec["title"] or task["uri"],
                                   attempt=int(task.get("attempt", 2)))
    finally:
        engine.close()


def dispatch(task: dict) -> dict:
    mode = task.get("mode") or WORKER_MODE_INGEST
    if mode not in WORKER_MODES:
        raise ValueError(f"mode must be one of {WORKER_MODES}, got {mode!r}")
    if mode == WORKER_MODE_COLLECT:
        return run_collect(task)
    if mode == WORKER_MODE_DESCRIBE_PENDING:
        return run_describe_pending(task)
    return run(task)


def main() -> int:
    from worker.enqueue import LOCAL_DELAY_ENV_VAR
    delay = int(os.environ.get(LOCAL_DELAY_ENV_VAR, "0") or 0)
    if delay > 0 and not (os.environ.get("K_SERVICE") or os.environ.get("CLOUD_RUN_JOB")):
        time.sleep(delay)   # local mode only: Cloud Tasks schedules delays itself
    task = load_task()
    print(f"[worker] {task.get('mode') or WORKER_MODE_INGEST} {task['uri']} for tenant {task['tenant_id']}")
    try:
        summary = dispatch(task)
    except Exception as e:  # noqa: BLE001
        print(f"[worker] FAILED: {type(e).__name__}: {e}")
        return 1
    print(f"[worker] {json.dumps(summary)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
