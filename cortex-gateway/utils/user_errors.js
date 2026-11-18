'use strict';
/**
 * Safe, classified error responses (S2-90; design documents/architecture/safe-errors-and-alerts-design-2026-11-18.md §2).
 *
 * Every failed request answers with a fixed message for its class (config/user_errors.json), never err.message:
 * provider billing text, internal paths and driver errors stay in the logs. One structured `user_error` event per
 * failure (config/log_events.json) carries the class, the route and the cause's type, so log-based alerts
 * (scripts/alerts.json) can count classes without parsing free text.
 *
 * GraphUnavailableError is how a Neo4j outage travels: MCP marks it in-band ({"error_code": "graph_unavailable"}),
 * callMcpTool throws this, and the /query paths let it through instead of turning it into "No data found" (AP-25 keeps
 * "No data found" for real empty results).
 */
const CONFIG = require('../config/user_errors.json');
const { logEvent, LOG_EVENTS } = require('./log_event');

const GRAPH_UNAVAILABLE = 'graph_unavailable';

class GraphUnavailableError extends Error {
    constructor(message = 'knowledge graph unavailable') {
        super(message);
        this.name = 'GraphUnavailableError';
        this.code = GRAPH_UNAVAILABLE;
    }
}

/** Errors that must end the request instead of counting as "this tool found nothing". */
function isFatalToolError(err) {
    return Boolean(err) && err.code === GRAPH_UNAVAILABLE;
}

/** True when an MCP tool result (parsed JSON) reports a graph outage. */
function isGraphUnavailableResult(parsed) {
    return parsed !== null && typeof parsed === 'object' && parsed.error_code === GRAPH_UNAVAILABLE;
}

const lower = v => String(v == null ? '' : v).toLowerCase();

function codesOf(err) {
    const inner = (err && typeof err.error === 'object' && err.error) || {};
    return [err && err.code, err && err.type, inner.code, inner.type].filter(Boolean).map(lower);
}

function ruleMatches(rule, err) {
    if (rule.names && !rule.names.includes(err && err.constructor && err.constructor.name)
                   && !rule.names.includes(err && err.name)) return false;
    if (rule.codes) {
        const codes = codesOf(err);
        if (!rule.codes.some(c => codes.includes(lower(c)))) return false;
    }
    if (rule.statuses && !rule.statuses.includes(err && err.status)) return false;
    if (rule.message_includes && !rule.message_includes.some(s => lower(err && err.message).includes(lower(s)))) return false;
    return true;
}

/** { code, status, message } for an error: the first matching rule, or the default class. */
function classifyError(err, cfg = CONFIG) {
    const rule = cfg.rules.find(r => ruleMatches(r, err));
    const code = rule ? rule.class : cfg.default_class;
    const cls = cfg.classes[code];
    return { code, status: cls.status, message: cls.message };
}

/**
 * Answer a failed request with its class's fixed message and log one user_error event.
 * Works after a stream has started (text/event-stream): sends an error event and ends the stream.
 */
function sendSafeError(req, res, err, { route, log = console } = {}) {
    const c = classifyError(err);
    const where = route || (req && ((req.route && req.route.path) || req.path)) || 'unknown';
    logEvent(LOG_EVENTS.USER_ERROR, {
        code: c.code, route: where, status: c.status,
        cause: (err && (err.constructor && err.constructor.name !== 'Object' ? err.constructor.name : err.name)) || 'unknown',
        cause_code: codesOf(err)[0],
        user_type: req && req.headers && req.headers['x-user-type'],
    });
    log.error(`[USER_ERROR] ${where} → ${c.code}: ${err && err.message}`);   // full cause for debugging, logs only
    if (res.headersSent) {
        if (String(res.getHeader && res.getHeader('Content-Type')).includes('text/event-stream') && !res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: 'error', error: c.message, code: c.code })}\n\n`);
        }
        if (!res.writableEnded) res.end();
        return;
    }
    res.status(c.status).json({ error: c.message, code: c.code });
}

module.exports = { classifyError, sendSafeError, GraphUnavailableError, isFatalToolError, isGraphUnavailableResult,
                   GRAPH_UNAVAILABLE };
