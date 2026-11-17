"""
OpenAI usage recording for MCP, Bento and the ingest worker (FinOps design 2026-11-16 §3, tracker S2-83, release 1).

Python twin of cortex-gateway/utils/openai_usage.js. Every OpenAI call (embeddings, BAML extraction) prints one
`openai.usage` JSON line; Cloud Run turns it into `jsonPayload`, and a log sink → BigQuery aggregates it (release 2).
Fields are allow-listed by config/openai_usage.json, which is GENERATED from the gateway's price table and log events
(`node cortex-gateway/scripts/sync_openai_usage_config.js`), so both languages share one source.

Never logs prompts, content or ids. Never raises and never changes a call's result. A model with no price is
recorded with cost 0 and price_missing=true plus an `openai.price_missing` WARNING, never a guessed price.
"""
import json
import os
import sys
from typing import Any, Callable, Optional

_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config", "openai_usage.json")
with open(_CONFIG_PATH, encoding="utf-8") as _f:
    CONFIG = json.load(_f)
PRICES = CONFIG["prices"]

EVENT_USAGE = "openai.usage"
EVENT_PRICE_MISSING = "openai.price_missing"
TOKENS_PER_PRICE_UNIT = 1_000_000
COST_DECIMALS = 8
SERVICE_ENV_VARS = ("K_SERVICE", "CLOUD_RUN_JOB")   # Cloud Run service / job; 'local' on a laptop
LOCAL_SERVICE = "local"

# Feature names recorded with each call (one per call site).
FEATURE_SEARCH_EMBED = "search_embed"        # question embedding for graph search (MCP / Bento)
FEATURE_INGEST_EMBED = "ingest_embed"        # document / block embeddings during ingestion
FEATURE_EXTRACT = "baml_extract"             # BAML structured extraction (podcast, web page, document)

_MODEL_KEYS = sorted(PRICES["models"], key=len, reverse=True)   # longest prefix first


def service_name(env=None) -> str:
    env = os.environ if env is None else env
    for name in SERVICE_ENV_VARS:
        if env.get(name):
            return env[name]
    return LOCAL_SERVICE


def price_for(model: Optional[str]) -> Optional[dict]:
    """Price entry for a model name, by longest matching prefix at a '-' boundary; None when unknown."""
    if not isinstance(model, str):
        return None
    for key in _MODEL_KEYS:
        if model == key or model.startswith(key + "-"):
            return PRICES["models"][key]
    return None


def _get(obj: Any, key: str):
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


def tokens_of(usage: Any) -> dict:
    """Token counts from an OpenAI `usage` (dict or SDK object) or a BAML Usage."""
    prompt = _get(usage, "prompt_tokens")
    if prompt is None:
        prompt = _get(usage, "input_tokens")
    cached = _get(_get(usage, "prompt_tokens_details"), "cached_tokens")
    if cached is None:
        cached = _get(usage, "cached_input_tokens")
    completion = _get(usage, "completion_tokens")
    if completion is None:
        completion = _get(usage, "output_tokens")
    prompt, cached, completion = int(prompt or 0), int(cached or 0), int(completion or 0)
    return {"prompt_tokens": prompt, "cached_tokens": min(cached, prompt), "completion_tokens": completion}


def cost_of(model: Optional[str], tokens: dict) -> dict:
    price = price_for(model)
    if not price:
        return {"cost_usd": 0, "price_missing": True}
    cached_price = price["cached_input_per_1m"] if price.get("cached_input_per_1m") is not None else price["input_per_1m"]
    cost = ((tokens["prompt_tokens"] - tokens["cached_tokens"]) * price["input_per_1m"]
            + tokens["cached_tokens"] * cached_price
            + tokens["completion_tokens"] * price["output_per_1m"]) / TOKENS_PER_PRICE_UNIT
    return {"cost_usd": round(cost, COST_DECIMALS), "price_missing": False}


def usage_fields(feature: str, model: Optional[str], usage: Any, user_type: Optional[str] = None,
                 service: Optional[str] = None) -> dict:
    tokens = tokens_of(usage)
    return {"service": service or service_name(), "feature": feature, "model": model, **tokens,
            **cost_of(model, tokens), "prices_effective": PRICES["effective_date"], "user_type": user_type}


def _clip(value):
    if isinstance(value, str):
        return value[:CONFIG["max_string_chars"]]
    if isinstance(value, (bool, int, float)) or value is None:
        return value
    return None


