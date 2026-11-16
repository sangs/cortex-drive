'use strict';
/**
 * Structured log events (bridge design 2026-11-13 §13.3 Observability; utils/log_event.js, config/log_events.json).
 * - one JSON line per event, with tag, event, severity and the "[TAG] event" message;
 * - only the event's allowed fields; strings clipped; objects never logged — a question passed by mistake never appears;
 * - unknown event: throws in strict mode, logged as UNKNOWN otherwise;
 * - the [BRIDGE_PLAN] call sites use LOG_EVENTS constants, not text lines.
 * No network. Run: node tests/verify_log_event.js (npm test).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const CONFIG = require('../config/log_events.json');
const { logEvent, buildLogEntry, LOG_EVENTS, UNKNOWN_TAG } = require('../utils/log_event');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };

eq(LOG_EVENTS.BRIDGE_PLAN_DECIDED, 'bridge_plan.decided');
eq(Object.keys(LOG_EVENTS).length, Object.keys(CONFIG.events).length, 'one constant per configured event');

const lines = [];
const QUESTION = "How did Sangeetha's thought leadership influence Cortex-Drive at JPMorgan Chase in 2024?";
logEvent(LOG_EVENTS.BRIDGE_PLAN_DECIDED, { rule: 'kind', kind_step: 'b', source_count: 2, question: QUESTION,
    target: QUESTION, kind_domains: ['career', 'website'], extra: { q: QUESTION } }, l => lines.push(l));
eq(lines.length, 1, 'one line');
const e = JSON.parse(lines[0]);
eq([e.severity, e.tag, e.event, e.message], ['INFO', 'BRIDGE_PLAN', 'bridge_plan.decided', '[BRIDGE_PLAN] bridge_plan.decided']);
eq([e.rule, e.kind_step, e.source_count, e.kind_domains], ['kind', 'b', 2, ['career', 'website']]);
ok(!('question' in e) && !('extra' in e), 'fields outside the allow-list are dropped');
ok(e.target.length <= CONFIG.max_string_chars, 'strings clipped');
ok(!lines[0].includes(QUESTION), 'the question never appears in full');

process.env.LOG_EVENT_STRICT = '1';
assert.throws(() => buildLogEntry('bridge_plan.typo', {}), /unknown log event/); passed++;
delete process.env.LOG_EVENT_STRICT;
eq(buildLogEntry('bridge_plan.typo', {}).tag, UNKNOWN_TAG, 'never dropped in production');

const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
ok(!/console\.(log|warn)\([`'"]\[BRIDGE_PLAN\]/.test(index), 'no free-text [BRIDGE_PLAN] lines left');
for (const k of ['BRIDGE_PLAN_DECIDED', 'BRIDGE_PLAN_CLARIFY', 'BRIDGE_PLAN_MODEL_FALLBACK']) {
    ok(index.includes(`LOG_EVENTS.${k}`), `${k} used by constant`);
}

console.log(`verify_log_event: ${passed} checks passed`);
