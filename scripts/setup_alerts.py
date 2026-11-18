"""Apply, inspect, switch and remove cortex-drive's runtime alerts (RV-17).

Design: documents/architecture/safe-errors-and-alerts-design-2026-11-18.md §3 / §3.1. What to create is data
(scripts/alerts.json); this file only applies it. Run through scripts/setup-alerts.sh.

  setup (default)       create or update: email channel, log metrics, uptime check, policies
  --status              read only: each policy, enabled or not, active snoozes, channel, uptime check
  --disable / --enable  turn every "cortex: " policy off / on
  --snooze <2h|30m|1d>  pause every "cortex: " policy's notifications for that long (ends by itself)
  --remove              delete exactly what setup created (matched by name); never logs, services or data

Everything except --status is a DRY RUN unless --apply is given. Setup with --apply needs ALERT_EMAIL (the owner's
address; stored only in the Google Cloud notification channel, never in the repository). Talks to the Cloud
Monitoring / Cloud Logging REST APIs with the operator's gcloud credentials (no alpha gcloud components needed).
"""
import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "alerts.json")
MON = "https://monitoring.googleapis.com/v3"
LOG = "https://logging.googleapis.com/v2"
DURATION = re.compile(r"^(\d+)([mhd])$")


def load_config(project: str) -> dict:
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project):   # project ids have no regex metacharacters
        raise SystemExit(f"unexpected project id {project!r}")
    return json.loads(open(CONFIG_PATH).read().replace("{{PROJECT}}", project))


class Api:
    def __init__(self, project: str, apply: bool, token: str = None):
        self.project, self.apply = project, apply
        self.token = token or subprocess.run(["gcloud", "auth", "print-access-token"], capture_output=True,
                                             text=True, check=True).stdout.strip()

    def call(self, method: str, url: str, body=None, write: bool = False):
        """GETs always run. Writes run only with --apply; otherwise they are printed."""
        if write and not self.apply:
            print(f"  would {method} {url.split('/v3/')[-1].split('/v2/')[-1]}")
            return None
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                text = r.read().decode()
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as e:
            if e.code == 404 and method == "GET":
                return None
            raise SystemExit(f"{method} {url} → HTTP {e.code}: {e.read().decode()[:300]}")

    def list(self, url: str, key: str):
        items, token = [], None
        while True:
            page = self.call("GET", url + (("&" if "?" in url else "?") + f"pageToken={token}" if token else "")) or {}
            items += page.get(key, [])
            token = page.get("nextPageToken")
            if not token:
                return items


def proj(api):  # resource prefix
    return f"projects/{api.project}"


def find_channel(api, cfg, email=None):
    chans = api.list(f"{MON}/{proj(api)}/notificationChannels", "notificationChannels")
    for c in chans:
        if c.get("type") == "email" and c.get("displayName") == cfg["channel_display_name"] \
                and (email is None or c.get("labels", {}).get("email_address") == email):
            return c
    return None


def find_uptime(api, cfg):
    for u in api.list(f"{MON}/{proj(api)}/uptimeCheckConfigs", "uptimeCheckConfigs"):
        if u.get("displayName") == cfg["uptime_check"]["display_name"]:
            return u
    return None


def our_policies(api, cfg):
    return [p for p in api.list(f"{MON}/{proj(api)}/alertPolicies", "alertPolicies")
            if p.get("displayName", "").startswith(cfg["policy_prefix"])]


def metric_body(api, m):
    body = {"name": m["name"], "description": m["description"], "filter": m["filter"]}
    if m["labels"]:
        body["labelExtractors"] = m["labels"]
        body["metricDescriptor"] = {"metricKind": "DELTA", "valueType": "INT64",
                                    "labels": [{"key": k, "valueType": "STRING"} for k in m["labels"]]}
    return body


def uptime_body(api, u):
    return {"displayName": u["display_name"], "period": u["period"], "timeout": u["timeout"],
            "monitoredResource": {"type": "uptime_url", "labels": {"project_id": api.project, "host": u["host"]}},
            "httpCheck": {"path": u["path"], "port": 443, "useSsl": True, "validateSsl": True, "requestMethod": "GET"},
            "contentMatchers": [{"content": u["content"], "matcher": "CONTAINS_STRING"}],
            "selectedRegions": u["regions"]}