def build_entry(event: str, fields: dict) -> dict:
    """The JSON object for an event: only its allow-listed fields (same shape as the gateway's log_event.js)."""
    spec = CONFIG["events"][event]
    entry = {"severity": spec["severity"], "message": f"[{spec['tag']}] {event}", "tag": spec["tag"], "event": event}
    for key in spec["fields"]:
        if fields.get(key) is not None:
            entry[key] = _clip(fields[key])
    return entry


def _emit(entry: dict, sink: Optional[Callable[[str], None]]) -> None:
    line = json.dumps(entry)
    if sink:
        sink(line)
    else:
        print(line, file=sys.stdout, flush=True)


def record_usage(feature: str, model: Optional[str], usage: Any, user_type: Optional[str] = None,
                 sink: Optional[Callable[[str], None]] = None) -> None:
    """Record one call. Never raises."""
    try:
        fields = usage_fields(feature, model, usage, user_type)
        _emit(build_entry(EVENT_USAGE, fields), sink)
        if fields["price_missing"]:
            _emit(build_entry(EVENT_PRICE_MISSING, fields), sink)
    except Exception as exc:  # recording must never break a call
        print(f"[OPENAI_USAGE] not recorded ({type(exc).__name__})", file=sys.stderr, flush=True)


def record_response(feature: str, response: Any, model: Optional[str] = None, user_type: Optional[str] = None,
                    sink: Optional[Callable[[str], None]] = None):
    """Record an OpenAI SDK response (chat or embeddings) and return it unchanged."""
    try:
        record_usage(feature, _get(response, "model") or model, _get(response, "usage"), user_type, sink)
    except Exception:
        pass
    return response


def _baml_call_model(call: Any) -> Optional[str]:
    """The model a BAML LLM call sent (from its request body); the client name when unreadable (→ price_missing)."""
    try:
        return call.http_request.body.json().get("model") or call.client_name
    except Exception:
        return _get(call, "client_name")


def record_baml(feature: str, collector: Any, user_type: Optional[str] = None,
                sink: Optional[Callable[[str], None]] = None) -> None:
    """Record every LLM call (retries included: each is billed) of the last function a BAML Collector saw."""
    try:
        last = collector.last if collector is not None else None
        for call in (last.calls if last is not None else []) or []:
            if call.usage is not None:
                record_usage(feature, _baml_call_model(call), call.usage, user_type, sink)
    except Exception as exc:
        print(f"[OPENAI_USAGE] BAML usage not recorded ({type(exc).__name__})", file=sys.stderr, flush=True)


class OpenAIPaused(RuntimeError):
    """The owner paused usage-based spend (FinOps release 5). The message is safe to show to users."""


_pause_cache = {"at": float("-inf"), "paused": False}


def _read_pause_flag() -> bool:
    import redis  # in every image (Redis caches, worker status)
    client = redis.Redis.from_url(os.environ.get("REDIS_URL", "redis://localhost:6379"), socket_timeout=1,
                                  socket_connect_timeout=1, decode_responses=True)
    raw = client.get(CONFIG["pause"]["redis_key"])
    return bool(raw) and json.loads(raw).get("paused") is True


def ensure_openai_allowed(read_flag: Callable[[], bool] = None, clock: Callable[[], float] = None) -> None:
    """Raise OpenAIPaused while the owner has paused OpenAI spend. Call BEFORE every OpenAI call.
    Cached for the configured seconds; if Redis cannot be read, the last known state applies, else not paused
    (fail open, logged): the pause is a cost control, not a security boundary."""
    import time
    clock = clock or time.monotonic
    now = clock()
    if now - _pause_cache["at"] >= CONFIG["pause"]["cache_seconds"]:
        try:
            _pause_cache["paused"] = (read_flag or _read_pause_flag)()
        except Exception as exc:
            print(f"[OPENAI_USAGE] pause flag unreadable ({type(exc).__name__}); continuing "
                  f"{'paused' if _pause_cache['paused'] else 'not paused'}", file=sys.stderr, flush=True)
        _pause_cache["at"] = now
    if _pause_cache["paused"]:
        raise OpenAIPaused(CONFIG["pause"]["paused_message"])


def baml_call(feature: str, fn: Callable, **kwargs):
    """`baml_call(FEATURE_EXTRACT, b.ExtractWebPage, content=..., url=...)`: the call is unchanged, its usage recorded.
    Usage is recorded even when the call fails, because failed attempts are billed too. Refused while paused."""
    ensure_openai_allowed()
    try:
        from baml_py import Collector
        collector = Collector(name=feature)
    except Exception:
        return fn(**kwargs)
    try:
        return fn(**kwargs, baml_options={"collector": collector})
    finally:
        record_baml(feature, collector)
