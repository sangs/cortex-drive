'use strict';

/**
 * S2-42 / S2-43 / S2-39 / S2-40 (2026-10-23). Run: `node tests/verify_share_security.js` or `npm test`.
 *   1. identity: only the owner's own Clerk ids map to OWNER_USER_ID (every signed-in user used to)
 *   2. share_authz: node / grant / group ownership checks, failing closed
 *   3. Permify delete requests: exact single-tuple filters (`ids` lists); unscoped deletes refused.
 *      A local recording server stands in for Permify. The same shapes were proven against the real
 *      Permify image by tests/integration/verify_permify_deletes_live.js.
 *   4. index.js wiring: every share/group route carries an ownership check; no swallowed revokes.
 * No network, Permify, database or Neo4j needed.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); passed++; };

// ── 1. identity ────────────────────────────────────────────────────────────────────────────────
const { resolveUserId, isOwner, ownerClerkSubs } = require('../utils/identity');
const ENV = { OWNER_USER_ID: 'user_PROD_OWNER', OWNER_CLERK_SUBS: 'user_DEV_OWNER, user_OTHER_OWNED' };
eq(resolveUserId('user_PROD_OWNER', ENV), 'user_PROD_OWNER', 'production owner keeps the owner id');
eq(resolveUserId('user_DEV_OWNER', ENV), 'user_PROD_OWNER', 'listed dev account maps to the owner');
eq(resolveUserId('user_OTHER_OWNED', ENV), 'user_PROD_OWNER', 'every listed id maps to the owner');
eq(resolveUserId('user_INVITEE', ENV), 'user_INVITEE', 'an invited user keeps their own id (S2-42)');
eq(resolveUserId('', ENV), '', 'no subject → empty id, never the owner');
eq(resolveUserId(undefined, ENV), '', 'undefined subject → empty id');
eq(resolveUserId('user_INVITEE', {}), 'user_INVITEE', 'no owner configured → own id');
eq(resolveUserId('user_X', { OWNER_CLERK_SUBS: 'user_X' }), 'user_X', 'list without OWNER_USER_ID maps nothing');
ok(isOwner('user_PROD_OWNER', ENV) && !isOwner('user_INVITEE', ENV) && !isOwner('', {}), 'isOwner');
eq([...ownerClerkSubs(ENV)].sort(), ['user_DEV_OWNER', 'user_OTHER_OWNED', 'user_PROD_OWNER'], 'owner id set');
eq([...ownerClerkSubs({ OWNER_USER_ID: 'user_P', OWNER_CLERK_SUBS: 'user_A;user_B' })].sort(), ['user_A', 'user_B', 'user_P'], '`;` separator (Cloud Run-safe)');

// ── 2. share_authz ─────────────────────────────────────────────────────────────────────────────
const { createShareAuthz, MAX_NODES_PER_CHECK } = require('../utils/share_authz');
const quietLog = { error() {}, warn() {} };

function fakePermify({ owned = [], configured = true, fail = false } = {}) {
    return {
        configured: () => configured,
        checkPermission: async (nodeId, userId, perm) => {
            if (fail) throw new Error('permify down');
            return perm === 'can_share' && userId === 'owner' && owned.includes(nodeId);
        },
    };
}
function fakeDb(rowsBySql) {
    return { query: async (sql, params) => ({ rows: rowsBySql(sql, params) }) };
}
function run(mw, req) {
    return new Promise(resolve => {
        const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b, next: false }); } };
        mw({ method: 'POST', path: '/x', params: {}, body: {}, query: {}, ...req, headers: { 'x-tenant-id': 'org_1', ...(req.headers || {}) } },
           res, () => resolve({ status: 200, next: true }));
    });
}

(async () => {
    const noDb = fakeDb(() => []);
    const authz = createShareAuthz({ db: noDb, permify: fakePermify({ owned: ['n1', 'n2'] }), log: quietLog });
    const nodeMw = authz.requireNodeShare(req => req.body.node_id);
    eq((await run(nodeMw, { body: { node_id: 'n1' }, headers: { 'x-user-id': 'owner' } })).next, true, 'owner may share own node');
    eq((await run(nodeMw, { body: { node_id: 'n1' }, headers: { 'x-user-id': 'invitee' } })).status, 403, 'non-owner refused (S2-43)');
    eq((await run(nodeMw, { body: { node_id: 'n9' }, headers: { 'x-user-id': 'owner' } })).status, 403, 'node not owned refused');
    eq((await run(nodeMw, { body: {}, headers: { 'x-user-id': 'owner' } })).status, 400, 'missing node id → 400');

    const islandMw = authz.requireNodeShare(req => req.body.nodeIds || []);
    eq((await run(islandMw, { body: { nodeIds: ['n1', 'n2'] }, headers: { 'x-user-id': 'owner' } })).next, true, 'all nodes owned → allowed');
    eq((await run(islandMw, { body: { nodeIds: ['n1', 'n9'] }, headers: { 'x-user-id': 'owner' } })).status, 403, 'one foreign node in a set → refused');
    eq((await run(islandMw, { body: { nodeIds: [] }, headers: { 'x-user-id': 'owner' } })).status, 400, 'empty set → 400');
    const many = Array.from({ length: MAX_NODES_PER_CHECK + 1 }, (_, i) => `n${i}`);
    eq((await run(islandMw, { body: { nodeIds: many }, headers: { 'x-user-id': 'owner' } })).status, 400, 'over the per-request cap → 400');

    const unconfigured = createShareAuthz({ db: noDb, permify: fakePermify({ configured: false }), log: quietLog });
    eq((await run(unconfigured.requireNodeShare(r => r.body.node_id), { body: { node_id: 'n1' }, headers: { 'x-user-id': 'owner' } })).status, 503, 'Permify unconfigured → fail closed');
    const failing = createShareAuthz({ db: noDb, permify: fakePermify({ fail: true }), log: quietLog });
    eq((await run(failing.requireNodeShare(r => r.body.node_id), { body: { node_id: 'n1' }, headers: { 'x-user-id': 'owner' } })).status, 503, 'Permify error → fail closed');

    // Owner fallback: nodes of the owner's own tenant pass without a Permify owner tuple (S2-41);
    // found in production 2026-10-23 (owner got 403 on their own nodes). Non-owners never use it.
    const tenantNodes = { org_1: ['t1', 't2'] };
    let tenantCalls = 0;
    const ownerAuthz = createShareAuthz({ db: noDb, permify: fakePermify({ owned: ['n1'] }), log: quietLog,
        isOwner: u => u === 'owner',
        nodesInTenant: async (ids, tenant) => { tenantCalls++; return { own: ids.filter(id => (tenantNodes[tenant] || []).includes(id)), everyone: ids.filter(id => id.startsWith('pub')) }; } });
    const ownerNode = ownerAuthz.requireNodeShare(req => req.body.nodeIds);
    eq((await run(ownerNode, { body: { nodeIds: ['t1'] }, headers: { 'x-user-id': 'owner' } })).next, true, 'owner: own-tenant node without owner tuple → allowed');
    eq((await run(ownerNode, { body: { nodeIds: ['t1', 'n1'] }, headers: { 'x-user-id': 'owner' } })).next, true, 'owner: tenant node + Permify-owned node → allowed');
    eq((await run(ownerNode, { body: { nodeIds: ['t1', 'x9'] }, headers: { 'x-user-id': 'owner' } })).status, 403, 'owner: a node outside the tenant and not owned → refused');
    eq((await run(ownerNode, { body: { nodeIds: ['t1'] }, headers: { 'x-user-id': 'owner', 'x-tenant-id': 'org_other' } })).status, 403, 'owner: tenant fallback is per tenant');
    const pub = await run(ownerNode, { body: { nodeIds: ['pub1'] }, headers: { 'x-user-id': 'owner' } });
    eq([pub.status, pub.body.everyone_visible], [409, true], 'owner: PUBLIC/SYSTEM node → 409 already visible to everyone (S2-44)');
    eq((await run(ownerNode, { body: { nodeIds: ['t1', 'pub1'] }, headers: { 'x-user-id': 'owner' } })).status, 409, 'owner: a set containing a PUBLIC node → 409');
    const callsBefore = tenantCalls;
    eq((await run(ownerNode, { body: { nodeIds: ['t1'] }, headers: { 'x-user-id': 'invitee' } })).status, 403, 'non-owner: tenant fallback never applies');
    eq(tenantCalls, callsBefore, 'non-owner: tenant lookup not even called');
    const brokenLookup = createShareAuthz({ db: noDb, permify: fakePermify({ owned: [] }), log: quietLog, isOwner: () => true,
        nodesInTenant: async () => { throw new Error('bento down'); } });
    eq((await run(brokenLookup.requireNodeShare(r => r.body.node_id), { body: { node_id: 't1' }, headers: { 'x-user-id': 'owner' } })).status, 403, 'tenant lookup error → Permify alone decides (fail closed)');

    const grantDb = fakeDb((sql, [id]) => sql.includes('share_grants')
        ? ({ g_mine: [{ issued_by: 'issuer', root_node_id: 'n9' }], g_root: [{ issued_by: 'someone', root_node_id: 'n1' }] }[id] || []) : []);
    const ga = createShareAuthz({ db: grantDb, permify: fakePermify({ owned: ['n1'] }), log: quietLog }).requireGrantIssuer();
    eq((await run(ga, { params: { grant_id: 'g_mine' }, headers: { 'x-user-id': 'issuer' } })).next, true, 'grant issuer allowed');
    eq((await run(ga, { params: { grant_id: 'g_root' }, headers: { 'x-user-id': 'owner' } })).next, true, 'owner of the grant root allowed');
    eq((await run(ga, { params: { grant_id: 'g_mine' }, headers: { 'x-user-id': 'invitee' } })).status, 403, 'other user refused on a grant');
    eq((await run(ga, { params: { grant_id: 'g_none' }, headers: { 'x-user-id': 'issuer' } })).status, 404, 'unknown grant → 404');

    const groupDb = fakeDb((sql, [id, org]) => sql.includes('FROM groups') && id === 'grp1' && org === 'org_1' ? [{ created_by: 'creator' }] : []);
    const gc = createShareAuthz({ db: groupDb, permify: fakePermify(), log: quietLog }).requireGroupCreator();
    eq((await run(gc, { params: { id: 'grp1' }, headers: { 'x-user-id': 'creator' } })).next, true, 'group creator allowed');
    eq((await run(gc, { params: { id: 'grp1' }, headers: { 'x-user-id': 'member' } })).status, 403, 'non-creator refused');
    eq((await run(gc, { params: { id: 'grp1' }, headers: { 'x-user-id': 'creator', 'x-tenant-id': 'org_other' } })).status, 404, 'group in another org → 404');

    // ── 3. Permify request shapes ──────────────────────────────────────────────────────────────
    process.env.PERMIFY_TENANT_ID = 'cortex-drive';
    delete process.env.PERMIFY_API_TOKEN;
    process.env.NODE_ENV = 'test';
    const sent = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => { sent.push({ url: req.url, body: JSON.parse(raw || '{}') }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    process.env.PERMIFY_API_URL = `http://127.0.0.1:${server.address().port}`;
    const permify = require('../utils/permify_gateway.js');
    const base = '/v1/tenants/cortex-drive';

    eq(permify.audienceSubject('user', 'user_abc'), { type: 'user', id: 'user_abc' }, 'user audience subject (bare Clerk id)');
    eq(permify.audienceSubject('group', 'g1'), { type: 'group', id: 'g1', relation: 'member' }, 'group audience subject');

    await permify.revokeNodeAccess('n1', permify.audienceSubject('user', 'user_abc'), 'shared_viewer');
    eq(sent.pop(), { url: `${base}/relationships/delete`, body: { filter: {
        entity: { type: 'node', ids: ['n1'] }, relation: 'shared_viewer', subject: { type: 'user', ids: ['user_abc'] } } } }, 'user revoke: exact filter');
    await permify.revokeNodeAccess('n1', permify.audienceSubject('group', 'g1'));
    eq(sent.pop().body.filter.subject, { type: 'group', ids: ['g1'], relation: 'member' }, 'group revoke keeps #member');
    await permify.removeNodeTenantWide('n1', 'org_1');
    eq(sent.pop().body, { filter: { entity: { type: 'node', ids: ['n1'] }, relation: 'tenant_viewer',
        subject: { type: 'org', ids: ['org_1'], relation: 'member' } } }, 'tenant-wide off: exact filter (S2-40)');
    await permify.removeGroupMember('g1', 'user_abc');
    eq(sent.pop().body, { filter: { entity: { type: 'group', ids: ['g1'] }, relation: 'member',
        subject: { type: 'user', ids: ['user_abc'] } } }, 'group member removal: one member only');
    await permify.writePrivacyAttribute('n1', false);
    eq(sent.pop(), { url: `${base}/data/delete`, body: { tuple_filter: {},
        attribute_filter: { entity: { type: 'node', ids: ['n1'] }, attributes: ['is_private'] } } }, 'privacy off: exact attribute filter');

    for (const [label, call] of [
        ['missing node id', () => permify.revokeNodeAccess('', { type: 'user', id: 'u' })],
        ['missing subject id', () => permify.revokeNodeAccess('n1', { type: 'user', id: '' })],
        ['missing subject', () => permify.revokeNodeAccess('n1', undefined)],
        ['missing org', () => permify.removeNodeTenantWide('n1', '')],
        ['missing member', () => permify.removeGroupMember('g1', '')],
        ['privacy off without node', () => permify.writePrivacyAttribute('', false)],
    ]) {
        await assert.rejects(call, /unscoped/, label); passed++;
    }
    eq(sent.length, 0, 'refused deletes never reach Permify');
    server.close();

    // ── 4. index.js wiring ─────────────────────────────────────────────────────────────────────
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    ok(!/process\.env\.OWNER_USER_ID\s*\|\|\s*decoded\.sub/.test(src), 'no unconditional owner mapping (S2-42)');
    // resolvePrincipal → resolveUserId since 2026-10-28 (S2-48); covered in verify_user_types.js.
    ok(src.includes("req.headers['x-user-id'] = principal.userId"), 'authMiddleware takes the user id from resolvePrincipal (resolveUserId)');
    ok(!/revokeNodeAccess\([^;]*\.catch\(\(\)\s*=>\s*\{\s*\}\)/.test(src), 'no swallowed revoke (S2-39)');
    ok(!/`group:\$\{[^`]*\}#member`/.test(src), 'no string-built audience subjects left');
    const routeRe = /app\.(get|post|put|patch|delete)\('(\/api\/(?:share|groups)[^']*)',([^\n]*)/g;
    const exempt = new Map([
        ['post /api/groups', 'creates a group owned by the caller'],
        ['get /api/groups', 'lists groups of the caller\'s org'],
        ['get /api/groups/:id', 'org-scoped read of one group'],
        ['get /api/share/graph-link/:token', 'public guest-link resolution by token'],
        ['get /api/share/graph-links', 'filtered by owner_sub = caller'],
        ['delete /api/share/graph-link/:linkId', 'filtered by owner_sub = caller in SQL'],
        ['get /api/share/grants', 'filtered by issued_by = caller'],
        ['get /api/share/pending', 'filtered by issued_by = caller'],
        ['get /api/share/preview', 'guest-token route'],
    ]);
    const unchecked = [];
    let m; let routes = 0;
    while ((m = routeRe.exec(src))) {
        const key = `${m[1]} ${m[2]}`;
        routes++;
        if (exempt.has(key)) continue;
        if (!/shareAuthz\.(requireNodeShare|requireGrantIssuer|requireGroupCreator)\(/.test(m[3])) unchecked.push(key);
    }
    ok(routes >= 25, `found the share/group routes (${routes})`);
    eq(unchecked, [], 'every share/group route has an ownership check or a documented exemption (S2-43)');
    ok(/app\.delete\('\/api\/share\/tenant-wide', authMiddleware, requireCapability\('shareOrgWide'[^)]*\), shareAuthz\.requireNodeShare/.test(src), 'tenant-wide off route exists, admin-only and node-owner-only (S2-40, S2-69)');
    ok(/app\.post\('\/api\/register_website_source', authMiddleware, requireSourceWriter/.test(src), 'website registration is owner-only');
    ok(/app\.post\('\/api\/register_document_source', authMiddleware, requireSourceWriter/.test(src), 'document registration is owner-only');
    // S2-47: nobody is added to the organization automatically (not by the Clerk webhook, not by
    // "share by email"); membership comes only from an explicit Clerk invitation by an admin.
    ok(!/createOrganizationMembership/.test(src), 'no automatic Clerk organization membership (S2-47)');

    console.log(`verify_share_security: ${passed} checks passed`);
})().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
