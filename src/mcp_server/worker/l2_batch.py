"""Batch figure descriptions (Phase B M4'; build plan §1.13, decisions M4-1..M4-4 approved 2026-10-20).

Submit: at the end of stage 1, a document not eligible for synchronous descriptions gets ONE Claude
Message Batch (50% price) for its pending PDF figures. Each request is exactly the synchronous request
(ClaudeVisualDescriber.request_params); custom_id = the figure block's node_id. The batch is recorded in
Redis (M4-2, never in the graph) and a "collect" run is queued 15 minutes later (M4-1).

Collect: not ended → queue the next poll (give up after 26 h). Ended → if the document's snapshot is no
longer current, discard (the new revision submits its own batch); otherwise apply the descriptions with
the existing apply_figure_descriptions (BAML on descriptions, derived_by=vlm links, grounding, Permify).
Failed items stay pending and are re-submitted by a describe_pending run, up to DOCUMENT_BATCH_MAX_ATTEMPTS.

The Neo4j `description_status: pending` flags are the source of truth: a lost Redis record only delays
descriptions. Spend (tokens, batch price) is recorded per batch and in the document's job status.
"""
import json
import os
import sys
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional, Tuple

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from schema_guard import (  # noqa: E402
    DOCUMENT_BATCH_COLLECT_DELAY_SECONDS, DOCUMENT_BATCH_COLLECT_GIVE_UP_SECONDS, DOCUMENT_BATCH_KEY_PREFIX,
    DOCUMENT_BATCH_L2_MAX_FIGURES, DOCUMENT_BATCH_MAX_ATTEMPTS, DOCUMENT_BATCH_TTL_SECONDS,
    DOCUMENT_DECORATIVE_FIGURE_DESCRIPTION, DOCUMENT_FIGURE_MIN_AREA_FRACTION, DOCUMENT_INGEST_STATUS_DONE,
    WORKER_MODE_COLLECT, WORKER_MODE_DESCRIBE_PENDING,
)

BATCH_ENDED = "ended"
# Enqueue function: (task, delay_seconds) -> None. Injected in tests; production uses enqueue.py.
Enqueue = Callable[[dict, int], None]


def batch_key(batch_id: str) -> str:
    return f"{DOCUMENT_BATCH_KEY_PREFIX}:{batch_id}"


def pdf_page_sizes(data: bytes) -> Dict[int, Tuple[float, float]]:
    """Page sizes in points without re-running Docling (describe_pending runs have no parse)."""
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument(data)
    try:
        return {i + 1: tuple(pdf[i].get_size()) for i in range(len(pdf))}
    finally:
        pdf.close()


def figure_jobs(engine, data: bytes, page_sizes: Dict[int, Tuple[float, float]], source_node_id: str,
                snapshot_id: str, max_figures: int):
    """Shared by the synchronous and batch paths. Returns (jobs, decorative, skipped_cap):
    jobs = [(block, png)] to describe; decorative = {node_id: marker} for figures too small to describe
    (no call); skipped_cap = figures over `max_figures`, left pending."""
    from parsing.visual_describer import render_pdf_figure
    jobs, decorative, skipped_cap = [], {}, 0
    for block in engine.pending_visual_blocks(source_node_id, snapshot_id):
        if not block.get("page") or not block.get("bbox"):
            continue
        width, height = page_sizes.get(block["page"], (0, 0))
        x0, y0, x1, y1 = block["bbox"]
        if width and height and (x1 - x0) * (y1 - y0) < DOCUMENT_FIGURE_MIN_AREA_FRACTION * width * height:
            decorative[block["node_id"]] = DOCUMENT_DECORATIVE_FIGURE_DESCRIPTION
            continue
        if len(jobs) >= max_figures:
            skipped_cap += 1
            continue
        jobs.append((block, render_pdf_figure(data, block["page"], block["bbox"], (width, height) if width else None)))
    return jobs, decorative, skipped_cap


