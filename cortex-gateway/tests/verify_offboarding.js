'use strict';
/**
 * S2-50: offboarding a person whose Clerk account is gone (utils/offboarding.js, scripts/reconcile_offboarding.js,
 * the user.deleted webhook). Design: documents/security/offboarding-and-retention-design-2026-11-20.md.
 * No network: Permify, Cloud SQL, Redis and Bento are in-memory fakes. Run: node tests/verify_offboarding.js (npm test).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const o = require('../utils/offboarding');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };

const OWNER = 'user_ownerAAAAAAAAAAAAAAAAAAAAAAAAA';
const ALIAS = 'user_ownerAliasBBBBBBBBBBBBBBBBBBBBB';
const GONE = 'user_goneCCCCCCCCCCCCCCCCCCCCCCCCCC';
const PLATFORM_ORG = 'org_platform';
const OTHER_ORG = 'org_customer';
const ENV = { OWNER_USER_ID: OWNER, OWNER_CLERK_SUBS: ALIAS, TENANT_ID: PLATFORM_ORG, PUBLIC_TRIAL_USER_ID: 'user_trialDDDDDDDDDDDDDDDDDDDDDDDDD' };

// ── Pure helpers ─────────────────────────────────────────────────────────────────────────────
eq(o.personFromClerkUser({ id: 'u1', first_name: 'Ada', last_name: 'L', primary_email_address_id: 'e2',
                           email_addresses: [{ id: 'e1', email_address: 'x@a' }, { id: 'e2', email_address: 'y@a' }] }),
   { userSub: 'u1', displayName: 'Ada L', email: 'y@a' }, 'webhook (snake_case) user');
eq(o.personFromClerkUser({ id: 'u2', firstName: '', lastName: null, primaryEmailAddressId: 'e1', emailAddresses: [{ id: 'e1', emailAddress: 'z@a' }] }),
   { userSub: 'u2', displayName: null, email: 'z@a' }, 'SDK (camelCase) user without a name');
eq(o.personFromClerkUser(null), null, 'no user');

ok(o.isProtected(OWNER, ENV) && o.isProtected(ALIAS, ENV), 'owner and owner aliases are never offboarded');
ok(o.isProtected(ENV.PUBLIC_TRIAL_USER_ID, ENV), 'trial identity is never offboarded');
ok(o.isProtected('share_link:abc', ENV) && o.isProtected('guest-auth', ENV) && o.isProtected('', ENV), 'non-Clerk ids are never offboarded');
ok(!o.isProtected(GONE, ENV), 'a normal Clerk id can be offboarded');

eq(o.stewardFor(PLATFORM_ORG, ENV), OWNER, 'platform organization → platform owner');
eq(o.stewardFor(OTHER_ORG, ENV), null, 'no steward configured → none (content waits)');
eq(o.stewardFor('_comment', ENV), null, 'config comment key is not an organization');
eq(o.transferLabel(o.formerOwnerName('Ada L', GONE)), 'Transferred from Ada L', 'label with a name');
ok(o.transferLabel(o.formerOwnerName(null, GONE)).startsWith('Transferred from a former user (user_goneCCC'), 'label without a name');

// ── Fakes ────────────────────────────────────────────────────────────────────────────────────
function world() {
    const s = {
        tuples: [  // Permify tuples naming GONE
            { entityType: 'org', entityId: PLATFORM_ORG, relation: 'member' },
            { entityType: 'group', entityId: 'g1', relation: 'member' },
            { entityType: 'node', entityId: 'shared-to-them', relation: 'shared_viewer' },
            { entityType: 'node', entityId: 'n-plat-1', relation: 'owner' },
            { entityType: 'node', entityId: 'n-vanished', relation: 'owner' },
        ],
        ownerWrites: [],
        nodes: [  // Neo4j: nodes GONE owns
            { node_id: 'n-plat-1', tenant_id: PLATFORM_ORG }, { node_id: 'n-plat-2', tenant_id: PLATFORM_ORG },
            { node_id: 'n-cust-1', tenant_id: OTHER_ORG },
        ],
        sql: {
            people_directory: [{ user_sub: GONE, display_name: 'Ada L', email: 'ada@x' }],
            role_assignments: [{ assignment_id: 'ra1', assignee_type: 'user', assignee_id: GONE, status: 'active' }],
            group_members: [{ group_id: 'g1', user_sub: GONE }],
            invitations: [{ invitation_id: 'i-sent', invited_by: GONE, status: 'pending', invited_email: 'p@q' },
                          { invitation_id: 'i-to', invited_by: OWNER, status: 'pending', invited_email: 'ADA@x' }],
            share_links: [{ link_id: 'l1', owner_sub: GONE, revoked_at: null }],
            share_grants: [{ grant_id: 'gr1', root_node_id: 'n-plat-1', issued_by: GONE, status: 'active' },
                           { grant_id: 'gr2', root_node_id: 'n-cust-1', issued_by: GONE, status: 'active' }],
            groups: [{ group_id: 'g2', org_id: PLATFORM_ORG, created_by: GONE }],
            conversations: [{ conversation_id: 'c-personal', user_sub: GONE, org_id: `personal:${GONE}`, status: 'active' },
                            { conversation_id: 'c-org', user_sub: GONE, org_id: PLATFORM_ORG, status: 'active' }],
            offboarding_log: [], content_transfers: [],
        },
        redisDel: [], redisIncr: [], linksRevoked: [], calls: [],
    };
    const T = s.sql;
    const db = { async query(text, args = []) {
        const sql = text.replace(/\s+/g, ' ').trim();
        s.calls.push(sql.slice(0, 40));
        const rows = r => ({ rows: r });
        if (sql.startsWith('SELECT display_name, email FROM people_directory')) return rows(T.people_directory.filter(r => r.user_sub === args[0]));
        if (sql.startsWith('SELECT DISTINCT lower(e) AS email')) {
            const e = T.people_directory.filter(r => r.user_sub === args[0]).map(r => r.email.toLowerCase());
            return rows([...new Set(e)].map(email => ({ email })));
        }
        if (sql.startsWith('SELECT assignment_id FROM role_assignments')) return rows(T.role_assignments.filter(r => r.assignee_id === args[0] && r.status === 'active'));
        if (sql.startsWith('SELECT group_id FROM group_members')) return rows(T.group_members.filter(r => r.user_sub === args[0]));
        if (sql.startsWith('SELECT invitation_id FROM invitations WHERE invited_by')) return rows(T.invitations.filter(r => r.invited_by === args[0] && r.status === 'pending'));
        if (sql.startsWith('SELECT invitation_id FROM invitations WHERE lower')) return rows(T.invitations.filter(r => args[0].includes(r.invited_email.toLowerCase()) && r.status === 'pending'));
        if (sql.startsWith('SELECT link_id FROM share_links')) return rows(T.share_links.filter(r => r.owner_sub === args[0] && !r.revoked_at));
        if (sql.startsWith('SELECT grant_id, root_node_id FROM share_grants')) return rows(T.share_grants.filter(r => r.issued_by === args[0] && r.status === 'active'));
        if (sql.startsWith('SELECT group_id, org_id FROM groups')) return rows(T.groups.filter(r => r.created_by === args[0]));
        if (sql.startsWith('SELECT conversation_id FROM conversations')) return rows(T.conversations.filter(r => r.user_sub === args[0] && r.org_id.startsWith('personal:')));
        if (sql.startsWith('SELECT conversation_id, org_id FROM conversations')) return rows(T.conversations.filter(r => r.user_sub === args[0] && !r.org_id.startsWith('personal:') && r.status === 'active'));
        if (sql.startsWith("UPDATE role_assignments SET status = 'revoked'")) { T.role_assignments.forEach(r => { if (r.assignee_id === args[0]) r.status = 'revoked'; }); return rows([]); }
        if (sql.startsWith('DELETE FROM group_members')) { T.group_members = T.group_members.filter(r => r.user_sub !== args[0]); return rows([]); }
        if (sql.startsWith("UPDATE invitations SET status = 'cancelled'")) { T.invitations.forEach(r => { if (args[0].includes(r.invitation_id)) r.status = 'cancelled'; }); return rows([]); }
        if (sql.startsWith('UPDATE share_grants SET issued_by')) { T.share_grants.find(g => g.grant_id === args[1]).issued_by = args[0]; return rows([]); }
        if (sql.startsWith('UPDATE role_assignments SET assigned_by')) return rows([]);
        if (sql.startsWith('UPDATE groups SET created_by')) { T.groups.find(g => g.group_id === args[1]).created_by = args[0]; return rows([]); }
        if (sql.startsWith('DELETE FROM conversations')) { T.conversations = T.conversations.filter(r => !(r.user_sub === args[0] && r.org_id.startsWith('personal:'))); return rows([]); }
        if (sql.startsWith("UPDATE conversations SET status = 'deleted'")) { T.conversations.forEach(r => { if (r.user_sub === args[0] && !r.org_id.startsWith('personal:')) r.status = 'deleted'; }); return rows([]); }
        if (sql.startsWith('DELETE FROM people_directory')) { T.people_directory = T.people_directory.filter(r => r.user_sub !== args[0]); return rows([]); }
        if (sql.startsWith('INSERT INTO offboarding_log')) { T.offboarding_log.push({ id: args[0], user: args[1], trigger: args[2], status: sql.includes("'failed'") ? 'failed' : 'completed', counts: JSON.parse(args[4]) }); return rows([]); }
        if (sql.startsWith('INSERT INTO content_transfers')) { T.content_transfers.push({ from: args[2], name: args[3], to: args[4], org: args[5], nodes: args[6] }); return rows([]); }
        if (sql.startsWith('INSERT INTO people_directory')) { T.people_directory.push({ user_sub: args[0], display_name: args[1], email: args[2] }); return rows([]); }
        throw new Error(`unexpected SQL: ${sql}`);
    } };
    const permify = {
        async listSubjectTuples(user, types) { return user === GONE ? s.tuples.filter(t => types.includes(t.entityType)) : []; },
        async deleteUserTuple(type, id, rel, user) {
            assert.strictEqual(user, GONE);
            s.tuples = s.tuples.filter(t => !(t.entityType === type && t.entityId === id && t.relation === rel));
        },
        async writeNodeOwner(nodeId, user) { s.ownerWrites.push([nodeId, user]); },
    };
    const bento = {
        async ownedNodes() { return s.nodes.filter(n => !n.moved).map(n => ({ node_id: n.node_id, tenant_id: n.tenant_id })); },
        async transferOwner(from, transfers) {
            if (s.failTransfer) throw new Error('Bento down');
            const changed = {};
            for (const t of transfers) {
                changed[t.tenant_id] = s.nodes.filter(n => n.tenant_id === t.tenant_id && t.node_ids.includes(n.node_id) && !n.moved).map(n => n.node_id);
                s.nodes.forEach(n => { if (changed[t.tenant_id].includes(n.node_id)) { n.moved = t.to_sub; n.from_name = t.from_name; } });
            }
            return changed;
        },
    };
    const redis = { async del(...k) { s.redisDel.push(...k); }, async incr(k) { s.redisIncr.push(k); } };
    const revokeLink = async (id, ownerSub) => { s.linksRevoked.push([id, ownerSub]); T.share_links.find(l => l.link_id === id).revoked_at = 'now'; };
    const off = o.createOffboarding({ db, permify, redis, bento, revokeLink, env: ENV, log: { log() {}, error() {} } });
    return { s, off };
}

(async () => {
    // ── A full offboarding ──────────────────────────────────────────────────────────────────
    const { s, off } = world();
    const p = await off.plan(GONE);
    eq(p.accessTuples.map(t => t.entityId), [PLATFORM_ORG, 'g1', 'shared-to-them'], 'access tuples exclude node ownership');
    eq(p.ownerTupleNodeIds, ['n-plat-1', 'n-vanished'], 'owner tuples are planned separately');
    eq(p.invitationsToThem.map(i => i.invitation_id), ['i-to'], 'invitation to their email found case-insensitively');
    eq(p.name, 'Ada L', 'name from the directory');
    ok(!off.isEmpty(p), 'something to do');

    const r = await off.apply(p, { trigger: o.TRIGGERS.SWEEP });
    eq(s.tuples, [], 'every Permify tuple naming them is gone (access + owner)');
    eq(s.sql.role_assignments[0].status, 'revoked', 'received share marked revoked (D6)');
    eq(s.sql.group_members, [], 'group membership removed (D6)');
    eq(s.sql.invitations.map(i => i.status), ['cancelled', 'cancelled'], 'invitations sent and to their email cancelled (D3, D4)');
    eq(s.linksRevoked, [['l1', GONE]], 'their link revoked (D4)');
    eq(s.ownerWrites.sort(), [['n-plat-1', OWNER], ['n-plat-2', OWNER]], 'platform content → platform owner in Permify (D2)');
    eq(s.nodes.filter(n => n.moved).map(n => n.node_id), ['n-plat-1', 'n-plat-2'], 'platform content moved in the graph');
    ok(!s.nodes.find(n => n.node_id === 'n-cust-1').moved, 'no steward for the customer org → content stays');
    eq(r.awaiting_steward, 1, 'counted as awaiting a steward');
    eq(s.sql.share_grants.map(g => g.issued_by), [OWNER, GONE], 'shares they granted move with transferred content only (D5)');
    eq(s.sql.groups[0].created_by, OWNER, 'groups they created move to the steward (D7)');
    eq(s.sql.conversations.map(c => [c.conversation_id, c.status]), [['c-org', 'deleted']],
       'personal history deleted; organization history soft-deleted (D1)');
    eq(s.sql.people_directory, [], 'directory row removed');
    ok(s.redisDel.includes(`perm:${GONE}`) && s.redisDel.includes(`perm:${OWNER}`), 'caches of the person and the steward cleared');
    ok(s.redisIncr.includes(`perm_version:${PLATFORM_ORG}`) && s.redisIncr.includes(`entcat_version:${PLATFORM_ORG}`), 'versions bumped (AP-30)');
    eq(s.sql.offboarding_log.map(l => [l.user, l.trigger, l.status]), [[GONE, 'sweep', 'completed']], 'one audit row (D8)');
    eq(s.sql.content_transfers, [{ from: GONE, name: 'Ada L', to: OWNER, org: PLATFORM_ORG, nodes: ['n-plat-1', 'n-plat-2'] }],
       'one "Transferred from Ada L" group for the steward (D2)');
    eq(s.nodes.find(n => n.node_id === 'n-plat-1').from_name, 'Ada L', 'each moved node carries the former owner\'s name');

    // ── Idempotent ──────────────────────────────────────────────────────────────────────────
    s.nodes = s.nodes.filter(n => !n.moved);   // what ownedNodes returns now: only the customer node, still theirs
    const again = await off.plan(GONE);
    eq([off.countsOf(again).owned_nodes, off.awaitingSteward(again)], [0, 1], 'the node awaiting a steward is reported, not actionable');
    ok(off.isEmpty(again), 'so a re-run does nothing (no repeated audit rows while a steward is missing)');
    const third = await off.offboard(GONE, { trigger: o.TRIGGERS.SWEEP });
    eq(third, { skipped: true, reason: 'nothing_to_do' }, 'a re-run with nothing left writes nothing');
    eq(s.sql.offboarding_log.length, 1, 'no second audit row');

    // ── Protected ids never touched ────────────────────────────────────────────────────────
    const w2 = world();
    eq(await w2.off.offboard(ALIAS, { trigger: o.TRIGGERS.USER_DELETED }), { skipped: true, reason: 'protected' }, 'owner alias refused');
    eq(w2.s.calls.length, 0, 'not even a read for a protected id');

    // ── Failure is recorded and rethrown ───────────────────────────────────────────────────
    const w3 = world();
    w3.s.failTransfer = true;
    await assert.rejects(() => w3.off.offboard(GONE, { trigger: o.TRIGGERS.USER_DELETED }), /Bento down/); passed++;
    eq(w3.s.sql.offboarding_log.map(l => l.status), ['failed'], 'failure written to the audit log (500 → Clerk retries)');

    // ── Directory upsert ───────────────────────────────────────────────────────────────────
    const w4 = world();
    await w4.off.upsertPerson({ userSub: 'user_newEEEEEEEEEEEEEEEEEEEEEEEEEEEEE', displayName: 'New', email: 'n@x' });
    ok(w4.s.sql.people_directory.some(r => r.display_name === 'New'), 'webhook user.created/updated fills the directory');

    // ── Wiring ─────────────────────────────────────────────────────────────────────────────
    const index = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    ok(/event\.type === 'user\.deleted'[\s\S]{0,600}offboarding\.offboard\([\s\S]{0,400}status\(500\)/.test(index), 'user.deleted → offboard, 500 on failure');
    ok(/user\.created' \|\| event\.type === 'user\.updated'[\s\S]{0,200}upsertPerson/.test(index), 'directory kept from user.created/updated');
    ok(!/user\.created: \$\{primaryEmail\}/.test(index), 'no email address in the user.created log line');
    const deploy = fs.readFileSync(path.join(__dirname, '../../scripts/build-deploy-gateway.sh'), 'utf8');
    ok(/reconcile_offboarding\.js/.test(deploy), 'the sweep runs after every gateway deploy');
    const sweep = fs.readFileSync(path.join(__dirname, '../scripts/reconcile_offboarding.js'), 'utf8');
    ok(/platform owner is not found/.test(sweep) && /max_people_per_run/.test(sweep) && /=== 404 \? 'gone'/.test(sweep),
       'sweep guards: owner must exist, cap per run, only a 404 counts as gone');

    console.log(`verify_offboarding: ${passed} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
