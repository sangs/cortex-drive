'use strict';
/**
 * "Remove person" (S2-50 build 2b; utils/remove_person.js) with fakes (no network):
 * - refused: yourself, protected accounts, malformed ids, someone not in your organization (404);
 * - member (E1): preview has no side effects; removal runs the scoped routine with you as receiver, then Clerk;
 * - collaborator (E3): only shares YOU gave and groups YOU created; a failed Permify revoke marks nothing revoked.
 * Run: node tests/verify_remove_person.js (npm test).
 */
const assert = require('assert');
const { createRemovePerson, RemoveError } = require('../utils/remove_person');
const { TRIGGERS } = require('../utils/offboarding');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
async function rejects(p, status, m) {
    try { await p; } catch (e) { eq([e instanceof RemoveError, e.status], [true, status], m); return; }
    assert.fail(`${m}: did not throw`);
}

const ME = 'user_adminAAAAAAAAAAAAAAAAAAAAAAAAA';
const BOB = 'user_bobBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const OWNER = 'user_ownerCCCCCCCCCCCCCCCCCCCCCCCCC';
const ORG = 'org_a';

function setup({ revokeFails = 0 } = {}) {
    const calls = { plan: [], apply: [], clerk: [], revoke: [], groups: [], sql: [], redis: [] };
    const plan = { userSub: BOB, orgId: ORG };
    const offboarding = {
        async plan(sub, opts) { calls.plan.push([sub, opts]); return plan; },
        countsOf() { return { owned_nodes: 2, access_tuples: 3 }; },
        isEmpty() { return false; },
        async apply(p, opts) { calls.apply.push([p, opts]); return { offboardingId: 'ob-1' }; },
    };
    const db = {
        async query(sql, args) {
            calls.sql.push([sql.replace(/\s+/g, ' ').trim().slice(0, 60), args]);
            if (/FROM role_assignments ra JOIN share_grants/.test(sql)) {
                return { rows: args[1] === ME ? [{ assignment_id: 'ra1', assignee_type: 'user', assignee_id: BOB, child_node_ids: ['n1', 'n2'] }] : [] };
            }
            if (/FROM group_members gm JOIN groups/.test(sql)) return { rows: args[1] === ME ? [{ group_id: 'g1' }] : [] };
            return { rows: [], rowCount: 1 };
        },
    };
    const rp = createRemovePerson({
        db, redis: { async del(k) { calls.redis.push(k); } }, offboarding,
        isProtected: sub => sub === OWNER,
        listOrgMembers: async org => (org === ORG ? [{ userId: ME, relation: 'admin' }, { userId: BOB, relation: 'member' }] : []),
        deleteClerkMembership: async (org, sub) => { calls.clerk.push([org, sub]); },
        revokeAudienceAccess: async (aud, nodes) => { calls.revoke.push([aud.map(a => a.assignee_id), nodes]); return revokeFails; },
        removeGroupMember: async (g, sub) => { calls.groups.push([g, sub]); },
        log: { log() {} },
    });
    return { rp, calls };
}

(async () => {
    let { rp, calls } = setup();
    await rejects(rp.previewMember(ME, ORG, ME), 400, 'cannot remove yourself');
    await rejects(rp.previewMember(ME, ORG, OWNER), 403, 'protected account');
    await rejects(rp.previewMember(ME, ORG, 'not-a-user'), 400, 'malformed id');
    await rejects(rp.previewMember(ME, 'org_other', BOB), 404, 'not a member of your organization');
    await rejects(rp.previewCollaborator(ME, ME), 400, 'collaborator: not yourself');

    // E1 preview → no changes
    eq(await rp.previewMember(ME, ORG, BOB), { kind: 'member', counts: { owned_nodes: 2, access_tuples: 3 }, contentTo: 'you' }, 'preview counts');
    eq(calls.plan, [[BOB, { orgId: ORG, receiver: ME }]], 'scoped to your org, you receive');
    eq([calls.apply.length, calls.clerk.length], [0, 0], 'preview changes nothing');
    // E1 remove
    const r = await rp.removeMember(ME, ORG, BOB);
    eq(r.offboardingId, 'ob-1', 'routine ran');
    eq(calls.apply[0][1], { trigger: TRIGGERS.REMOVE_PERSON, actor: ME }, 'recorded as remove_person by you');
    eq(calls.clerk, [[ORG, BOB]], 'then the Clerk membership is deleted');

    // E3
    ({ rp, calls } = setup());
    eq(await rp.previewCollaborator(ME, BOB), { kind: 'collaborator', counts: { shares: 1, groups: 1 } }, 'collaborator preview');
    eq([calls.revoke.length, calls.groups.length], [0, 0], 'preview changes nothing');
    eq((await rp.removeCollaborator(ME, BOB)).counts, { shares: 1, groups: 1 }, 'removed');
    eq(calls.revoke, [[[BOB], ['n1', 'n2']]], 'exact revoke on every node of your share');
    eq(calls.groups, [['g1', BOB]], 'out of your group');
    eq(calls.redis, [`perm:${BOB}`], 'their permission cache cleared');
    eq((await setup().rp.previewCollaborator('user_otherDDDDDDDDDDDDDDDDDDDDDDDDD', BOB)).counts, { shares: 0, groups: 0 }, 'someone else\'s shares are not yours to remove');

    ({ rp, calls } = setup({ revokeFails: 1 }));
    await rejects(rp.removeCollaborator(ME, BOB), 502, 'a failed revoke surfaces');
    eq(calls.sql.filter(([q]) => q.startsWith('UPDATE role_assignments')).length, 0, 'nothing marked revoked when Permify failed');

    console.log(`verify_remove_person: ${passed} checks passed`);
})().catch(err => { console.error('verify_remove_person FAILED:', err.message); process.exit(1); });
