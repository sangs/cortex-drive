"""
Daily push of cortex-drive's OpenAI spend to finops-admin (FinOps design 2026-11-16 §4, tracker S2-83 release 2).

    python finops_push.py                  # push the trailing window (config window_days, UTC)
    python finops_push.py --dry-run        # BigQuery validates the MERGE and permissions; nothing is written
    python finops_push.py --days=60        # one-off backfill (max config max_backfill_days)

Source: the `openai.usage` log events (release 1) that the `cortex-openai-usage` log sink writes to BigQuery
`<USAGE_PROJECT>.cortex_usage`. Target: `<FINOPS_PROJECT>.finops_landing.cortex_drive`, as daily totals keyed by
(usage_date UTC, provider 'OpenAI', service = model). Aggregates only: no user ids, no content leave this project.

One MERGE, as gmail-digest's push: rows in the window are updated or inserted, rows in the window that no longer exist
are deleted, so a re-run never double counts and late events are picked up. Duplicate log deliveries are removed by
`insertId`. The query runs in FINOPS_PROJECT as `cortex-finops-push`, which may read only the usage dataset here and
write only its landing table there.

No new dependencies: the BigQuery REST API through httpx. Token: the Cloud Run metadata server; locally google-auth
(your gcloud application-default login). Exit code 0 on success, 1 on failure (so the job execution shows it).
"""
import argparse
import json
import os
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx

_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config", "finops_push.json")
with open(_CONFIG_PATH, encoding="utf-8") as _f:
    CONFIG = json.load(_f)

BIGQUERY_QUERY_URL = "https://bigquery.googleapis.com/bigquery/v2/projects/{project}/queries"
METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
BIGQUERY_SCOPE = "https://www.googleapis.com/auth/bigquery"
HTTP_TIMEOUT_S = 90
LOG_TAG = "[FINOPS_PUSH]"

MERGE_SQL = """
MERGE `{landing}` t
USING (
  SELECT DATE(timestamp) AS usage_date,
         @provider AS provider,
         IFNULL(jsonPayload.model, '(not recorded)') AS service,
         CAST(ROUND(SUM(CAST(jsonPayload.cost_usd AS FLOAT64)), 9) AS NUMERIC) AS cost_usd
  FROM `{usage}`
  WHERE jsonPayload.event = @event
    AND timestamp >= TIMESTAMP(@since)
  GROUP BY usage_date, service
) s
ON t.usage_date = s.usage_date AND t.provider = s.provider AND t.service = s.service
WHEN MATCHED THEN UPDATE SET cost_usd = s.cost_usd, recorded_at = CURRENT_TIMESTAMP(), source_run_id = @run_id
WHEN NOT MATCHED BY TARGET THEN
  INSERT (usage_date, provider, service, cost_usd, recorded_at, source_run_id)
  VALUES (s.usage_date, s.provider, s.service, s.cost_usd, CURRENT_TIMESTAMP(), @run_id)
WHEN NOT MATCHED BY SOURCE AND t.usage_date >= @since AND t.provider = @provider THEN DELETE
"""
# Duplicate deliveries of one log entry share an insertId; the source keeps one row per insertId.
DEDUPED_USAGE = ("(SELECT * FROM `{table}` WHERE timestamp >= TIMESTAMP_SUB(TIMESTAMP(@since), INTERVAL 1 DAY) "
                 "QUALIFY ROW_NUMBER() OVER (PARTITION BY insertId ORDER BY receiveTimestamp) = 1)")


def required_env(name: str, env=None) -> str:
    value = (os.environ if env is None else env).get(name)
    if not value:
        raise RuntimeError(f"{name} is not set (no default, by design)")
    return value


def window_start(now: datetime, days: int) -> str:
    """UTC date `days - 1` days before today: the window includes today."""
    return (now.astimezone(timezone.utc).date() - timedelta(days=days - 1)).isoformat()


