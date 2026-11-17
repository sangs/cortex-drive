'use strict';
/**
 * Owner's manual pause of OpenAI spend (FinOps S2-83 release 5): setting + audit in one statement, Redis mirror,
 * cached reads, fail-open, the /query guard, owner-only routes. Fake db / Redis; no network.
 *
 *     node cortex-gateway/tests/verify_openai_pause.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createOpenAIPause, UPSERT_WITH_AUDIT, CONFIG } = require('../utils/openai_pause');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const quiet = { warn: () => {} };

function fakes() {
    const row = { value: null, updated_by: null, updated_at: null };
    const audit = [];
    const db = {
        async query(sql, params) {
            if (sql === UPSERT_WITH_AUDIT) {
                audit.push({ old: row.value, new: JSON.parse(params[1]), by: params[2], reason: params[3] });
                Object.assign(row, { value: JSON.parse(params[1]), updated_by: params[2], updated_at: '2026-11-17T18:00:00Z' });
                return { rows: [{ changed_at: 'now' }] };
            }
            return { rows: row.value ? [row] : [] };
        },
    };
    const store = new Map();
    let reads = 0;
    const redis = { get: async k => { reads++; return store.get(k) ?? null; }, set: async (k, v) => { store.set(k, v); } };
    return { db, redis, audit, store, reads: () => reads };
}

test('the change and its audit row are one statement', () => {
    assert.ok(/INSERT INTO app_settings \(/.test(UPSERT_WITH_AUDIT) && /INSERT INTO app_settings_audit/.test(UPSERT_WITH_AUDIT));
    assert.ok(/^\s*WITH old AS/.test(UPSERT_WITH_AUDIT), 'single CTE statement: no change without audit');
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'migrations', '012_app_settings.sql'), 'utf8');
    assert.ok(/BEFORE UPDATE OR DELETE ON app_settings_audit/.test(sql), 'audit table is append-only');
});

test('pause → audit row, Redis mirror, status; resume likewise', async () => {
    const f = fakes();
    const p = createOpenAIPause({ db: f.db, redis: f.redis, log: quiet });
    const s = await p.set({ paused: true, reason: '  monthly spend check  ', by: 'user_owner' });
    assert.deepStrictEqual([s.paused, s.reason, s.updated_by], [true, 'monthly spend check', 'user_owner']);
    assert.deepStrictEqual(JSON.parse(f.store.get(CONFIG.redis_key)), { paused: true });
    await p.set({ paused: false, by: 'user_owner' });
    assert.strictEqual(f.audit.length, 2);
    assert.deepStrictEqual(f.audit[1].old, { paused: true, reason: 'monthly spend check' });
    assert.strictEqual(f.audit[1].new.paused, false);
    await assert.rejects(p.set({ paused: 'yes', by: 'x' }), TypeError);
    assert.strictEqual(f.audit.length, 2, 'invalid input writes nothing');
});

test('reason is clipped to the configured length', async () => {
    const f = fakes();
    const p = createOpenAIPause({ db: f.db, redis: f.redis, log: quiet });
    await p.set({ paused: true, reason: 'x'.repeat(1000), by: 'o' });
    assert.strictEqual(f.audit[0].reason.length, CONFIG.reason_max_chars);
});

test('reads are cached for cache_seconds', async () => {
    const f = fakes();
    let t = 0;
    const p = createOpenAIPause({ db: f.db, redis: f.redis, now: () => t, log: quiet });
    f.store.set(CONFIG.redis_key, JSON.stringify({ paused: true }));
    assert.strictEqual((await p.current()).paused, true);
    f.store.set(CONFIG.redis_key, JSON.stringify({ paused: false }));
    t += (CONFIG.cache_seconds - 1) * 1000;
    assert.strictEqual((await p.current()).paused, true, 'still cached');
    t += 2000;
    assert.strictEqual((await p.current()).paused, false, 'refreshed after expiry');
    assert.strictEqual(f.reads(), 2);
});

test('Redis down: last known state, else not paused (fail open)', async () => {
    let t = 0;
    const down = { get: async () => { throw new Error('down'); }, set: async () => {} };
    const p = createOpenAIPause({ db: fakes().db, redis: down, now: () => t, log: quiet });
    assert.strictEqual((await p.current()).paused, false);
    const f = fakes();
    let fail = false;
    const flaky = { get: async k => { if (fail) throw new Error('down'); return f.store.get(k) ?? null; }, set: f.redis.set };
    const q = createOpenAIPause({ db: f.db, redis: flaky, now: () => t, log: quiet });
    f.store.set(CONFIG.redis_key, JSON.stringify({ paused: true }));
    await q.current();
    fail = true; t += CONFIG.cache_seconds * 1000;
    assert.strictEqual((await q.current()).paused, true, 'keeps the last known paused state');
});

test('resync copies Postgres to Redis (a Redis restart never resumes spend)', async () => {
    const f = fakes();
    const p = createOpenAIPause({ db: f.db, redis: f.redis, log: quiet });
    await p.set({ paused: true, by: 'o' });
    f.store.clear();
    assert.strictEqual(await p.resync(), true);
    assert.deepStrictEqual(JSON.parse(f.store.get(CONFIG.redis_key)), { paused: true });
    const broken = createOpenAIPause({ db: { query: async () => { throw new Error('db down'); } }, redis: f.redis, log: quiet });
    assert.strictEqual(await broken.resync(), null, 'never throws');
});

test('guard: 503 with the owner\'s message while paused, next() otherwise', async () => {
    const f = fakes();
    const p = createOpenAIPause({ db: f.db, redis: f.redis, log: quiet });
    const run = () => new Promise(resolve => {
        const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; },
            json(b) { resolve({ code: this.code, body: b }); } };
        p.guard({}, res, () => resolve({ next: true }));
    });
    assert.deepStrictEqual(await run(), { next: true });
    await p.set({ paused: true, by: 'o' });
    const r = await run();
    assert.strictEqual(r.code, 503);
    assert.deepStrictEqual(r.body, { error: CONFIG.paused_message, paused: true });
});

test('routes: /query guarded; pause routes owner-only with 404', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.ok(src.includes("app.post('/query', authMiddleware, openaiPause.guard, async (req, res) => {"));
    for (const verb of ['get', 'post']) {
        const at = src.indexOf(`app.${verb}('/api/finops/pause'`);
        assert.ok(at > 0, `${verb} route exists`);
        assert.ok(/if \(!capabilitiesFor\(principalFromRequest\(req, isOwner\)\)\.finops\) return res\.status\(404\)/.test(src.slice(at, at + 400)), `${verb}: owner only`);
    }
    assert.ok(src.includes('openaiPause.resync();'), 'resync at start-up');
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err && err.stack}`); process.exitCode = 1; }
    }
    console.log(`verify_openai_pause: ${passed}/${tests.length} passed`);
})();
