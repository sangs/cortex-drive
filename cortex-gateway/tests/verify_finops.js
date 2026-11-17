'use strict';
/**
 * Owner-only cost summary (FinOps S2-83 release 4): the query, the contract, the cache, the failure path and the
 * route's owner-only rule. No live BigQuery here (the release check runs the real query as cortex-gateway@).
 *
 *     node cortex-gateway/tests/verify_finops.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const finops = require('../utils/finops');
const { capabilitiesFor } = require('../utils/capabilities');
const { USER_TYPES } = require('../utils/identity');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const PROJECTS = { finops: 'finops-proj', usage: 'usage-proj' };
const PAYLOAD = {
    totals: { today: '2026-11-17', today_cost: '0.2375', month_to_date: '9.315', last_month: '13.48', forecast_month_end: '16.44', threshold_usd: null },
    by_provider: [{ provider: 'Google Cloud', sources: 'billing_export', month_to_date: '9.27' },
                  { provider: 'OpenAI', sources: 'app_recorded', month_to_date: '0.04' }],
    by_gcp_service: [{ service: 'Cloud SQL', mtd: '4.96' }],
    daily: [{ date: '2026-11-16', provider: 'Google Cloud', cost: '0.5' }],
    sources: [{ source: 'app_recorded', provider: 'OpenAI', as_of: '2026-11-17T14:16:13Z', is_stale: false },
              { source: 'billing_export', provider: 'Google Cloud', as_of: null, is_stale: true }],
    app_recorded_since: '2026-11-17',
    live_today: 0.7635,
};
const RESULT = { jobComplete: true, rows: [{ f: [{ v: JSON.stringify(PAYLOAD) }] }] };
const ENV = { FINOPS_PROJECT: 'finops-proj', USAGE_PROJECT: 'usage-proj' };

test('query: only this product\'s views and the usage table, every parameter used', () => {
    const body = finops.buildQuery(PROJECTS);
    for (const v of Object.values(finops.CONFIG.views)) assert.ok(body.query.includes(`\`finops-proj.finops_cortex_drive.${v}\``), v);
    assert.ok(body.query.includes('`usage-proj.cortex_usage.run_googleapis_com_stdout`'));
    assert.ok(!/finops_gmail_digest|finops\.cost_daily|billing_export\./.test(body.query), 'no other product, no base tables');
    for (const p of body.queryParameters) assert.ok(body.query.includes(`@${p.name}`), `orphaned parameter ${p.name}`);
    assert.strictEqual(body.maximumBytesBilled, String(finops.CONFIG.max_bytes_billed));
    assert.ok(body.query.includes('PARTITION BY insertId'), 'live figure removes duplicate log deliveries');
});

test('names spliced into SQL are validated (no injection through env)', () => {
    assert.throws(() => finops.buildQuery({ finops: 'x`; DROP', usage: 'u' }), finops.FinopsUnavailable);
    assert.throws(() => finops.projectsFrom({ USAGE_PROJECT: 'u' }), finops.FinopsUnavailable, 'no default project');
});

test('contract: §4.2 shape, numbers, sources split, record-only threshold', () => {
    const s = finops.buildSummary(PAYLOAD, new Date('2026-11-17T16:00:00Z'));
    assert.strictEqual(s.project, 'cortex-drive');
    assert.deepStrictEqual(Object.keys(s).sort(), ['alerts', 'as_of', 'by_gcp_service', 'by_provider', 'currency', 'daily',
        'generated_at', 'live', 'project', 'sources', 'totals', 'untracked_before'].sort());
    assert.strictEqual(s.totals.month_to_date, 9.315);
    assert.strictEqual(s.totals.threshold, null);
    assert.strictEqual(s.totals.pct_of_threshold, null);
    assert.deepStrictEqual(s.by_provider[0].sources, ['billing_export']);
    assert.strictEqual(s.live.app_spend_today_utc, 0.7635);
    assert.deepStrictEqual(s.alerts, [{ level: 'warning', message: 'Google Cloud data is out of date (as of never)' }]);
});

test('alerts when a limit exists', () => {
    const a = finops.alertsFor({ month_to_date: 21, threshold: 25, forecast_month_end: 30 }, []);
    assert.strictEqual(a[0].level, 'warning');
    assert.ok(/84%/.test(a[0].message));
    assert.ok(/forecast/.test(a[1].message));
});

test('cache: a fresh entry is served without BigQuery; refresh bypasses it', async () => {
    const store = new Map();
    const redis = { get: async k => store.get(k) || null, set: async (k, v) => { store.set(k, v); } };
    let calls = 0;
    const query = async () => { calls++; return RESULT; };
    const first = await finops.getSummary({ redis, query, env: ENV });
    const second = await finops.getSummary({ redis, query, env: ENV });
    assert.strictEqual(first.cached, false);
    assert.strictEqual(second.cached, true);
    assert.strictEqual(calls, 1);
    await finops.getSummary({ redis, query, env: ENV, refresh: true });
    assert.strictEqual(calls, 2);
});

test('failures become a user-safe FinopsUnavailable (cause kept for the log)', async () => {
    const boom = async () => { throw new Error('403 Access Denied: secret detail'); };
    await assert.rejects(finops.getSummary({ query: boom, env: ENV }), e => e instanceof finops.FinopsUnavailable
        && !/secret detail/.test(e.message) && /secret detail/.test(e.cause.message));
    await assert.rejects(finops.getSummary({ query: async () => ({ jobComplete: false }), env: ENV }), finops.FinopsUnavailable);
    const brokenRedis = { get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); } };
    assert.strictEqual((await finops.getSummary({ redis: brokenRedis, query: async () => RESULT, env: ENV })).cached, false);
});

test('route: owner only, 404 for every other user type, no-store', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const route = src.slice(src.indexOf("app.get('/api/finops/summary'"), src.indexOf("app.get('/api/finops/summary'") + 700);
    assert.ok(route.includes("res.set('Cache-Control', 'private, no-store')"));
    assert.ok(/if \(!capabilitiesFor\(principalFromRequest\(req, isOwner\)\)\.finops\) return res\.status\(404\)/.test(route));
    const types = { owner: [USER_TYPES.OWNER, true], org_admin: [USER_TYPES.ORG_ADMIN, false], org_member: [USER_TYPES.ORG_MEMBER, false],
        collaborator: [USER_TYPES.COLLABORATOR, false], guest: [USER_TYPES.GUEST, false] };
    for (const [name, [type, allowed]] of Object.entries(types)) {
        const p = { type, isOwner: name === 'owner', isOrgAdmin: name === 'org_admin', guest: name === 'guest' };
        assert.strictEqual(capabilitiesFor(p).finops, allowed, name);
    }
});

test('deploy passes the project ids (no defaults in code)', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'build-deploy-gateway.sh'), 'utf8');
    assert.ok(script.includes('FINOPS_PROJECT=${FINOPS_PROJECT:?run: source scripts/cloud-env.sh},USAGE_PROJECT=${PROJECT_ID}'));
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err && err.stack}`); process.exitCode = 1; }
    }
    console.log(`verify_finops: ${passed}/${tests.length} passed`);
})();
