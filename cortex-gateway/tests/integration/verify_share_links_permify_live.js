'use strict';
/**
 * Unified shares phase 1 (2026-10-29): share links against a REAL Permify (the pinned image), using
 * the gateway's own functions. Checks: a link subject sees its root and everything under it (parent
 * inheritance) and nothing else; is_private still blocks; revoking one link removes exactly its tuple;
 * users' lookups are unchanged by link tuples. Never point this at production (throwaway tenants).
 *
 *   docker run -d --name permify-probe --platform linux/amd64 -p 13476:3476 \
 *     <the image pinned in scripts/build-deploy-permify.sh> serve --database-engine=memory
 *   PERMIFY_LIVE_URL=http://localhost:13476 node tests/integration/verify_share_links_permify_live.js
 *
 * Skips (exit 0) when PERMIFY_LIVE_URL is not set.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const LIVE = process.env.PERMIFY_LIVE_URL;
if (!LIVE) { console.log('verify_share_links_permify_live: skipped (PERMIFY_LIVE_URL not set)'); process.exit(0); }
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(LIVE)) {
    console.error('PERMIFY_LIVE_URL must be a local Permify (http://localhost:<port>)'); process.exit(1);
}
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'scripts', 'permify', 'authorization_schema.perm'), 'utf8');
const tup = (et, eid, rel, st, sid, srel) => ({ entity: { type: et, id: eid }, relation: rel, subject: { type: st, id: sid, ...(srel ? { relation: srel } : {}) } });
async function post(tenant, p, body) {
    const r = await fetch(`${LIVE}/v1/tenants/${tenant}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p} → ${r.status} ${JSON.stringify(j)}`);
    return j;
}

// root ─ child ─ grandchild ; root ─ secret (is_private) ; other (unrelated) ; alice owns root
const FIXTURE = [
    tup('node', 'child', 'parent', 'node', 'root'), tup('node', 'grandchild', 'parent', 'node', 'child'),
    tup('node', 'secret', 'parent', 'node', 'root'), tup('node', 'root', 'owner', 'user', 'alice'),
    tup('node', 'other', 'shared_viewer', 'user', 'bob'),
];
const priv = id => ({ entity: { type: 'node', id }, attribute: 'is_private', value: { '@type': 'type.googleapis.com/base.v1.BooleanValue', data: true } });

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); console.log(`  ✓ ${m}`); passed++; };

(async () => {
    const tenant = `links${Date.now()}`;
    await post(tenant, '/schemas/write', { schema: SCHEMA });
    await post(tenant, '/data/write', { metadata: { schema_version: '' }, tuples: FIXTURE, attributes: [priv('secret')] });
    process.env.PERMIFY_API_URL = LIVE; process.env.PERMIFY_TENANT_ID = tenant; process.env.NODE_ENV = 'test';
    delete process.env.PERMIFY_API_TOKEN;
    const p = require('../../utils/permify_gateway.js');

    eq((await p.listViewableNodeIds('share_link:L1')).sort(), [], 'a new link sees nothing');
    await p.shareNodeWithLink('root', 'L1');
    await p.shareNodeWithLink('root', 'L2');
    eq((await p.listViewableNodeIds('share_link:L1')).sort(), ['child', 'grandchild', 'root'],
       'link sees its root and everything under it; not the private node, not unrelated nodes');
    eq(await p.checkPermission('root', 'share_link:L1'), true, 'point check on the root (deep can_view point checks exceed depth 5; production uses lookups for can_view)');
    eq(await p.checkPermission('other', 'share_link:L1'), false, 'unrelated node refused');
    eq(await p.checkPermission('root', 'share_link:L1', 'can_share'), false, 'a link can never share (can_share = owner)');
    eq((await p.listViewableNodeIds('bob')).sort(), ['other'], "a user's lookup is unchanged by link tuples");
    eq((await p.listViewableNodeIds('L1')).sort(), [], 'a user id equal to the link id gets nothing (subjects are typed)');

    await p.revokeNodeLink('root', 'L1');
    eq((await p.listViewableNodeIds('share_link:L1')).sort(), [], 'revoked link sees nothing');
    eq((await p.listViewableNodeIds('share_link:L2')).sort(), ['child', 'grandchild', 'root'], 'the other link is untouched (exact delete)');

    console.log(`verify_share_links_permify_live: ${passed} checks passed against ${LIVE}`);
})().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
