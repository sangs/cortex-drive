'use strict';
/**
 * S2-92 sign-in / sign-out audit (utils/clerk_session_events.js; design
 * documents/architecture/sign-out-and-sign-in-design-2026-11-18.md §3.4).
 * - session.created → auth.session_started; session.ended / removed / revoked → auth.session_ended;
 * - only user ID, session ID, Clerk event and status are logged (no token, no other field);
 * - other webhook events are not handled here (membership and user.created keep their branches);
 * - the module writes nothing to Redis or Permify, and the webhook calls it after svix verification;
 * - authMiddleware still uses stateless verifyToken (no per-request revocation lookup; RV-24).
 * No network. Run: node tests/verify_clerk_session_events.js (npm test).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildLogEntry, LOG_EVENTS } = require('../utils/log_event');
const { handleClerkSessionEvent, isClerkSessionEvent, SESSION_EVENT_LOG } = require('../utils/clerk_session_events');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };

function capture(event) {
    const calls = [];
    const handled = handleClerkSessionEvent(event, (name, fields) => calls.push(buildLogEntry(name, fields)));
    return { handled, calls };
}

const sessionData = {
    id: 'sess_2abcDEF', user_id: 'user_2xyzABC', status: 'ended', client_id: 'client_1',
    last_active_token: { jwt: 'eyJhbGciOi.secret.token' }, actor: null,
};

for (const type of ['session.ended', 'session.removed', 'session.revoked']) {
    const { handled, calls } = capture({ type, data: sessionData });
    ok(handled, `${type} is handled`);
    eq(calls.length, 1, `${type}: one log line`);
    eq(calls[0].event, LOG_EVENTS.AUTH_SESSION_ENDED, `${type} → auth.session_ended`);
    eq(calls[0].tag, 'AUTH', `${type}: [AUTH] tag`);
    eq(calls[0].user_id, 'user_2xyzABC', `${type}: user ID logged`);
    eq(calls[0].session_id, 'sess_2abcDEF', `${type}: session ID logged`);
    eq(calls[0].clerk_event, type, `${type}: Clerk event logged`);
    const line = JSON.stringify(calls[0]);
    ok(!line.includes('eyJ') && !line.includes('secret') && !line.includes('client_1'), `${type}: no token or other fields`);
}

{
    const { handled, calls } = capture({ type: 'session.created', data: { ...sessionData, status: 'active' } });
    ok(handled, 'session.created is handled');
    eq(calls[0].event, LOG_EVENTS.AUTH_SESSION_STARTED, 'session.created → auth.session_started');
    eq(calls[0].status, 'active', 'status logged');
}

for (const type of ['organizationMembership.created', 'user.created', 'session.pending', undefined]) {
    const { handled, calls } = capture({ type, data: sessionData });
    ok(!handled && calls.length === 0, `${type}: not handled here`);
}
ok(!isClerkSessionEvent(null) && !isClerkSessionEvent({}), 'empty events are not session events');
ok(!isClerkSessionEvent({ type: 'toString' }), 'prototype names are not event types');

{
    const { calls } = capture({ type: 'session.ended', data: { id: 42, user_id: { nested: true } } });
    ok(calls[0].session_id === undefined && calls[0].user_id === undefined, 'non-string IDs are dropped, not logged');
}

eq(Object.keys(SESSION_EVENT_LOG).sort(), ['session.created', 'session.ended', 'session.removed', 'session.revoked'],
   'the subscribed event types');

const src = fs.readFileSync(path.join(__dirname, '../utils/clerk_session_events.js'), 'utf8');
ok(!/redis|permify|fetch\(/i.test(src.replace(/\/\*\*[\s\S]*?\*\//g, '')), 'module code touches no Redis, Permify or network');

const index = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const hook = index.indexOf('handleClerkSessionEvent(event)');
ok(hook > index.indexOf('wh.verify(') && hook > 0, 'called only after svix verification');
ok(/await verifyToken\(token, \{ secretKey/.test(index), 'authMiddleware keeps stateless verifyToken (RV-24)');

console.log(`verify_clerk_session_events: ${passed} checks passed`);
