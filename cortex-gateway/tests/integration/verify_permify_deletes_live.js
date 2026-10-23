'use strict';

/**
 * S2-39 / S2-40: run the gateway's real Permify delete functions against a REAL Permify and check
 * each removes exactly one entry. Never point this at production: it creates throwaway tenants.
 *
 *   docker run -d --name permify-probe --platform linux/amd64 -p 13476:3476 \
 *     <the image pinned in scripts/build-deploy-permify.sh> serve --database-engine=memory
 *   PERMIFY_LIVE_URL=http://localhost:13476 node tests/integration/verify_permify_deletes_live.js
 *
 * Skips (exit 0) when PERMIFY_LIVE_URL is not set, so it is safe in any test run.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const LIVE = process.env.PERMIFY_LIVE_URL;
if (!LIVE) { console.log('verify_permify_deletes_live: skipped (PERMIFY_LIVE_URL not set)'); process.exit(0); }
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(LIVE)) {
    console.error('PERMIFY_LIVE_URL must be a local Permify (http://localhost:<port>)'); process.exit(1);
}

const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'scripts', 'permify', 'authorization_schema.perm'), 'utf8');
const tup = (et, eid, rel, st, sid, srel) => ({ entity: { type: et, id: eid }, relation: rel, subject: { type: st, id: sid, ...(srel ? { relation: srel } : {}) } });
const FIXTURE = [
    tup('node', 'n1', 'shared_viewer', 'user', 'alice'), tup('node', 'n1', 'shared_viewer', 'user', 'bob'),
    tup('node', 'n2', 'shared_viewer', 'user', 'alice'), tup('node', 'n1', 'shared_viewer', 'group', 'g1', 'member'),
    tup('node', 'n2', 'shared_viewer', 'group', 'g2', 'member'), tup('node', 'n1', 'tenant_viewer', 'org', 'o1', 'member'),
    tup('node', 'n2', 'tenant_viewer', 'org', 'o1', 'member'), tup('group', 'g1', 'member', 'user', 'alice'),
    tup('group', 'g1', 'member', 'user', 'bob'),
];
const key = t => `${t.entity.type}:${t.entity.id}#${t.relation}@${t.subject.type}:${t.subject.id}${t.subject.relation ? '#' + t.subject.relation : ''}`;
const priv = id => ({ entity: { type: 'node', id }, attribute: 'is_private', value: { '@type': 'type.googleapis.com/base.v1.BooleanValue', data: true } });

async function post(tenant, p, body) {
    const r = await fetch(`${LIVE}/v1/tenants/${tenant}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p} → ${r.status} ${JSON.stringify(j)}`);
    return j;
}
async function state(tenant) {
    const out = new Set();
    for (const type of ['node', 'group']) {
        const d = await post(tenant, '/data/relationships/read', { metadata: { snap_token: '' }, filter: { entity: { type, ids: [] }, relation: '' }, page_size: 100 });
        (d.tuples || []).forEach(t => out.add(key(t)));
    }
    const a = await post(tenant, '/data/attributes/read', { metadata: { snap_token: '' }, filter: { entity: { type: 'node', ids: [] }, attributes: [] }, page_size: 100 });
    (a.attributes || []).forEach(x => out.add(`${x.entity.id}.${x.attribute}`));
    return out;
}

let passed = 0;
(async () => {
    const permifyPath = require.resolve('../../utils/permify_gateway.js');
    const cases = [
        ['user revoke', p => p.revokeNodeAccess('n1', p.audienceSubject('user', 'alice')), ['node:n1#shared_viewer@user:alice']],
        ['group revoke', p => p.revokeNodeAccess('n1', p.audienceSubject('group', 'g1')), ['node:n1#shared_viewer@group:g1#member']],
        ['tenant-wide off', p => p.removeNodeTenantWide('n1', 'o1'), ['node:n1#tenant_viewer@org:o1#member']],
        ['group member removal', p => p.removeGroupMember('g1', 'alice'), ['group:g1#member@user:alice']],
        ['privacy off', p => p.writePrivacyAttribute('n1', false), ['n1.is_private']],
        ['tenant-wide on', p => p.makeNodeTenantWide('n3', 'o1'), [], ['node:n3#tenant_viewer@org:o1#member']],
    ];
    for (const [i, [label, act, removed, added = []]] of cases.entries()) {
        const tenant = `live${Date.now()}x${i}`;
        await post(tenant, '/schemas/write', { schema: SCHEMA });
        await post(tenant, '/data/write', { metadata: { schema_version: '' }, tuples: FIXTURE, attributes: [priv('n1'), priv('n2')] });
        const before = await state(tenant);
        process.env.PERMIFY_API_URL = LIVE; process.env.PERMIFY_TENANT_ID = tenant; process.env.NODE_ENV = 'test';
        delete process.env.PERMIFY_API_TOKEN;
        delete require.cache[permifyPath];
        await act(require(permifyPath));
        const after = await state(tenant);
        assert.deepStrictEqual([...before].filter(k => !after.has(k)).sort(), removed.sort(), `${label}: removed`);
        assert.deepStrictEqual([...after].filter(k => !before.has(k)).sort(), added.sort(), `${label}: added`);
        console.log(`  ✓ ${label}: removed ${removed.length ? removed.join(', ') : 'nothing'}${added.length ? `; added ${added.join(', ')}` : ''}`);
        passed++;
    }
    console.log(`verify_permify_deletes_live: ${passed}/${cases.length} cases passed against ${LIVE}`);
})().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
