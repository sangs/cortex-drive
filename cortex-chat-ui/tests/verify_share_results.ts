/**
 * S2-93 (2026-11-19): the share dialog shows what the gateway really did. Design:
 * documents/architecture/share-results-and-invite-delivery-design-2026-11-19.md. Run: `npm test`.
 * Found 2026-11-19: sharing the PUBLIC career map got 409 "already visible to everyone", and the dialog said "Invite sent".
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { readShareResult, inviteMessage, needsGrant, PUBLIC_ONLY_TEXT } from '../utils/shareResult.ts';

let passed = 0;
const ok = (cond: unknown, msg: string) => { assert.ok(cond, msg); passed++; };
const eq = (a: unknown, b: unknown, msg: string) => { assert.deepEqual(a, b, msg); passed++; };
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const resp = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const EVERYONE = 'This node is already visible to everyone (Public or built-in), so it cannot be shared';

// ── readShareResult ──────────────────────────────────────────────────────────────────────────
let r = await readShareResult(resp(409, { error: EVERYONE, everyone_visible: true }));
eq([r.ok, r.status, r.error], [false, 409, EVERYONE], 'a 409 refusal is a failure with the gateway text (the 2026-11-19 case)');
r = await readShareResult(resp(403, { error: 'You cannot share these nodes', denied: ['a', 'b'] }));
eq(r.error, 'You cannot share these nodes (2 nodes)', 'denied nodes are counted');
r = await readShareResult({ ok: false, status: 500, json: async () => { throw new Error('html'); } });
ok(!r.ok && /error 500/.test(r.error || ''), 'a non-JSON failure still reads as a failure');
r = await readShareResult(resp(200, { pending: true, emailSent: true }));
eq([r.ok, r.data.emailSent], [true, true], 'success passes the data through');

// ── Invite text ──────────────────────────────────────────────────────────────────────────────
eq(inviteMessage('a@x.org', { emailSent: true }).ok, true, 'email sent → success text');
ok(/could not be sent/.test(inviteMessage('a@x.org', { emailSent: false }).text) && !inviteMessage('a@x.org', { emailSent: false }).ok,
   'email failed → "saved, but the email could not be sent", shown as an error');
ok(!/sent to/.test(inviteMessage('a@x.org', { emailSent: false }).text), 'never claims "sent" when it was not');

// ── Public-only selections ───────────────────────────────────────────────────────────────────
eq([needsGrant({ roots: 0 }), needsGrant({ roots: 3 }), needsGrant(null)], [false, true, false], 'roots = nodes needing a grant');
ok(/already visible to everyone/.test(PUBLIC_ONLY_TEXT) && /Public Link/.test(PUBLIC_ONLY_TEXT), 'public-only text points to a link');

// ── Dialog wiring (source checks) ────────────────────────────────────────────────────────────
const modal = read('components/GraphShareModal.tsx');
eq((modal.match(/await readShareResult\(await fetch\(`\$\{GATEWAY\}\/api\/share\/graph-island`/g) || []).length, 3,
   'all three share handlers read the real result');
ok(!/await resp\.json\(\);\s*const msg = data\.reused/.test(modal), 'no handler shows success without checking the status');
ok(/resolveError === 'not_found' && shareCheck === 'needs-grant'/.test(modal), 'the invite prompt appears only when something needs a grant');
ok(/tab === 'user' && publicOnly/.test(modal) && /tab === 'group' && publicOnly/.test(modal), 'public-only selections explain instead of offering a share');
ok(/role="alert"[^>]*>\{userError\}/.test(modal) && /role="alert"[^>]*>\{groupError\}/.test(modal), 'errors are shown');

const sharing = read('app/settings/sharing/page.tsx');
ok(/<EmailStatusBadge status=\{invite\.email_status \?\? null\} \/>/.test(sharing), 'pending invites show their email status');
ok(/readShareResult\(await fetch\(url, \{ method: 'POST', headers \}\)\)/.test(sharing), 'Resend shows what really happened');

console.log(`verify_share_results: ${passed} checks passed`);
