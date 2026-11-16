'use strict';
/**
 * Structured log events (bridge design 2026-11-13 §13.3 Observability; tracker S2-80 moves the other [TAG] lines here).
 *
 * One JSON line per event. Cloud Run turns a JSON line into `jsonPayload`, so events are filtered by field and counted
 * with log-based metrics, e.g.  jsonPayload.tag="BRIDGE_PLAN" AND jsonPayload.kind_step="e".
 * `message` keeps the familiar "[TAG] event" prefix, so `grep '\[BRIDGE_PLAN\]'` still works locally.
 *
 * Events, tags, severities and each event's allowed fields are data (config/log_events.json). Fields outside the
 * allow-list are dropped and strings are clipped, so question text and names never reach the log by construction.
 * An unknown event throws under tests (LOG_EVENT_STRICT=1) and is logged as tag "UNKNOWN" otherwise (never dropped).
 */
const CONFIG = require('../config/log_events.json');

const UNKNOWN_TAG = 'UNKNOWN';
const constName = event => event.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
/** LOG_EVENTS.BRIDGE_PLAN_DECIDED === 'bridge_plan.decided' — code uses these, never string literals. */
const LOG_EVENTS = Object.freeze(Object.fromEntries(Object.keys(CONFIG.events).map(e => [constName(e), e])));

function clip(value) {
    if (typeof value === 'string') return value.slice(0, CONFIG.max_string_chars);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (Array.isArray(value)) return value.slice(0, CONFIG.max_array_items).map(clip).filter(v => v !== undefined);
    return undefined;   // objects are not logged (they could carry anything)
}

/** The JSON object written for an event (exported for tests). */
function buildLogEntry(event, fields = {}) {
    const spec = CONFIG.events[event];
    if (!spec) {
        if (process.env.LOG_EVENT_STRICT === '1') throw new Error(`unknown log event "${event}"`);
        return { severity: 'WARNING', message: `[${UNKNOWN_TAG}] ${String(event).slice(0, CONFIG.max_string_chars)}`,
                 tag: UNKNOWN_TAG, event: String(event).slice(0, CONFIG.max_string_chars) };
    }
    const entry = { severity: spec.severity, message: `[${spec.tag}] ${event}`, tag: spec.tag, event };
    for (const key of spec.fields) {
        if (fields[key] === undefined) continue;
        const v = clip(fields[key]);
        if (v !== undefined) entry[key] = v;
    }
    return entry;
}

function logEvent(event, fields, sink = console.log) {
    sink(JSON.stringify(buildLogEntry(event, fields)));
}

module.exports = { logEvent, buildLogEntry, LOG_EVENTS, UNKNOWN_TAG };
