'use strict';
/**
 * S2-93: invite emails report whether they were sent (utils/notify_email.js, utils/invite_delivery.js;
 * design documents/architecture/share-results-and-invite-delivery-design-2026-11-19.md).
 * - sendEmail: accepted → sent + provider id; non-2xx, timeout, network error, missing key → sent:false with a reason;
 *   never throws; the log line carries no address, subject or body;
 * - deliverInvite: result stored on the pending invitation and returned as emailSent; a failed account step is a
 *   failure, not a silent "sent"; the sign-in link is never logged; inviter names are HTML-escaped;
 * - index.js: no inline Resend call left; every invite route returns emailSent; resends answer 502 on failure;
 *   /api/share/pending exposes email_status.
 * No network. Run: node tests/verify_notify_email.js (npm test).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sendEmail, escapeHtml, REASONS } = require('../utils/notify_email');
const { createInviteDelivery, deliveryFields } = require('../utils/invite_delivery');
const { buildLogEntry } = require('../utils/log_event');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };

const ADDRESS = 'person@example.org';
const MSG = { to: ADDRESS, subject: 'Secret subject', html: '<p>secret body</p>', kind: 'invite' };
const jsonResp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

(async () => {
    // ── sendEmail ────────────────────────────────────────────────────────────────────────────
    const logs = [];
    const log = (e, f) => logs.push(JSON.stringify(buildLogEntry(e, f)));
    let calls = 0;

    let r = await sendEmail(MSG, { apiKey: 'k', log, fetchImpl: async () => { calls++; return jsonResp(200, { id: 're_123' }); } });
    eq([r.sent, r.providerId, r.status], [true, 're_123', 200], 'accepted → sent with provider id');
    eq(calls, 1, 'one attempt, no retry');

    r = await sendEmail(MSG, { apiKey: 'k', log, fetchImpl: async () => jsonResp(403, { message: 'domain not verified' }) });
    eq([r.sent, r.reason, r.status], [false, REASONS.REJECTED, 403], 'refused by the provider → not sent (was logged as sent before S2-93)');

    r = await sendEmail(MSG, { apiKey: 'k', log, fetchImpl: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; } });
    eq([r.sent, r.reason], [false, REASONS.TIMEOUT], 'timeout → not sent');

    r = await sendEmail(MSG, { apiKey: 'k', log, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    eq([r.sent, r.reason], [false, REASONS.NETWORK], 'network error → not sent, no throw');

    r = await sendEmail(MSG, { apiKey: '', log, fetchImpl: async () => { throw new Error('must not be called'); } });
    eq([r.sent, r.reason], [false, REASONS.NOT_CONFIGURED], 'no API key → not sent, provider not called');

    r = await sendEmail({ ...MSG, to: '' }, { apiKey: 'k', log, fetchImpl: async () => jsonResp(200, {}) });
    eq(r.reason, REASONS.INVALID, 'missing recipient → invalid');

    r = await sendEmail(MSG, { apiKey: 'k', log, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }) });
    eq([r.sent, r.providerId], [true, null], 'accepted with unreadable body → sent, id unknown');

    const allLogs = logs.join('\n');
    ok(!allLogs.includes(ADDRESS) && !allLogs.includes('Secret subject') && !allLogs.includes('secret body'),
       'log lines carry no address, subject or body');
    ok(logs.every(l => JSON.parse(l).tag === 'NOTIFY'), 'every attempt logged under [NOTIFY]');

    eq(escapeHtml('<b>"A" & \'B\'</b>'), '&lt;b&gt;&quot;A&quot; &amp; &#39;B&#39;&lt;/b&gt;', 'HTML escaping');

    // ── deliverInvite ────────────────────────────────────────────────────────────────────────
    const fakeClerk = ({ existing = false, failCreate = false } = {}) => ({
        users: {
            getUserList: async () => ({ data: existing ? [{ id: 'user_existing' }] : [] }),
            createUser: async () => { if (failCreate) { const e = new Error('422'); e.errors = [{ code: 'form_identifier_exists' }]; throw e; } return { id: 'user_new' }; },
            getUser: async () => ({ firstName: '<Eve>', lastName: 'Admin', emailAddresses: [] }),
        },
        signInTokens: { createSignInToken: async () => ({ token: 'TICKET_SECRET' }) },
    });
    const fakeDb = () => { const q = []; return { q, query: async (sql, params) => { q.push({ sql, params }); return { rows: [] }; } }; };

    for (const [label, sendOk, expectStatus] of [['accepted', true, 'sent'], ['refused', false, 'failed']]) {
        const db = fakeDb(); const sent = []; const dlogs = [];
        const d = createInviteDelivery({
            clerkClient: fakeClerk(), db, activatePendingGrants: async () => {}, appUrl: 'https://app.test',
            send: async m => { sent.push(m); return sendOk ? { sent: true, providerId: 're_9' } : { sent: false, reason: REASONS.REJECTED }; },
            log: (e, f) => dlogs.push(JSON.stringify(buildLogEntry(e, f))),
        });
        const res = await d.deliverInvite({ email: ' Person@Example.org ', inviterName: '<Eve> Admin', invitationType: 'share', resourceId: 'g1' });
        eq(res.emailSent, sendOk, `${label}: emailSent returned`);
        eq(sent.length, 1, `${label}: one email`);
        eq(sent[0].to, 'person@example.org', `${label}: address normalised`);
        ok(sent[0].html.includes('&lt;Eve&gt; Admin') && !sent[0].html.includes('<Eve>'), `${label}: inviter name escaped in the email`);
        ok(sent[0].html.includes('__clerk_ticket=TICKET_SECRET'), `${label}: the invitee's email carries the sign-in link`);
        const upd = db.q.find(x => /UPDATE invitations/.test(x.sql));
        ok(upd && upd.params[3] === expectStatus && upd.params[0] === 'share' && upd.params[1] === 'g1', `${label}: status ${expectStatus} stored on the invitation`);
        ok(/status = 'pending'/.test(upd.sql), `${label}: only the pending invitation is updated`);
        const dl = dlogs.join('\n');
        ok(!dl.includes('person@example.org') && !dl.includes('TICKET_SECRET'), `${label}: no address or sign-in link in the log`);
        ok(!('signInUrl' in res) && !JSON.stringify(res).includes('TICKET'), `${label}: the link is never returned to the sharer`);
    }

    {
        const db = fakeDb(); let sentCount = 0;
        const d = createInviteDelivery({ clerkClient: fakeClerk({ failCreate: true }), db, activatePendingGrants: async () => {},
            send: async () => { sentCount++; return { sent: true }; }, log: () => {} });
        const res = await d.deliverInvite({ email: ADDRESS, inviterName: 'X', invitationType: 'group', resourceId: 'grp' });
        eq([res.emailSent, res.reason, sentCount], [false, 'account_step_failed', 0], 'a failed account step is reported, not swallowed');
        ok(db.q.some(x => x.params && x.params[3] === 'failed'), 'failure stored on the invitation');
    }
    {
        const d = createInviteDelivery({ clerkClient: fakeClerk({ existing: true }), db: fakeDb(), activatePendingGrants: async () => { throw new Error('must not run'); },
            send: async () => ({ sent: true }), log: () => {} });
        eq((await d.deliverInvite({ email: ADDRESS, inviterName: 'X', invitationType: 'share', resourceId: 'g' })).emailSent, true,
           'existing account: no account created, link still sent');
        eq(await d.inviterDisplayName('sub', 'fallback'), '<Eve> Admin', 'inviter display name from Clerk');
    }
    eq(deliveryFields({ emailSent: false, reason: 'x' }), { emailSent: false }, 'routes expose only emailSent');

    // ── index.js wiring ──────────────────────────────────────────────────────────────────────
    const index = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    ok(!index.includes('api.resend.com') && !index.includes('sendClerkOrgInvitation'), 'no inline Resend call or old sender left');
    eq((index.match(/inviteDelivery\.deliverInvite\(/g) || []).length, 5, 'all five invite routes use deliverInvite');
    eq((index.match(/\.\.\.deliveryFields\(delivery\)/g) || []).length, 7, 'every invite route returns emailSent');
    eq((index.match(/if \(!delivery\.emailSent\) return res\.status\(502\)/g) || []).length, 2, 'both resend routes answer 502 when the email fails');
    ok(/email_status,\s*email_last_attempt_at\s*FROM pending_invites/.test(index), '/api/share/pending exposes delivery status');
    const migration = fs.readFileSync(path.join(__dirname, '../../scripts/migrations/013_invitation_delivery.sql'), 'utf8');
    ok(/ADD COLUMN IF NOT EXISTS email_status/.test(migration) && /i\.email_status,\s*i\.email_last_attempt_at\s*FROM invitations/.test(migration),
       'migration 013 adds the columns and appends them to the view');

    console.log(`verify_notify_email: ${passed} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
