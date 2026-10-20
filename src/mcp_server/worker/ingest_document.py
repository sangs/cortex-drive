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
    DOCUMENT_SYNC_L2_MAX_FIGURES, DOCUMENT_SYNC_L2_MAX_PAGES, TEST_TENANT_ID_PREFIX,
)
from worker.status import acquire_ingest_lock, connect, release_ingest_lock, write_status  # noqa: E402

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
    a refused or unusable description leaves the block pending (the batch path retries it)."""
    from parsing.visual_describer import render_pdf_figure
    descriptions, skipped_cap, unusable = {}, 0, 0
    for i, block in enumerate(engine.pending_visual_blocks(source_node_id, snapshot_id)):
        if i >= DOCUMENT_SYNC_L2_MAX_FIGURES:
            skipped_cap += 1
            continue
        if not block.get("page") or not block.get("bbox"):
            continue
        width, height = parsed.page_sizes.get(block["page"], (0, 0))
        x0, y0, x1, y1 = block["bbox"]
        if width and height and (x1 - x0) * (y1 - y0) < DOCUMENT_FIGURE_MIN_AREA_FRACTION * width * height:
            descriptions[block["node_id"]] = DOCUMENT_DECORATIVE_FIGURE_DESCRIPTION
            continue
        png = render_pdf_figure(data, block["page"], block["bbox"], (width, height) if width else None)
        result = describer.describe(png, section_path=block.get("section_path") or [], figure_text=block.get("text") or "")
        if result is None:
            unusable += 1
        elif result.is_decorative:
            descriptions[block["node_id"]] = DOCUMENT_DECORATIVE_FIGURE_DESCRIPTION
        else:
            descriptions[block["node_id"]] = result.as_block_text()
    applied = engine.apply_figure_descriptions(source_node_id=source_node_id, snapshot_id=snapshot_id,
                                               title=title, descriptions=descriptions)
    return {**applied, "left_pending_cap": skipped_cap, "left_pending_unusable": unusable,
            "l2_input_tokens": getattr(describer, "input_tokens", 0),
            "l2_output_tokens": getattr(describer, "output_tokens", 0)}


def run(task: dict, *, parser=None, describer=None, transport=None, redis_client=None) -> dict:
    """Ingest one document. `parser`, `describer`, `transport` and `redis_client` are injectable for
    tests; in production they are built here. Returns the summary written to the status record.
    Holds a per-document lock for the whole run (see DOCUMENT_INGEST_LOCK_TTL_SECONDS)."""
    uri, tenant_id, owner_id = task["uri"], task["tenant_id"], task["owner_id"]
    if tenant_id.startswith(TEST_TENANT_ID_PREFIX):
        os.environ.pop("PERMIFY_API_URL", None)   # test tenants never write Permify tuples (user rule)
        os.environ["TEST_TENANT"] = tenant_id      # schema_guard accepts org_… tenants or this configured one
    started = time.monotonic()
    redis_client = redis_client or connect()
    lock = acquire_ingest_lock(tenant_id, uri, redis_client)   # raises LockUnavailableError: never ingest unlocked
    if lock is None:
        print(f"[worker] another run is already ingesting {uri}; exiting without changes")
        return {"state": "skipped_already_running"}
    try:
        return _run_locked(task, parser=parser, describer=describer, transport=transport,
                           redis_client=redis_client, started=started)
    finally:
        release_ingest_lock(tenant_id, uri, lock, redis_client)


def _run_locked(task: dict, *, parser, describer, transport, redis_client, started: float) -> dict:
    from ingestion.adapters.document_url import DocumentUrlAdapter, title_hint_from
    from ingestion_engine import IngestionEngine
    from parsing.structure_parser import MIME_PDF

    uri, tenant_id, owner_id = task["uri"], task["tenant_id"], task["owner_id"]
    write_status(tenant_id, uri, DOCUMENT_INGEST_STATUS_RUNNING, redis_client)
    if parser is None:
        from parsing.docling_parser import DoclingParser
        parser = DoclingParser()
    adapter = DocumentUrlAdapter(uri, os.environ["NEO4J_URI"], os.environ["NEO4J_USERNAME"],
                                 os.environ["NEO4J_PASSWORD"], tenant_id, owner_id,
                                 parser=parser, transport=transport)
    engine = IngestionEngine(tenant_id=tenant_id)
    try:
        if not adapter.get_unprocessed_items():
            summary = {"seconds": round(time.monotonic() - started, 1)}
            write_status(tenant_id, uri, DOCUMENT_INGEST_STATUS_UNCHANGED, redis_client, **summary)
            return {"state": DOCUMENT_INGEST_STATUS_UNCHANGED, **summary}
        result = adapter.process_item(uri, engine)
        parsed = result.pop("parsed")
        summary = {k: result[k] for k in ("source_node_id", "blocks", "entities", "grounded_links")}
        summary["pages"] = parsed.page_count
        doc = adapter.last_fetch
        sync_ok = (task.get("sync_l2", True) and doc.mime_type == MIME_PDF
                   and (parsed.page_count or 0) <= DOCUMENT_SYNC_L2_MAX_PAGES)
        if sync_ok and describer is None:
            from parsing.visual_describer import ClaudeVisualDescriber
            describer = ClaudeVisualDescriber() if ClaudeVisualDescriber.available() else None
        if sync_ok and describer is not None:
            summary["figures"] = describe_figures_sync(
                engine=engine, describer=describer, data=doc.data, parsed=parsed,
                source_node_id=result["source_node_id"], snapshot_id=result["snapshot_id"],
                title=title_hint_from(parsed) or doc.filename or uri)
        else:
            summary["figures"] = {"described": 0, "reason": "left pending for the stage-2 batch"
                                  if not sync_ok else "no L2 credentials configured"}
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


def main() -> int:
    task = load_task()
    print(f"[worker] ingesting {task['uri']} for tenant {task['tenant_id']}")
    try:
        summary = run(task)
    except Exception as e:  # noqa: BLE001
        print(f"[worker] FAILED: {type(e).__name__}: {e}")
        return 1
    print(f"[worker] {json.dumps(summary)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
