'use strict';
/**
 * Steward review of transferred content (S2-50 §3b; utils/transfers.js), with fakes (no network):
 * - only the receiving steward sees or acts on a transfer; anyone else gets 404 (no existence leak);
 * - delete and purge need confirm; delete removes every tuple on each deleted node exactly, revokes their grants,
 *   bumps routing + permission caches and records counts; keep bumps routing only;
 * - status becomes reviewed only when nothing is left in review; reminder after transfer_review_days.
 * Run: node tests/verify_transfers.js (npm test).
 */
const assert = require('assert');
const { createTransfers, TransferError } = require('../utils/transfers');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };
async function rejects(p, status, m) {
    try { await p; } catch (e) { eq([e instanceof TransferError, e.status], [true, status], m); return; }
    assert.fail(`${m}: did not throw`);
}

const STEWARD = 'user_steward';
const T1 = '11111111-1111-1111-1111-111111111111';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-23T12:00:00Z');

function setup({ left = 0, createdDaysAgo = 1 } = {}) {
    const calls = { sql: [], bento: [], tuples: [], redis: [] };
    const row = { transfer_id: T1, from_sub: 'user_gone', from_display_name: 'Ada L', to_sub: STEWARD, org_id: 'org_a',
                  node_ids: ['s1', 'n1', 'n2'], created_at: new Date(NOW - createdDaysAgo * DAY), status: 'in_review',
                  reviewed_at: null, decisions: [] };
    const db = {
        async query(sql, params) {
            calls.sql.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
            if (/FROM content_transfers WHERE transfer_id/.test(sql)) return { rows: params[0] === T1 ? [row] : [] };
            if (/FROM content_transfers WHERE to_sub/.test(sql)) return { rows: params[0] === STEWARD ? [row] : [] };
            if (/FROM share_grants/.test(sql)) return { rows: [{ n: 2 }] };
            if (/FROM conversations/.test(sql) && /count/.test(sql)) return { rows: [{ n: 3, first: new Date('2026-11-20T00:00:00Z') }] };
            if (/UPDATE share_grants/.test(sql)) return { rowCount: 1 };
            if (/DELETE FROM conversations/.test(sql)) return { rowCount: 3 };
            return { rows: [], rowCount: 0 };
        },
    };
    const permify = {
        async listNodeAccess(id) {
            return id === 's1' ? [{ relation: 'owner', subject: { type: 'user', id: STEWARD, relation: '' } },
                                   { relation: 'shared_viewer', subject: { type: 'group', id: 'g1', relation: 'member' } }] : [];
        },
        async deleteTuple(type, id, relation, subject) { calls.tuples.push([type, id, relation, subject]); },
    };
    const redis = { async incr(k) { calls.redis.push(['incr', k]); }, async del(k) { calls.redis.push(['del', k]); } };
    const bento = {
        async items(a) { calls.bento.push(['items', a]); return { sources: [], other_nodes: 0, total_nodes: left }; },
        async keep(a) { calls.bento.push(['keep', a]); return { changed: ['s1', 'n1'] }; },
        async remove(a) { calls.bento.push(['remove', a]); return { deleted: ['s1', 'n1'], kept_in_use: ['n2'] }; },
    };
    return { t: createTransfers({ db, permify, redis, bento, log: { log() {} }, now: () => NOW }), calls };
}

(async () => {
    // Who can see it
    let { t, calls } = setup();
    const list = await t.list(STEWARD);
    eq(list.length, 1, 'steward lists their transfer');
    eq([list[0].fromName, list[0].nodes, list[0].sharesKept, list[0].hiddenChats, list[0].hiddenChatsPurgeOn, list[0].reminder],
       ['Ada L', 3, 2, 3, '2026-12-20', false], 'summary: counts and purge date (hidden on 11-20 + 30 days)');
    eq(await t.list('user_other'), [], 'another user lists nothing');
    await rejects(t.items('user_other', T1), 404, 'another user: not found');
    await rejects(t.keep('user_other', T1), 404, 'another user cannot keep');
    await rejects(t.remove('user_other', T1, ['s1'], { confirm: true }), 404, 'another user cannot delete');
    await rejects(t.purgeHistory('user_other', T1, { confirm: true }), 404, 'another user cannot purge');
    await rejects(t.items(STEWARD, 'not-a-uuid'), 404, 'malformed id: not found');
    eq(calls.bento.length, 0, 'no graph call for a refused request');
    ok(setup({ createdDaysAgo: 31 }).t.list(STEWARD).then(l => l[0].reminder), 'reminder after 30 days');
    eq((await setup({ createdDaysAgo: 31 }).t.list(STEWARD))[0].reminder, true, 'reminder flag');

    // Delete
    ({ t, calls } = setup());
    await rejects(t.remove(STEWARD, T1, ['s1'], {}), 400, 'delete needs confirm');
    await rejects(t.remove(STEWARD, T1, [], { confirm: true }), 400, 'delete needs a source');
    eq(calls.bento.length, 0, 'nothing deleted without confirm');
    const r = await t.remove(STEWARD, T1, ['s1'], { confirm: true });
    eq(r, { deleted: 2, keptInUse: 1, status: 'reviewed' }, 'delete result');
    eq(calls.bento[0], ['remove', { steward: STEWARD, transfer_id: T1, tenant_id: 'org_a', source_ids: ['s1'] }], 'Bento gets the steward, transfer and org');
    eq(calls.tuples, [['node', 's1', 'owner', { type: 'user', id: STEWARD, relation: '' }],
                      ['node', 's1', 'shared_viewer', { type: 'group', id: 'g1', relation: 'member' }]], 'every tuple on the deleted node, one by one');
    ok(calls.sql.some(q => /UPDATE share_grants SET status = 'revoked'/.test(q.sql) && q.params[0].join() === 's1,n1'), 'grants on deleted nodes revoked');
    eq(calls.redis, [['incr', 'entcat_version:org_a'], ['incr', 'perm_version:org_a'], ['del', 'perm:user_steward']], 'routing + permission caches');
    const upd = calls.sql.find(q => /UPDATE content_transfers/.test(q.sql));
    eq(upd.params[2], 'reviewed', 'nothing left → reviewed');
    eq(JSON.parse(upd.params[1])[0].counts, { sources: 1, nodes: 2, kept_in_use: 1, tuples: 2, grants: 1 }, 'counts recorded, no content');

    // Keep
    ({ t, calls } = setup({ left: 5 }));
    eq(await t.keep(STEWARD, T1), { changed: 2, status: 'in_review' }, 'keep all; something left → still in review');
    eq(calls.bento[0], ['keep', { steward: STEWARD, transfer_id: T1, tenant_id: 'org_a', source_ids: null }], 'keep all → null sources');
    eq(calls.redis, [['incr', 'entcat_version:org_a']], 'keep bumps routing only');
    await rejects(t.keep(STEWARD, T1, []), 400, 'keep with an empty choice refused');

    // Purge hidden chats
    ({ t, calls } = setup());
    await rejects(t.purgeHistory(STEWARD, T1, {}), 400, 'purge needs confirm');
    eq(await t.purgeHistory(STEWARD, T1, { confirm: true }), { deleted: 3 }, 'purged');
    const del = calls.sql.find(q => /DELETE FROM conversations/.test(q.sql));
    eq(del.params, ['user_gone', 'org_a'], 'only the former person\'s chats in this organization');
    ok(/status = 'deleted'/.test(del.sql), 'only hidden chats');

    console.log(`verify_transfers: ${passed} checks passed`);
})().catch(err => { console.error('verify_transfers FAILED:', err.message); process.exit(1); });