def policy_body(cfg, p, channel_name, uptime_id):
    cond = json.loads(json.dumps(p["condition"]).replace("{{UPTIME_CHECK_ID}}", uptime_id or "<new uptime check>"))
    return {"displayName": cfg["policy_prefix"] + p["name"], "combiner": "OR", "conditions": [cond],
            "notificationChannels": [channel_name] if channel_name else [],
            "alertStrategy": {"autoClose": cfg["auto_close"],
                              **({"notificationRateLimit": {"period": p["rate_limit"]}} if p.get("rate_limit") else {})},
            "documentation": {"content": f"{p['doc']}\n\nRunbook: {cfg['runbook']}. Switch off / snooze: "
                                         "scripts/setup-alerts.sh --status | --disable | --snooze.",
                              "mimeType": "text/markdown"},
            "enabled": True}


def setup(api, cfg, email):
    if api.apply and not email:
        raise SystemExit("ALERT_EMAIL is required with --apply (the owner's address for alert emails).")
    print(f"== setup in {api.project} ({'APPLY' if api.apply else 'DRY RUN'})")
    for svc in ("monitoring.googleapis.com", "logging.googleapis.com"):
        st = api.call("GET", f"https://serviceusage.googleapis.com/v1/{proj(api)}/services/{svc}") or {}
        print(f"  {svc}: {st.get('state', 'unknown')}")
    for m in cfg["log_metrics"]:
        exists = api.call("GET", f"{LOG}/{proj(api)}/metrics/{m['name']}")
        if exists:
            print(f"  = log metric {m['name']} exists → update")
            api.call("PUT", f"{LOG}/{proj(api)}/metrics/{m['name']}", metric_body(api, m), write=True)
        else:
            print(f"  + log metric {m['name']}")
            api.call("POST", f"{LOG}/{proj(api)}/metrics", metric_body(api, m), write=True)
    chan = find_channel(api, cfg, email) if email else find_channel(api, cfg)
    if chan:
        print(f"  = email channel exists ({chan['name'].split('/')[-1]})")
    else:
        print(f"  + email channel \"{cfg['channel_display_name']}\" → {'<ALERT_EMAIL>' if not email else 'the owner address given'}")
        chan = api.call("POST", f"{MON}/{proj(api)}/notificationChannels", write=True, body={
            "type": "email", "displayName": cfg["channel_display_name"], "labels": {"email_address": email}})
    up = find_uptime(api, cfg)
    if up:
        print(f"  = uptime check exists ({up['name'].split('/')[-1]})")
    else:
        print(f"  + uptime check {cfg['uptime_check']['display_name']}: https://{cfg['uptime_check']['host']}"
              f"{cfg['uptime_check']['path']} every {cfg['uptime_check']['period']}, must contain {cfg['uptime_check']['content']}")
        up = api.call("POST", f"{MON}/{proj(api)}/uptimeCheckConfigs", uptime_body(api, cfg["uptime_check"]), write=True)
    uptime_id = up["name"].split("/")[-1] if up else None
    existing = {p["displayName"]: p for p in our_policies(api, cfg)}
    for p in cfg["policies"]:
        body = policy_body(cfg, p, chan["name"] if chan else None, uptime_id)
        if body["displayName"] in existing:
            print(f"  = policy \"{body['displayName']}\" exists → update")
            name = existing[body["displayName"]]["name"]
            body.pop("enabled")   # an update never re-enables a policy the owner switched off
            api.call("PATCH", f"{MON}/{name}?updateMask=displayName,combiner,conditions,notificationChannels,"
                              "alertStrategy,documentation", body, write=True)
        else:
            print(f"  + policy \"{body['displayName']}\"")
            api.call("POST", f"{MON}/{proj(api)}/alertPolicies", body, write=True)
    print(f"== done ({'applied' if api.apply else 'dry run: nothing changed'})")


def status(api, cfg):
    print(f"== alerts in {api.project}")
    chan = find_channel(api, cfg)
    print(f"  email channel: {'enabled' if chan and chan.get('enabled', True) else 'disabled' if chan else 'none'}")
    up = find_uptime(api, cfg)
    print(f"  uptime check: {up['name'].split('/')[-1] if up else 'none'}")
    pols = our_policies(api, cfg)
    for p in pols:
        print(f"  {'on ' if p.get('enabled', True) else 'off'}  {p['displayName']}")
    if not pols:
        print("  no cortex policies (run setup)")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    names = {p["name"] for p in pols}
    for s in api.list(f"{MON}/{proj(api)}/snoozes", "snoozes"):   # filtered here: the API's filter syntax is narrow
        if s.get("interval", {}).get("endTime", "")[:19] > now and set(s.get("criteria", {}).get("policies", [])) & names:
            print(f"  snoozed until {s['interval']['endTime']} ({s.get('displayName')})")


