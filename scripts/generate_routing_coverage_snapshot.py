#!/usr/bin/env python3
"""
Coverage snapshot for the offline routing evaluation (cross-domain discovery design 2026-11-09 §4.1, evaluation gate).

For each topic used in cortex-gateway/tests/routing_eval/routing_eval_set.json, record which content domains the owner
can see content on, using the product coverage check (ExpertTools.domain_coverage). The routing evaluation then runs
offline (no network) with this snapshot standing in for the live check. Read-only.

    ENABLE_DOCUMENT_DOMAIN=true .venv/bin/python scripts/generate_routing_coverage_snapshot.py
"""
import json
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))
from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(ROOT, ".env"))
from expert_tools import ExpertTools  # noqa: E402

OUT = os.path.join(ROOT, "cortex-gateway", "tests", "routing_eval", "coverage_snapshot.json")
EVAL = os.path.join(ROOT, "cortex-gateway", "tests", "routing_eval", "topics.json")
# Gateway domain names (classifier) ↔ content domains (registry).
TO_GATEWAY = {"professional": "career", "podcast": "podcast", "website": "website", "document": "document"}


def main():
    topics = json.load(open(EVAL))["topics"]
    tools = ExpertTools(tenant_id=os.environ.get("TENANT_ID", ""))
    try:
        coverage = {}
        for t in topics:
            c = tools.domain_coverage([t])
            coverage[t.lower()] = sorted(TO_GATEWAY[d] for d, hit in c.items() if hit)
            print(f"{t:40} {coverage[t.lower()]}")
    finally:
        tools.close()
    json.dump({"generated_at": datetime.now(timezone.utc).isoformat(), "viewer": "owner (internal call)",
               "coverage": coverage}, open(OUT, "w"), indent=1, sort_keys=True)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