def build_query(usage_project: str, finops_project: str, since: str, run_id: str, dry_run: bool = False) -> dict:
    """BigQuery jobs.query body: one parameterised MERGE (pure, unit-tested)."""
    usage_table = f"{usage_project}.{CONFIG['usage_dataset']}.{CONFIG['usage_table']}"
    sql = MERGE_SQL.format(landing=f"{finops_project}.{CONFIG['landing_table']}",
                           usage="__USAGE__").replace("`__USAGE__`", DEDUPED_USAGE.format(table=usage_table))
    params = {"provider": CONFIG["provider"], "event": CONFIG["usage_event"], "run_id": run_id}
    return {
        "query": sql,
        "useLegacySql": False,
        "dryRun": dry_run,
        "maximumBytesBilled": str(CONFIG["max_bytes_billed"]),
        "timeoutMs": CONFIG["query_timeout_ms"],
        "queryParameters": [
            {"name": "since", "parameterType": {"type": "DATE"}, "parameterValue": {"value": since}},
            *[{"name": k, "parameterType": {"type": "STRING"}, "parameterValue": {"value": v}} for k, v in params.items()],
        ],
    }


def access_token() -> str:
    """Cloud Run: the metadata server (the job's service account). Locally: google-auth application default."""
    if os.environ.get("CLOUD_RUN_JOB"):
        r = httpx.get(METADATA_TOKEN_URL, headers={"Metadata-Flavor": "Google"}, timeout=10)
        r.raise_for_status()
        return r.json()["access_token"]
    import google.auth
    import google.auth.transport.requests
    credentials, _ = google.auth.default(scopes=[BIGQUERY_SCOPE])
    credentials.refresh(google.auth.transport.requests.Request())
    return credentials.token


def run_query(project: str, body: dict, token: str) -> dict:
    r = httpx.post(BIGQUERY_QUERY_URL.format(project=project), json=body,
                   headers={"Authorization": f"Bearer {token}"}, timeout=HTTP_TIMEOUT_S)
    if r.status_code != 200:
        message = (r.json().get("error") or {}).get("message", r.text[:300]) if r.content else r.reason_phrase
        raise RuntimeError(f"BigQuery HTTP {r.status_code}: {message}")
    result = r.json()
    if not body["dryRun"] and not result.get("jobComplete"):
        raise RuntimeError(f"query did not finish in time (job {result.get('jobReference', {}).get('jobId')})")
    return result


def push(days: int, dry_run: bool = False, now: Optional[datetime] = None, env=None) -> dict:
    if not 1 <= days <= CONFIG["max_backfill_days"]:
        raise ValueError(f"days must be 1..{CONFIG['max_backfill_days']}, got {days}")
    usage_project = required_env("USAGE_PROJECT", env)
    finops_project = required_env("FINOPS_PROJECT", env)
    since = window_start(now or datetime.now(timezone.utc), days)
    run_id = f"{CONFIG['run_id_prefix']}-{os.environ.get('CLOUD_RUN_EXECUTION') or uuid.uuid4().hex[:12]}"
    body = build_query(usage_project, finops_project, since, run_id, dry_run)
    result = run_query(finops_project, body, access_token())
    return {"since": since, "days": days, "run_id": run_id, "dry_run": dry_run,
            "changed_rows": result.get("numDmlAffectedRows"), "bytes": result.get("totalBytesProcessed")}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Push cortex-drive OpenAI spend to finops-admin")
    parser.add_argument("--dry-run", action="store_true", help="validate the MERGE and permissions; write nothing")
    parser.add_argument("--days", type=int, default=CONFIG["window_days"], help="trailing UTC days to re-send")
    args = parser.parse_args(argv)
    started = time.monotonic()
    try:
        out = push(args.days, args.dry_run)
        print(json.dumps({"severity": "INFO", "message": f"{LOG_TAG} {'dry run ok' if args.dry_run else 'pushed'}",
                          "tag": "FINOPS_PUSH", **out, "seconds": round(time.monotonic() - started, 1)}), flush=True)
        return 0
    except Exception as exc:
        print(json.dumps({"severity": "ERROR", "message": f"{LOG_TAG} failed", "tag": "FINOPS_PUSH",
                          "error": f"{type(exc).__name__}: {str(exc)[:300]}"}), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