def submit_figure_batch(*, engine, describer, redis_client, enqueue: Enqueue, data: bytes,
                        page_sizes: Dict[int, Tuple[float, float]], task: dict, source_node_id: str,
                        snapshot_id: str, title: str, attempt: int = 1) -> dict:
    """Submit one batch for the revision's pending figures (up to DOCUMENT_BATCH_L2_MAX_FIGURES)."""
    jobs, decorative, skipped_cap = figure_jobs(engine, data, page_sizes, source_node_id, snapshot_id,
                                                DOCUMENT_BATCH_L2_MAX_FIGURES)
    if decorative:   # marked done now; never sent
        engine.apply_figure_descriptions(source_node_id=source_node_id, snapshot_id=snapshot_id,
                                         title=title, descriptions=decorative)
    summary = {"mode": "batch", "decorative": len(decorative), "left_pending_cap": skipped_cap, "attempt": attempt}
    if not jobs:
        return {**summary, "submitted": 0}
    requests = [(block["node_id"], describer.request_params(png, section_path=block.get("section_path") or [],
                                                            figure_text=block.get("text") or ""))
                for block, png in jobs]
    batch_id = describer.submit_batch(requests)
    record = {"batch_id": batch_id, "tenant_id": task["tenant_id"], "owner_id": task["owner_id"], "uri": task["uri"],
              "visibility": task.get("visibility"),
              "source_node_id": source_node_id, "snapshot_id": snapshot_id, "title": title, "attempt": attempt,
              "figures": len(jobs), "submitted_at": datetime.now(timezone.utc).isoformat()}
    redis_client.setex(batch_key(batch_id), DOCUMENT_BATCH_TTL_SECONDS, json.dumps(record))
    enqueue(collect_task(record, poll=1), DOCUMENT_BATCH_COLLECT_DELAY_SECONDS)
    return {**summary, "submitted": len(jobs), "batch_id": batch_id}


def collect_task(record: dict, poll: int) -> dict:
    return {"mode": WORKER_MODE_COLLECT, "batch_id": record["batch_id"], "poll": poll,
            "uri": record["uri"], "tenant_id": record["tenant_id"], "owner_id": record["owner_id"],
            "visibility": record.get("visibility")}


def collect_batch(*, task: dict, engine, describer, redis_client, enqueue: Enqueue,
                  write_status: Optional[Callable] = None, now: Optional[datetime] = None) -> dict:
    """One poll of a batch. Returns a summary (also logged by the worker)."""
    raw = redis_client.get(batch_key(task["batch_id"]))
    if not raw:
        return {"state": "unknown_batch", "batch_id": task["batch_id"]}
    record = json.loads(raw)
    status = describer.batch_status(record["batch_id"])
    if status["processing_status"] != BATCH_ENDED:
        age = ((now or datetime.now(timezone.utc)) - datetime.fromisoformat(record["submitted_at"])).total_seconds()
        if age > DOCUMENT_BATCH_COLLECT_GIVE_UP_SECONDS:
            redis_client.delete(batch_key(record["batch_id"]))
            return {"state": "gave_up", "batch_id": record["batch_id"], "age_seconds": int(age)}
        enqueue(collect_task(record, poll=int(task.get("poll", 1)) + 1), DOCUMENT_BATCH_COLLECT_DELAY_SECONDS)
        return {"state": "waiting", "batch_id": record["batch_id"], **status}

    if engine._current_snapshot_id('DocumentSource', record["source_node_id"]) != record["snapshot_id"]:
        redis_client.delete(batch_key(record["batch_id"]))
        return {"state": "discarded_stale_revision", "batch_id": record["batch_id"]}

    descriptions, failed, unusable, tokens_in, tokens_out = {}, 0, 0, 0, 0
    for custom_id, desc, kind, t_in, t_out in describer.batch_results(record["batch_id"]):
        tokens_in, tokens_out = tokens_in + t_in, tokens_out + t_out
        if kind != "succeeded":
            failed += 1
        elif desc is None:
            unusable += 1
        else:
            descriptions[custom_id] = DOCUMENT_DECORATIVE_FIGURE_DESCRIPTION if desc.is_decorative else desc.as_block_text()
    applied = engine.apply_figure_descriptions(source_node_id=record["source_node_id"],
                                               snapshot_id=record["snapshot_id"], title=record["title"],
                                               descriptions=descriptions)
    redis_client.delete(batch_key(record["batch_id"]))
    retry = None
    if (failed or unusable) and record["attempt"] < DOCUMENT_BATCH_MAX_ATTEMPTS:
        retry = {"mode": WORKER_MODE_DESCRIBE_PENDING, "attempt": record["attempt"] + 1, "uri": record["uri"],
                 "visibility": record.get("visibility"),
                 "tenant_id": record["tenant_id"], "owner_id": record["owner_id"]}
        enqueue(retry, 0)
    summary = {"state": "applied", "batch_id": record["batch_id"], "attempt": record["attempt"],
               **applied, "failed": failed, "unusable": unusable, "retry_queued": bool(retry),
               "l2_batch_input_tokens": tokens_in, "l2_batch_output_tokens": tokens_out}
    if write_status:
        write_status(record["tenant_id"], record["uri"], DOCUMENT_INGEST_STATUS_DONE, redis_client, figures=summary)
    return summary
