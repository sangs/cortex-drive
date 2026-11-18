'use strict';
/**
 * Safe, classified error responses (S2-90; design documents/architecture/safe-errors-and-alerts-design-2026-11-18.md §2).
 * Classification per class (OpenAI SDK error shapes, a graph outage, timeouts), fixed messages only, stream-safe
 * sending, the structured user_error event, and a source guard: no route may send err.message to a client again.
 *
 *     node cortex-gateway/tests/verify_user_errors.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { classifyError, sendSafeError, GraphUnavailableError, isFatalToolError, isGraphUnavailableResult } = require('../utils/user_errors');
const CONFIG = require('../config/user_errors.json');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const quiet = { error: () => {} };

// Shapes of the OpenAI SDK errors (class name + status + code/type), as seen on 2026-11-18.
function sdkError(name, props) {
    const C = { [name]: class extends Error {} }[name];
    return Object.assign(new C(props.message || name), props);
}
const QUOTA = sdkError('RateLimitError', { status: 429, message: '429 You have no credits remaining. Add credits … billing',
                                           code: 'insufficient_quota', type: 'insufficient_quota',
                                           error: { type: 'insufficient_quota', code: 'insufficient_quota' } });

function fakeRes({ stream = false, sent = false } = {}) {
    const r = { headersSent: sent, writableEnded: false, writes: [], statusCode: null, body: null,
                headers: { 'Content-Type': stream ? 'text/event-stream' : 'application/json' } };
    r.getHeader = h => r.headers[h];
    r.status = c => { r.statusCode = c; return r; };
    r.json = b => { r.body = b; r.headersSent = true; return r; };
    r.write = d => { r.writes.push(d); };
    r.end = () => { r.writableEnded = true; };
    return r;
}
const req = { path: '/query', headers: { 'x-user-type': 'owner' } };

test('OpenAI credit gone → ai_unavailable, 503, fixed text (never the billing message)', () => {
    const c = classifyError(QUOTA);
    assert.strictEqual(c.code, 'ai_unavailable');
    assert.strictEqual(c.status, 503);
    assert.ok(!/credit|billing|429/i.test(c.message), 'no provider text');
});
test('OpenAI key revoked → ai_unavailable', () => {
    assert.strictEqual(classifyError(sdkError('AuthenticationError', { status: 401 })).code, 'ai_unavailable');
    assert.strictEqual(classifyError(sdkError('PermissionDeniedError', { status: 403 })).code, 'ai_unavailable');
});
test('OpenAI rate limit or outage → ai_busy', () => {
    assert.strictEqual(classifyError(sdkError('RateLimitError', { status: 429, code: 'rate_limit_exceeded' })).code, 'ai_busy');
    assert.strictEqual(classifyError(sdkError('InternalServerError', { status: 500 })).code, 'ai_busy');
    assert.strictEqual(classifyError(sdkError('APIConnectionError', {})).code, 'ai_busy');
});
test('graph outage → graph_unavailable; MCP marker recognised; fatal for tool loops', () => {
    const g = new GraphUnavailableError();
    assert.strictEqual(classifyError(g).code, 'graph_unavailable');
    assert.ok(isFatalToolError(g));
    assert.ok(!isFatalToolError(new Error('Tool search failed')));
    assert.ok(isGraphUnavailableResult({ error: 'x', error_code: 'graph_unavailable' }));
    assert.ok(!isGraphUnavailableResult({ error: 'x' }));
    assert.ok(!isGraphUnavailableResult(null));
});
test('timeouts → timeout (504)', () => {
    assert.strictEqual(classifyError(new Error('Orchestration timeout calling search_enterprise_graph after 90s')).code, 'timeout');
    assert.strictEqual(classifyError(sdkError('AbortError', {})).code, 'timeout');
    assert.strictEqual(classifyError(sdkError('AbortError', {})).status, 504);
});
test('anything else → internal (500), with no detail', () => {
    const c = classifyError(new Error('relation "share_grants" does not exist at /app/utils/db.js'));
    assert.deepStrictEqual([c.code, c.status], ['internal', 500]);
    assert.ok(!c.message.includes('share_grants'));
    assert.strictEqual(classifyError(undefined).code, 'internal');
});
test('every class has a status and a message; every rule names a known class', () => {
    for (const [k, v] of Object.entries(CONFIG.classes)) assert.ok(v.status >= 500 && v.message, k);
    for (const r of CONFIG.rules) assert.ok(CONFIG.classes[r.class], r.class);
    assert.ok(CONFIG.classes[CONFIG.default_class]);
});
test('sendSafeError: JSON {error, code} with the class status', () => {
    const res = fakeRes();
    sendSafeError(req, res, QUOTA, { log: quiet });
    assert.strictEqual(res.statusCode, 503);
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['code', 'error']);
    assert.strictEqual(res.body.code, 'ai_unavailable');
    assert.ok(!/credit|billing/i.test(JSON.stringify(res.body)));
});
test('sendSafeError after a stream started: one safe error event, then end', () => {
    const res = fakeRes({ stream: true, sent: true });
    sendSafeError(req, res, new GraphUnavailableError(), { log: quiet });
    assert.strictEqual(res.writes.length, 1);
    const ev = JSON.parse(res.writes[0].replace(/^data: /, ''));
    assert.deepStrictEqual([ev.type, ev.code], ['error', 'graph_unavailable']);
    assert.ok(res.writableEnded);
});
test('user_error event: class, route, cause type; never the message', () => {
    const lines = [];
    const orig = console.log;
    console.log = l => lines.push(l);
    try { sendSafeError(req, fakeRes(), QUOTA, { log: quiet }); } finally { console.log = orig; }
    const ev = JSON.parse(lines.find(l => l.includes('USER_ERROR')));
    assert.strictEqual(ev.event, 'user_error');
    assert.strictEqual(ev.code, 'ai_unavailable');
    assert.strictEqual(ev.route, '/query');
    assert.strictEqual(ev.cause, 'RateLimitError');
    assert.strictEqual(ev.cause_code, 'insufficient_quota');
    assert.ok(!JSON.stringify(ev).includes('credits'));
});
test('source guard: no route sends err.message / e.message to a client (S2-90)', () => {
    const files = ['index.js', ...fs.readdirSync(path.join(__dirname, '..', 'utils')).map(f => path.join('utils', f))]
        .filter(f => f.endsWith('.js'));
    const bad = [];
    for (const f of files) {
        const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        src.split('\n').forEach((l, i) => {
            if (/\b(res\.(json|send|write)|send)\(\{[^}]*error:\s*(err|e|error)\.message/.test(l)) bad.push(`${f}:${i + 1}`);
            if (/result = \{ error: (err|e)\.message \}/.test(l)) bad.push(`${f}:${i + 1}`);
        });
    }
    assert.deepStrictEqual(bad, []);
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.ok(index.includes('async function callMcpToolRaw('), 'callMcpTool wraps the raw call');
    assert.ok(/if \(isFatalToolError\(err\)\) throw err;/.test(index), 'the /query tool loop lets a graph outage through');
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); passed++; } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); }
    }
    console.log(`verify_user_errors: ${passed}/${tests.length} passed`);
    if (passed !== tests.length) process.exit(1);
})();
