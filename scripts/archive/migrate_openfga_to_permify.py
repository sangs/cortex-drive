#!/usr/bin/env python3
"""
Migrate OpenFGA tuples to Permify for CortexDrive.

Reads all tuples from the live OpenFGA store (341 owner + 341 tenant_viewer)
and writes equivalent relationships into Permify. Also writes org#member tuples
that Permify needs for tenant_viewer resolution — OpenFGA resolves org membership
externally (Clerk), but Permify requires it as explicit tuples in the graph.

Tuple mapping:
  OpenFGA owner:      object=node:ID, relation=owner,         user=user:USER_ID
  → Permify:          entity={node,ID}, relation=owner,        subject={user,USER_ID,""}

  OpenFGA tenant_viewer: object=node:ID, relation=tenant_viewer, user=org:ORG_ID#member
  → Permify:          entity={node,ID}, relation=tenant_viewer, subject={org,ORG_ID,member}

  Derived org#member: entity={org,ORG_ID}, relation=member,   subject={user,USER_ID,""}
  (one tuple per unique user/org pair — Permify needs this for traversal)

Idempotent — Permify write operations are no-ops for existing data.

Usage:
    # From project root, with both proxies running in background:
    gcloud run services proxy cortex-openfga \\
      --region=us-central1 --project=cortex-drive-496915 --port=8082 &
    gcloud run services proxy cortex-permify \\
      --region=us-central1 --project=cortex-drive-496915 --port=3476 &
    sleep 5

    OPENFGA_API_URL=http://localhost:8082 \\
    OPENFGA_STORE_ID=$(gcloud secrets versions access latest --secret=OPENFGA_STORE_ID --project=cortex-drive-496915) \\
    PERMIFY_API_URL=http://localhost:3476 \\
      .venv/bin/python scripts/migrate_openfga_to_permify.py [--dry-run]
"""

import asyncio
import os
import sys
import argparse
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "mcp_server"))
from permify_utils import _write_relationships, _configured

BATCH_SIZE = 100


# ---------------------------------------------------------------------------
# OpenFGA read helpers
# ---------------------------------------------------------------------------

def _ofg_base() -> str:
    return os.environ.get("OPENFGA_API_URL", "http://localhost:8082").rstrip("/")


def _ofg_store() -> str:
    sid = os.environ.get("OPENFGA_STORE_ID", "")
    if not sid:
        print("ERROR: OPENFGA_STORE_ID is not set.")
        sys.exit(1)
    return sid


