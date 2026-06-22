"""
Delete OpenFGA tuples whose Neo4j elementId database UUID no longer matches
the live Neo4j database.

Background:
  Neo4j Aura embeds a database UUID in every elementId: 4:<db-uuid>:<node-num>.
  If Aura performs a silent version upgrade or the database is recreated, this UUID
  changes while the Aura hostname stays the same. OpenFGA tuples written before the
  change become stale — they reference nodes that no longer exist in Neo4j.
  Those stale tuples cause listObjects to return wrong IDs, breaking elementId-based
  security checks (the tenant_id fallback in expert_tools.py compensates, but the
  root cause should be resolved).

Usage (via Cloud Run proxy — avoids OIDC token management for user accounts):
  # Terminal 1: start proxy (keep running while this script runs)
  gcloud run services proxy cortex-openfga \\
    --region=us-central1 --project=cortex-drive-496915 --port=8091

  # Terminal 2:
  .venv/bin/python scripts/cleanup_stale_openfga_tuples.py \\
    --store-id 01KTCXG45MEHQJ3WCJMB9PSFFY \\
    --stale-uuid 12b85116-32f4-4673-8b95-71c0b6fce863 \\
    --openfga-url http://localhost:8091

  Add --dry-run to preview without committing.
"""

import argparse
import sys

import requests


BATCH_SIZE = 10  # OpenFGA write endpoint limit per request


def read_all_tuples(base_url: str, store_id: str) -> list[dict]:
    """Page through all tuples in the store using POST /read."""
    all_tuples = []
    continuation_token = None
    page = 1

    while True:
        body = {}
        if continuation_token:
            body["continuation_token"] = continuation_token

        resp = requests.post(
            f"{base_url}/stores/{store_id}/read",
            json=body,
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()

        tuples = data.get("tuples", [])
        all_tuples.extend(tuples)
        continuation_token = data.get("continuation_token")
        print(f"  Page {page}: {len(tuples)} tuples (total so far: {len(all_tuples)})")
        page += 1

        if not continuation_token:
            break

    return all_tuples


def delete_tuples_batch(base_url: str, store_id: str, batch: list[dict]) -> None:
    """Delete up to BATCH_SIZE tuples via POST /write with deletes list."""
    deletes = [
        {
            "user": t["key"]["user"],
            "relation": t["key"]["relation"],
            "object": t["key"]["object"],
        }
        for t in batch
    ]
    resp = requests.post(
        f"{base_url}/stores/{store_id}/write",
        json={"deletes": {"tuple_keys": deletes}},
        timeout=30,
    )
    if resp.status_code not in (200, 204):
        print(f"  WARNING: batch delete returned {resp.status_code}: {resp.text[:200]}")
        resp.raise_for_status()


def main():
    parser = argparse.ArgumentParser(description="Delete stale OpenFGA tuples by Neo4j database UUID")
    parser.add_argument("--store-id", required=True, help="OpenFGA store ID")
    parser.add_argument(
        "--stale-uuid",
        required=True,
        help="Neo4j database UUID whose tuples should be removed (e.g. 12b85116-...)",
    )
    parser.add_argument(
        "--openfga-url",
        default="http://localhost:8091",
        help="OpenFGA API URL — point to Cloud Run proxy (default: http://localhost:8091)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Preview without deleting")
    args = parser.parse_args()

    base_url = args.openfga_url.rstrip("/")
    # OpenFGA encoding: elementId colons → dots, but UUID hyphens are preserved.
    # elementId 4:12b85116-...:1 → object node:4.12b85116-....1
    # So the stale UUID appears with its original hyphens inside the object string.
    stale_marker = args.stale_uuid

    print(f"OpenFGA: {base_url}")
    print(f"Store:   {args.store_id}")
    print(f"Stale UUID: {args.stale_uuid}")
    if args.dry_run:
        print("DRY RUN — no deletions will be committed")
    print()

    # --- Phase 1: scan ---
    print("=== Phase 1: Scanning all tuples ===")
    all_tuples = read_all_tuples(base_url, args.store_id)
    print(f"Total tuples in store: {len(all_tuples)}\n")

    stale = [t for t in all_tuples if stale_marker in t.get("key", {}).get("object", "")]
    print(f"Stale tuples to delete: {len(stale)}")
    if not stale:
        print("Nothing to delete. Store is already clean.")
        return

    # --- Phase 2: delete ---
    print(f"\n=== Phase 2: {'Previewing' if args.dry_run else 'Deleting'} {len(stale)} stale tuples ===")

    if args.dry_run:
        for t in stale[:10]:
            print(f"  would delete: {t['key']['relation']} | {t['key']['user']} | {t['key']['object']}")
        if len(stale) > 10:
            print(f"  ... and {len(stale) - 10} more")
        print(f"\nDry run complete. {len(stale)} tuples would be deleted.")
        return

    deleted = 0
    for i in range(0, len(stale), BATCH_SIZE):
        batch = stale[i:i + BATCH_SIZE]
        delete_tuples_batch(base_url, args.store_id, batch)
        deleted += len(batch)
        if deleted % 100 == 0 or deleted == len(stale):
            print(f"  {deleted}/{len(stale)} deleted ...")

    # --- Phase 3: verify ---
    print(f"\n=== Phase 3: Verifying cleanup ===")
    remaining = read_all_tuples(base_url, args.store_id)
    still_stale = [t for t in remaining if stale_marker in t.get("key", {}).get("object", "")]

    if still_stale:
        print(f"WARNING: {len(still_stale)} stale tuples still remain after deletion!")
        sys.exit(1)
    else:
        print(f"Cleanup verified. Store now has {len(remaining)} tuples (all current).")


if __name__ == "__main__":
    main()
