'use strict';

/**
 * User types, tenant resolution and Clerk → Permify membership sync (S2-46 / S2-48, 2026-10-28).
 * Run: `node tests/verify_user_types.js` or `npm test`. No network, Clerk, Permify or Redis needed.
 *   1. resolvePrincipal: owner (incl. alias accounts), org admin, org member, collaborator
 *   2. routing tenant for collaborators; owner routing skips other users' sources
 *   3. membership sync: webhook payload parsing, apply/remove, reconcile diff (fake Permify)
 *   4. index.js wiring: x-user-type is gateway-assigned; source writers by type; webhook events
 * Spec: documents/security/user-roles-and-access-model.md.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); passed++; };

const { resolvePrincipal, routingTenantFor, USER_TYPES } = require('../utils/identity');
const ENV = { OWNER_USER_ID: 'user_OWNER', OWNER_CLERK_SUBS: 'user_OWNER_ALIAS', TENANT_ID: 'org_PLATFORM' };

// ── 1. resolvePrincipal ────────────────────────────────────────────────────────────────────────
{
    const owner = resolvePrincipal({ clerkSub: 'user_OWNER', jwtOrgId: 'org_OTHER', jwtOrgRole: 'org:admin' }, ENV);
    eq([owner.type, owner.tenantId, owner.userId], [USER_TYPES.OWNER, 'org_PLATFORM', 'user_OWNER'], 'owner → TENANT_ID whatever the active org');
    const alias = resolvePrincipal({ clerkSub: 'user_OWNER_ALIAS', memberships: [{ orgId: 'org_PLATFORM', role: 'org:admin' }] }, ENV);
    eq([alias.type, alias.userId, alias.rawUserId], [USER_TYPES.OWNER, 'user_OWNER', 'user_OWNER_ALIAS'], 'owner alias maps to the owner');
    ok(alias.isOrgAdmin, 'owner as org admin gets admin gates');

    const member = resolvePrincipal({ clerkSub: 'user_M', memberships: [{ orgId: 'org_PLATFORM', role: 'org:member' }] }, ENV);
    eq([member.type, member.tenantId, member.isOrgAdmin], [USER_TYPES.ORG_MEMBER, 'org_PLATFORM', false], 'member → their org (Clerk lookup)');
    const memberJwt = resolvePrincipal({ clerkSub: 'user_M', jwtOrgId: 'org_B', jwtOrgRole: 'org:member' }, ENV);
    eq([memberJwt.type, memberJwt.tenantId], [USER_TYPES.ORG_MEMBER, 'org_B'], 'member → the JWT active org');
    const multi = resolvePrincipal({ clerkSub: 'user_M', jwtOrgId: 'org_B',
        memberships: [{ orgId: 'org_A', role: 'org:admin' }, { orgId: 'org_B', role: 'org:member' }] }, ENV);
    eq([multi.type, multi.tenantId], [USER_TYPES.ORG_MEMBER, 'org_B'], 'several orgs: the active one, with its own role');

    const admin = resolvePrincipal({ clerkSub: 'user_A', memberships: [{ orgId: 'org_PLATFORM', role: 'org:admin' }] }, ENV);
    eq([admin.type, admin.isOrgAdmin], [USER_TYPES.ORG_ADMIN, true], 'org admin');

    const collab = resolvePrincipal({ clerkSub: 'user_C', memberships: [] }, ENV);
    eq([collab.type, collab.tenantId, collab.userId], [USER_TYPES.COLLABORATOR, 'personal:user_C', 'user_C'], 'no membership → collaborator, personal scope');
    ok(collab.tenantId !== ENV.TENANT_ID, 'a collaborator is never placed in the owner tenant (S2-48)');
    const noOwnerEnv = resolvePrincipal({ clerkSub: 'user_OWNER' }, {});
    eq(noOwnerEnv.type, USER_TYPES.COLLABORATOR, 'no owner configured → nobody is the owner');
}

// ── 2. routing ────────────────────────────────────────────────────────────────────────────────
{
    eq(routingTenantFor(USER_TYPES.COLLABORATOR, 'personal:user_C', ENV), 'org_PLATFORM', 'collaborator routes with the platform catalog (filtered)');
    eq(routingTenantFor(USER_TYPES.ORG_MEMBER, 'org_B', ENV), 'org_B', 'member routes with their own org catalog');
    const { buildRoutingLookups } = require('../utils/intent_classifier');
    const catalog = { entries: [
        { name: 'Owner Paper', domain: 'document', node_id: 'n1', tier: 'org' },
        { name: 'Member Private Paper', domain: 'document', node_id: 'n2', tier: 'org', owner_id: 'user_M' },
        { name: 'Member Shared Paper', domain: 'document', node_id: 'n3', tier: 'org', owner_id: 'user_M' },
    ] };
    const owner = buildRoutingLookups(catalog, { isOwner: true, allowedIds: ['n3'], userId: 'user_OWNER' });
    ok(owner.entity.has('owner paper'), 'owner routes by their own titles');
    ok(!owner.entity.has('member private paper'), "owner never routes by a member's Private title");
    ok(owner.entity.has('member shared paper'), 'owner routes by a member title shared with them');
    const member = buildRoutingLookups(catalog, { isOwner: false, allowedIds: ['n2'], userId: 'user_M' });
    ok(member.entity.has('member private paper') && !member.entity.has('owner paper'), 'member routes by what they can open');
}

// ── 3. membership sync ─────────────────────────────────────────────────────────────────────────
const { membershipFromClerkEvent, diffMembership, createOrgMembershipSync } = require('../utils/org_membership_sync');
{
    const evt = { organization: { id: 'org_PLATFORM' }, public_user_data: { user_id: 'user_OWNER_ALIAS' }, role: 'org:admin' };
    eq(membershipFromClerkEvent(evt, ENV), { orgId: 'org_PLATFORM', userId: 'user_OWNER', clerkSub: 'user_OWNER_ALIAS', role: 'org:admin' }, 'webhook payload parsed; alias → owner id');
    eq(membershipFromClerkEvent({ role: 'org:member' }, ENV), null, 'payload without org/user is rejected');

    const diff = diffMembership(
        [{ clerkSub: 'user_OWNER', role: 'org:admin' }, { clerkSub: 'user_OWNER_ALIAS', role: 'org:admin' }, { clerkSub: 'user_M', role: 'org:member' }],
        [{ relation: 'member', userId: 'user_OWNER' }, { relation: 'member', userId: 'user_GONE' }, { relation: 'admin', userId: 'user_M' }],
        ENV);
    eq(diff.toWrite, [{ relation: 'admin', userId: 'user_OWNER' }, { relation: 'member', userId: 'user_M' }], 'missing tuples added (aliases collapse)');
    eq(diff.toDelete, [{ relation: 'member', userId: 'user_GONE' }, { relation: 'admin', userId: 'user_M' }], 'stale tuples removed (left org; demoted admin)');
}

(async () => {
    const calls = [];
    const fakePermify = {
        writeOrgRelation: async (o, r, u) => calls.push(['write', o, r, u]),
        deleteOrgRelation: async (o, r, u) => calls.push(['delete', o, r, u]),
        listOrgRelations: async () => [{ relation: 'member', userId: 'user_GONE' }],
    };
    const cleared = [];
    const sync = createOrgMembershipSync({ permify: fakePermify, clearUserCaches: async (u, s) => cleared.push([u, s]), log: { log() {} } });

    await sync.applyMembership({ orgId: 'org_P', userId: 'user_M', clerkSub: 'user_M', role: 'org:member' });
    eq(calls, [['write', 'org_P', 'member', 'user_M'], ['delete', 'org_P', 'admin', 'user_M']], 'member: write member, drop any admin');
    calls.length = 0;
    await sync.applyMembership({ orgId: 'org_P', userId: 'user_A', clerkSub: 'user_A', role: 'org:admin' });
    eq(calls, [['write', 'org_P', 'member', 'user_A'], ['write', 'org_P', 'admin', 'user_A']], 'admin: member + admin');
    calls.length = 0;
    await sync.removeMembership({ orgId: 'org_P', userId: 'user_M', clerkSub: 'user_M' });
    eq(calls, [['delete', 'org_P', 'admin', 'user_M'], ['delete', 'org_P', 'member', 'user_M']], 'removal deletes both');
    eq(cleared.map(c => c[0]), ['user_M', 'user_A', 'user_M'], "each change clears that user's caches");

    calls.length = 0;
    const dry = await sync.reconcile({ orgId: 'org_P', clerkMembers: [{ clerkSub: 'user_M', role: 'org:member' }], env: ENV });
    eq(calls, [], 'reconcile dry run changes nothing');
    eq([dry.toWrite.length, dry.toDelete.length], [1, 1], 'reconcile reports both directions');
    await sync.reconcile({ orgId: 'org_P', clerkMembers: [{ clerkSub: 'user_M', role: 'org:member' }], apply: true, env: ENV });
    eq(calls, [['write', 'org_P', 'member', 'user_M'], ['delete', 'org_P', 'member', 'user_GONE']], 'reconcile --apply fixes Permify');

    let threw = false;
    try { require('../utils/permify_gateway').exactTupleFilter('org', 'org_P', 'member', { type: 'user', id: '' }); } catch { threw = true; }
    ok(threw, 'org deletes use the exact filter (refuses an unscoped delete, AP-28)');

    // ── 4. index.js wiring ─────────────────────────────────────────────────────────────────────
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    ok(/GATEWAY_ASSIGNED_HEADERS = \[[^\]]*'x-user-type'/.test(src), 'x-user-type is gateway-assigned (AP-23)');
    ok(/SOURCE_WRITER_USER_TYPES = new Set\(\[USER_TYPES\.OWNER, USER_TYPES\.ORG_ADMIN, USER_TYPES\.ORG_MEMBER\]\)/.test(src), 'source writers: owner, org admin, org member');
    ok(!/process\.env\.TENANT_ID \|\| decoded\.org_id/.test(src), 'TENANT_ID no longer applies to every signed-in user (S2-48)');
    ok(/organizationMembership\./.test(src) && /orgMembershipSync\.removeMembership/.test(src), 'webhook handles organizationMembership events');
    ok(/"x-user-type": reqHeaders\['x-user-type'\]/.test(src), 'MCP calls carry the user type');
    ok(/req\.headers\['x-user-type'\] = USER_TYPES\.GUEST/.test(src), 'guest links are typed guest');
    ok(!/createOrganizationMembership/.test(src), 'still no automatic Clerk organization membership (S2-47)');

    console.log(`verify_user_types: ${passed} checks passed`);
})().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