def read_all_openfga_tuples() -> list[dict]:
    """Page through the OpenFGA /read endpoint and return all raw tuple keys."""
    url = f"{_ofg_base()}/stores/{_ofg_store()}/read"
    token = ""
    all_keys: list[dict] = []

    while True:
        body: dict = {"page_size": 100}
        if token:
            body["continuation_token"] = token

        import urllib.request, json as _json
        req = urllib.request.Request(
            url,
            data=_json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            data = _json.load(r)

        for t in data.get("tuples", []):
            all_keys.append(t.get("key", {}))

        token = data.get("continuation_token", "")
        if not token:
            break

    return all_keys


# ---------------------------------------------------------------------------
# Tuple mapping: OpenFGA → Permify
# ---------------------------------------------------------------------------

def _parse_object(obj: str) -> tuple[str, str]:
    """'node:abc-123' → ('node', 'abc-123')"""
    parts = obj.split(":", 1)
    return (parts[0], parts[1]) if len(parts) == 2 else (obj, "")


def _parse_subject(user: str) -> dict:
    """
    'user:USER_ID'          → {type:user,  id:USER_ID,  relation:""}
    'org:ORG_ID#member'     → {type:org,   id:ORG_ID,   relation:member}
    """
    if "#" in user:
        base, rel = user.split("#", 1)
        typ, uid = base.split(":", 1)
        return {"type": typ, "id": uid, "relation": rel}
    typ, uid = user.split(":", 1)
    return {"type": typ, "id": uid, "relation": ""}


def map_tuples(raw_keys: list[dict]) -> tuple[list[dict], list[dict]]:
    """
    Returns (permify_rels, org_member_rels).
    permify_rels: direct 1-to-1 mappings of owner + tenant_viewer tuples.
    org_member_rels: derived org#member tuples Permify needs for traversal.
    """
    permify_rels: list[dict] = []
    user_ids: set[str] = set()
    org_ids: set[str] = set()

    for key in raw_keys:
        obj = key.get("object", "")
        relation = key.get("relation", "")
        user = key.get("user", "")

        entity_type, entity_id = _parse_object(obj)
        subject = _parse_subject(user)

        if not entity_id:
            continue

        permify_rels.append({
            "entity":   {"type": entity_type, "id": entity_id},
            "relation": relation,
            "subject":  subject,
        })

        if relation == "owner" and subject["type"] == "user":
            user_ids.add(subject["id"])
        elif relation == "tenant_viewer" and subject["type"] == "org":
            org_ids.add(subject["id"])

    # Derive org#member: every known user is a member of every known org.
    # In a single-tenant system this is always one tuple; scales cleanly
    # for multi-tenant if more users/orgs are added later.
    org_member_rels: list[dict] = [
        {
            "entity":   {"type": "org", "id": org_id},
            "relation": "member",
            "subject":  {"type": "user", "id": user_id, "relation": ""},
        }
        for org_id in sorted(org_ids)
        for user_id in sorted(user_ids)
    ]

    return permify_rels, org_member_rels


# ---------------------------------------------------------------------------
# Permify batch write
# ---------------------------------------------------------------------------

async def write_batches(rels: list[dict], label: str, dry_run: bool) -> None:
    print(f"\n[migrate] Writing {len(rels)} {label} tuples...")
    for i in range(0, len(rels), BATCH_SIZE):
        batch = rels[i : i + BATCH_SIZE]
        if dry_run:
            if i == 0:
                print(f"  [dry-run] sample: {batch[0]}")
                if len(batch) > 1:
                    print(f"  [dry-run] ... and {len(rels) - 1} more")
            continue
        await _write_relationships(batch)
        print(f"  [{min(i + BATCH_SIZE, len(rels))}/{len(rels)}] written")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main(dry_run: bool) -> None:
    if not dry_run and not _configured():
        print("ERROR: PERMIFY_API_URL is not set.")
        sys.exit(1)

    print("[migrate] Reading all tuples from OpenFGA...")
    raw_keys = read_all_openfga_tuples()
    print(f"[migrate] Found {len(raw_keys)} OpenFGA tuples.")

    from collections import Counter
    rel_counts = Counter(k.get("relation", "?") for k in raw_keys)
    for rel, cnt in sorted(rel_counts.items()):
        print(f"  {rel}: {cnt}")

    permify_rels, org_member_rels = map_tuples(raw_keys)
    print(f"\n[migrate] Mapped tuples:")
    print(f"  owner + tenant_viewer → {len(permify_rels)} Permify relationship tuples")
    print(f"  derived org#member    → {len(org_member_rels)} org membership tuples")
    print(f"  total writes          → {len(permify_rels) + len(org_member_rels)}")

    await write_batches(permify_rels, "owner+tenant_viewer", dry_run)
    await write_batches(org_member_rels, "org#member", dry_run)

    if dry_run:
        print("\n[migrate] Dry-run complete — no writes made.")
    else:
        total = len(permify_rels) + len(org_member_rels)
        print(f"\n[migrate] Done. {total} tuples written to Permify.")
        print("[migrate] Next: smoke-test can_view for a known node_id via the Permify check endpoint.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Migrate OpenFGA tuples to Permify.")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing.")
    args = parser.parse_args()
    asyncio.run(main(dry_run=args.dry_run))
