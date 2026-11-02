'use strict';
/**
 * Guest node-share tokens (utils/share_tokens.js): GL-4/S2-72 (no in-code secret, constant-time compare,
 * non-numeric expiry rejected, right-to-left parsing) and GL-5 (Redis error denies the link; failed
 * registration issues no link). Unit tests with a fake Redis. Run: node tests/verify_share_tokens.js
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createShareTokens, shareSecretProblem, tokenHash, MIN_SHARE_SECRET_LENGTH,
        GUEST_LINK_KEY_PREFIX } = require('../utils/share_tokens');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const quiet = { log() {}, warn() {}, error() {} };
const SECRET = 'x'.repeat(MIN_SHARE_SECRET_LENGTH);

function fakeRedis({ failGet = false, failWrite = false } = {}) {
    const store = {};
    return {
        store,
        async get(k) { if (failGet) throw new Error('redis down'); return store[k] ?? null; },
        async setex(k, ttl, v) { if (failWrite) throw new Error('redis down'); store[k] = v; },
        async sadd() { if (failWrite) throw new Error('redis down'); },
        async expire() {},
    };
}
const forge = (payload, secret = SECRET) =>
    Buffer.from(`${payload}:${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`).toString('base64');

(async () => {
    // ── no in-code default (AP-24) ─────────────────────────────────────────────────────────────
    {
        const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
        ok(!/cortex_default_fallback_secret/.test(src), 'index.js has no default share secret');
        ok(!/GATEWAY_SHARE_SECRET\s*\|\|\s*['"][^'"]+['"]/.test(src), 'no non-empty fallback for GATEWAY_SHARE_SECRET');
        ok(/process\.exit\(1\)/.test(src.slice(src.indexOf('shareSecretProblem('), src.indexOf('createShareTokens({'))),
           'production refuses to start without a usable secret');
        // Production sets BENTO_SERVER_URL only; BENTO_URL fell back to localhost and broke the link
        // preview and group share (found on the GL-4 candidate, 2026-11-02).
        ok(!/process\.env\.BENTO_URL\b/.test(src), 'every Bento call reads BENTO_SERVER_URL');
        // Bento is IAM-locked (run.invoker for the gateway's service account only): a call without the
        // Cloud Run ID token gets 403 (share preview, user/group share, infer — same finding).
        const lines = src.split('\n');
        const bentoCalls = lines.map((l, i) => i).filter(i => /fetch(WithColdStartRetry)?\(`\$\{(bento|bentoBase|bentoUrl|bentoServerUrl)\}/.test(lines[i]));
        const untokened = bentoCalls.filter(i => !lines.slice(Math.max(0, i - 6), i + 1).some(l => /getCloudRunToken\(/.test(l)));
        ok(bentoCalls.length >= 10 && untokened.length === 0,
           `every Bento fetch gets a Cloud Run ID token first (${bentoCalls.length} calls, missing at lines ${untokened.map(i => i + 1).join(', ') || 'none'})`);
    }
    // ── secret validation ──────────────────────────────────────────────────────────────────────
    {
        ok(shareSecretProblem(undefined), 'unset secret is a problem');
        ok(shareSecretProblem(''), 'empty secret is a problem');
        ok(shareSecretProblem('x'.repeat(MIN_SHARE_SECRET_LENGTH - 1)), 'short secret is a problem');
        eq(shareSecretProblem(SECRET), null, `${MIN_SHARE_SECRET_LENGTH}-char secret is fine`);
    }
    // ── unconfigured: sign refuses, verify rejects everything ──────────────────────────────────
    {
        for (const secret of [undefined, '', 'short']) {
            const t = createShareTokens({ secret, redis: fakeRedis(), log: quiet });
            eq(t.configured, false, `configured=false for ${JSON.stringify(secret)}`);
            let status;
            try { t.sign('org_1', 'node-1', 30); } catch (e) { status = e.status; }
            eq(status, 503, 'sign without a usable secret → 503');
            eq(t.verify(forge(`org_1:node-1:${Date.now() + 60000}`, secret || '')), null, 'verify without a usable secret → null');
        }
    }
    // ── sign + verify round trip ───────────────────────────────────────────────────────────────
    const t = createShareTokens({ secret: SECRET, redis: fakeRedis(), log: quiet });
    {
        const { token, expiresAt } = t.sign('org_1', 'node-1', 30);
        const v = t.verify(token);
        eq([v.tenantId, v.nodeId, v.expiresAt], ['org_1', 'node-1', expiresAt], 'valid token verifies');
        const p = t.verify(t.sign('personal:user_abc', 'node-2', 1).token);
        eq([p.tenantId, p.nodeId], ['personal:user_abc', 'node-2'], "tenant id with ':' parses from the right");
        let status;
        try { t.sign('org_1', 'a:b', 30); } catch (e) { status = e.status; }
        eq(status, 400, "node id with ':' cannot be signed (no ambiguous payloads)");
    }
    // ── rejects tampering, expiry, malformed ───────────────────────────────────────────────────
    {
        const future = Date.now() + 60000;
        const decoded = Buffer.from(t.sign('org_1', 'node-1', 30).token, 'base64').toString('utf-8');
        const flipped = decoded.slice(0, -1) + (decoded.endsWith('0') ? '1' : '0');
        eq(t.verify(Buffer.from(flipped).toString('base64')), null, 'tampered signature rejected');
        eq(t.verify(Buffer.from(decoded.slice(0, -2)).toString('base64')), null, 'wrong-length signature rejected');
        eq(t.verify(forge(`org_1:node-1:${future}`, 'y'.repeat(MIN_SHARE_SECRET_LENGTH))), null, 'other secret rejected');
        eq(t.verify(forge(`org_1:node-1:${Date.now() - 1}`)), null, 'expired token rejected');
        eq(t.verify(forge('org_1:node-1:never')), null, 'non-numeric expiry rejected (was accepted forever: Date.now() > NaN is false)');
        eq(t.verify(forge('org_1:node-1:')), null, 'empty expiry rejected');
        eq(t.verify(forge(`org_1:node-1:${future}.5`)), null, 'fractional expiry rejected');
        eq(t.verify(forge(`:node-1:${future}`)), null, 'empty tenant rejected');
        eq(t.verify(Buffer.from('a:b:c').toString('base64')), null, 'too few fields rejected');
        eq(t.verify(''), null, 'empty token rejected');
        eq(t.verify(undefined), null, 'missing token rejected');
        eq(t.verify('%%%not-base64%%%'), null, 'garbage rejected');
    }
    // ── check(): revocation via Redis; Redis error denies (GL-5) ───────────────────────────────
    {
        const redis = fakeRedis();
        const tk = createShareTokens({ secret: SECRET, redis, log: quiet });
        const { token, expiresAt } = tk.sign('org_1', 'node-1', 30);
        eq((await tk.check(token)).status, 403, 'unregistered token → 403');
        const hash = await tk.register(token, { tenantId: 'org_1', nodeId: 'node-1', issuedAt: Date.now(), expiresAt, expireDays: 30 });
        eq(hash, tokenHash(token), 'register returns the token hash');
        ok(redis.store[`${GUEST_LINK_KEY_PREFIX}${hash}`], 'registration stored under guest_link:<hash>');
        eq(await tk.check(token), { ok: true, tenantId: 'org_1', nodeId: 'node-1' }, 'registered token → ok');
        delete redis.store[`${GUEST_LINK_KEY_PREFIX}${hash}`];
        eq((await tk.check(token)).status, 403, 'revoked token → 403');
        eq((await tk.check('bogus')).status, null, 'invalid token → not a share token (falls through to normal auth)');

        const down = createShareTokens({ secret: SECRET, redis: fakeRedis({ failGet: true }), log: quiet });
        const r = await down.check(down.sign('org_1', 'node-1', 30).token);
        eq([r.ok, r.status], [false, 503], 'Redis error during the check → denied with 503, not signature-only');

        const noWrite = createShareTokens({ secret: SECRET, redis: fakeRedis({ failWrite: true }), log: quiet });
        let status;
        try { await noWrite.register(noWrite.sign('org_1', 'node-1', 30).token, { tenantId: 'org_1', nodeId: 'node-1', expireDays: 30 }); }
        catch (e) { status = e.status; }
        eq(status, 503, 'failed registration → 503, no dead link handed out');
    }
    console.log(`verify_share_tokens: ${passed} passed`);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