def switch(api, cfg, enabled: bool):
    print(f"== {'enable' if enabled else 'disable'} ({'APPLY' if api.apply else 'DRY RUN'})")
    pols = our_policies(api, cfg)
    if not pols:
        print("  no cortex policies (run setup)")
    for p in pols:
        print(f"  {p['displayName']}: {'on' if p.get('enabled', True) else 'off'} → {'on' if enabled else 'off'}")
        api.call("PATCH", f"{MON}/{p['name']}?updateMask=enabled", {"enabled": enabled}, write=True)


def snooze(api, cfg, duration: str):
    m = DURATION.match(duration or "")
    if not m:
        raise SystemExit("--snooze takes a duration like 30m, 2h or 1d")
    delta = timedelta(**{{"m": "minutes", "h": "hours", "d": "days"}[m.group(2)]: int(m.group(1))})
    start = datetime.now(timezone.utc)
    end = start + delta
    pols = [p["name"] for p in our_policies(api, cfg)]
    if not pols:
        print("== nothing to snooze: no cortex policies (run setup)")
        return
    print(f"== snooze {len(pols)} policies until {end:%Y-%m-%d %H:%M} UTC ({'APPLY' if api.apply else 'DRY RUN'})")
    api.call("POST", f"{MON}/{proj(api)}/snoozes", write=True, body={
        "displayName": f"cortex alerts snoozed {duration}", "criteria": {"policies": pols},
        "interval": {"startTime": start.strftime("%Y-%m-%dT%H:%M:%SZ"), "endTime": end.strftime("%Y-%m-%dT%H:%M:%SZ")}})


def remove(api, cfg):
    print(f"== remove ({'APPLY' if api.apply else 'DRY RUN'}): only what setup created")
    pols = our_policies(api, cfg)
    for p in pols:
        print(f"  - policy {p['displayName']}")
        api.call("DELETE", f"{MON}/{p['name']}", write=True)
    up = find_uptime(api, cfg)
    if up:
        print(f"  - uptime check {up['displayName']}")
        api.call("DELETE", f"{MON}/{up['name']}", write=True)
    for m in cfg["log_metrics"]:
        if api.call("GET", f"{LOG}/{proj(api)}/metrics/{m['name']}"):
            print(f"  - log metric {m['name']} (logs are kept)")
            api.call("DELETE", f"{LOG}/{proj(api)}/metrics/{m['name']}", write=True)
    chan = find_channel(api, cfg)
    if chan:
        ours = {p["name"] for p in pols}
        others = [p for p in api.list(f"{MON}/{proj(api)}/alertPolicies", "alertPolicies")
                  if p["name"] not in ours and chan["name"] in p.get("notificationChannels", [])]
        if others:
            print(f"  = email channel kept: used by {len(others)} other policies")
        else:
            print("  - email channel")
            api.call("DELETE", f"{MON}/{chan['name']}?force=true", write=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--status", action="store_true")
    g.add_argument("--disable", action="store_true")
    g.add_argument("--enable", action="store_true")
    g.add_argument("--snooze", metavar="DURATION")
    g.add_argument("--remove", action="store_true")
    ap.add_argument("--apply", action="store_true", help="actually make the changes (default: dry run)")
    a = ap.parse_args(argv)
    project = os.environ.get("PROJECT_ID")
    if not project:
        raise SystemExit("PROJECT_ID is not set. Run: source scripts/cloud-env.sh")
    cfg = load_config(project)
    api = Api(project, apply=a.apply and not a.status)
    if a.status:
        status(api, cfg)
    elif a.disable or a.enable:
        switch(api, cfg, enabled=a.enable)
    elif a.snooze:
        snooze(api, cfg, a.snooze)
    elif a.remove:
        remove(api, cfg)
    else:
        setup(api, cfg, os.environ.get("ALERT_EMAIL"))


if __name__ == "__main__":
    sys.exit(main())
