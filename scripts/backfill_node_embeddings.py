#!/usr/bin/env python3
"""
backfill_node_embeddings.py — Idempotent reconciliation for node-metadata embeddings.

Computes `metadata_embedding` (name + description + tags ONLY, never a node's full content)
for every node whose label is in domain_registry.EMBEDDABLE_LABELS and that doesn't have one
yet, stamping the shared `:Embeddable` secondary label on write.

Why a reconciliation script rather than a single write-path hook: seed_resume_graph.py (the
source of most career-graph content) writes raw Cypher and never calls validate_upsert() —
confirmed via grep, zero calls — so there is no single write path this could hook into
reliably. This script is safe to run after any seeder pass, after ingestion, or on a schedule;
it only ever touches nodes missing an embedding, so re-running it is always safe.

See: documents/architecture/node-metadata-embedding-hybrid-retrieval-2026-09-04.md

Run manually:
    .venv/bin/python scripts/backfill_node_embeddings.py

Prerequisite: scripts/create_node_metadata_vector_index.py (creates nodeMetadataIndex) should
be run once before or after this script — order doesn't matter, the index just needs to exist
before any semantic query is issued against it.
"""

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
sys.path.append(str(REPO_ROOT / 'src' / 'mcp_server'))

from dotenv import load_dotenv
load_dotenv(REPO_ROOT / '.env', override=True)

from expert_tools import ExpertTools
from domain_registry import EMBEDDABLE_LABELS


def main():
    tenant_id = os.environ.get("TENANT_ID")
    owner_id = os.environ.get("OWNER_USER_ID", "backfill-script")
    if not tenant_id:
        print("ERROR: TENANT_ID not set in .env — required to construct ExpertTools "
              "(the actual backfill query is not tenant-scoped; this is only for client setup).")
        sys.exit(1)

    # allowed_ids=[] with no guest_share_anchor would restrict every _get_security_clause() call
    # to nothing — irrelevant here since the backfill query below carries no security clause at
    # all (a deliberate, unscoped admin/maintenance query, not a per-user retrieval), but noted
    # so a future reader doesn't assume this instance is meaningfully tenant-scoped.
    expert = ExpertTools(tenant_id=tenant_id, requesting_user_id=owner_id)

    print(f"Scanning for EMBEDDABLE_LABELS nodes missing metadata_embedding: {EMBEDDABLE_LABELS}")

    result = expert._exec_query(
        """
        MATCH (n)
        WHERE labels(n)[0] IN $labels AND n.metadata_embedding IS NULL
        RETURN elementId(n) AS eid, labels(n)[0] AS label, properties(n) AS props
        """,
        labels=EMBEDDABLE_LABELS,
    )
    candidates = result.records
    total = len(candidates)
    print(f"Found {total} node(s) needing a metadata_embedding.")

    if total == 0:
        print("Nothing to do.")
        return

    updated = 0
    failed = 0
    for i, rec in enumerate(candidates, start=1):
        eid = rec["eid"]
        label = rec["label"]
        props = rec["props"]
        text = ExpertTools._resolve_embeddable_text(label, props)
        name = props.get("name") or props.get("title") or props.get("id") or "(unnamed)"
        try:
            embedding = expert.get_embedding(text)
            expert._exec_query(
                """
                MATCH (n) WHERE elementId(n) = $eid
                SET n.metadata_embedding = $embedding
                SET n:Embeddable
                """,
                eid=eid,
                embedding=embedding,
            )
            updated += 1
            if i % 25 == 0 or i == total:
                print(f"  [{i}/{total}] embedded (last: {name!r} [{label}])")
        except Exception as e:
            failed += 1
            print(f"  [{i}/{total}] FAILED for {name!r} [{label}]: {e}")

    print(f"Done. updated={updated} failed={failed} skipped=0 (only unset nodes were queried).")


if __name__ == "__main__":
    main()
