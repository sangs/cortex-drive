'use strict';
/**
 * Steward review of transferred content (S2-50 §3b, 2026-11-23): "Transferred to you" in Settings → Sharing & Access.
 * Design: documents/security/offboarding-and-retention-design-2026-11-20.md §3b.
 *
 * A transfer (content_transfers row, written by utils/offboarding.js) belongs to the steward who received it. Only that
 * steward sees or acts on it; any other user gets "not found" (no existence leak). Actions:
 *   keep           — provenance removed from the nodes (the former person's name leaves the graph); the content joins
 *                    the steward's normal answers (MCP search and routing skip it until then).
 *   delete         — permanent: the chosen sources and the transferred nodes only they use (Bento ownership.py),
 *                    then every Permify tuple on those nodes is removed exactly (AP-28) and their share grants revoked.
 *   purgeHistory   — the former person's hidden organization chats are deleted now instead of after the window.
 * Every action records counts (never content) on the row and bumps the caches it affects (AP-30).
 */
const CONFIG = require('../config/offboarding.json');

const REVIEW = CONFIG.review || {};
const DAY_MS = 24 * 60 * 60 * 1000;
const STATUS = { IN_REVIEW: 'in_review', REVIEWED: 'reviewed' };

class TransferError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

/**
 * @param deps.db        { query }
 * @param deps.permify   permify_gateway (listNodeAccess, exactTupleFilter via deleteNodeTuple)
 * @param deps.redis     ioredis
 * @param deps.bento     { items(args), keep(args), remove(args) } → Bento /transfer_items, /transfer_keep, /transfer_delete
 * @param deps.now       () => ms (tests)
 */
function createTransfers({ db, permify, redis, bento, log = console, now = Date.now }) {
    async function load(userSub, transferId) {
        if (!userSub || !/^[0-9a-f-]{36}$/i.test(String(transferId || ''))) throw new TransferError(404, 'Transfer not found');
        const { rows } = await db.query(
            `SELECT transfer_id, from_sub, from_display_name, to_sub, org_id, node_ids, created_at, status, reviewed_at, decisions
               FROM content_transfers WHERE transfer_id = $1`, [transferId]);
        const t = rows[0];
        if (!t || t.to_sub !== userSub) throw new TransferError(404, 'Transfer not found');
        return t;
    }

    const args = (t, extra = {}) => ({ steward: t.to_sub, transfer_id: t.transfer_id, tenant_id: t.org_id, ...extra });

    /** Hidden organization chats of the former person in this organization: count and when they go. */
    async function hiddenChats(t) {
        const { rows } = await db.query(
            `SELECT count(*)::int AS n, min(deleted_at) AS first FROM conversations
              WHERE user_sub = $1 AND org_id = $2 AND status = 'deleted'`, [t.from_sub, t.org_id]);
        const r = rows[0] || { n: 0, first: null };
        const purgeOn = r.first ? new Date(new Date(r.first).getTime() + ((CONFIG.retention || {}).history_retention_days || 30) * DAY_MS) : null;
        return { count: r.n, purgeOn: purgeOn ? purgeOn.toISOString().slice(0, 10) : null };
    }

    async function summary(t) {
        const [{ rows: shares }, chats] = await Promise.all([
            db.query(`SELECT count(*)::int AS n FROM share_grants
                       WHERE status = 'active' AND issued_by = $1 AND root_node_id = ANY($2)`, [t.to_sub, t.node_ids || []]),
            hiddenChats(t),
        ]);
        const created = new Date(t.created_at).getTime();
        return {
            transferId: t.transfer_id,
            fromName: t.from_display_name,
            orgId: t.org_id,
            createdAt: new Date(t.created_at).toISOString(),
            status: t.status,
            reviewedAt: t.reviewed_at ? new Date(t.reviewed_at).toISOString() : null,
            nodes: (t.node_ids || []).length,
            sharesKept: shares[0] ? shares[0].n : 0,
            hiddenChats: chats.count,
            hiddenChatsPurgeOn: chats.purgeOn,
            reminder: t.status === STATUS.IN_REVIEW && now() - created > (REVIEW.transfer_review_days || 30) * DAY_MS,
            decisions: t.decisions || [],
        };
    }

    async function list(userSub) {
        if (!userSub) return [];
        const { rows } = await db.query(
            `SELECT transfer_id, from_sub, from_display_name, to_sub, org_id, node_ids, created_at, status, reviewed_at, decisions
               FROM content_transfers WHERE to_sub = $1 ORDER BY created_at DESC`, [userSub]);
        return Promise.all(rows.map(summary));
    }

    async function items(userSub, transferId) {
        const t = await load(userSub, transferId);
        return { ...(await summary(t)), ...(await bento.items(args(t))) };
    }

    /** Record a decision; the transfer is reviewed when nothing is left in review. */
    async function record(t, decision) {
        const left = await bento.items(args(t));
        const status = left.total_nodes === 0 ? STATUS.REVIEWED : STATUS.IN_REVIEW;
        await db.query(
            `UPDATE content_transfers SET decisions = decisions || $2::jsonb, status = $3,
                    reviewed_at = CASE WHEN $3 = 'reviewed' THEN now() ELSE reviewed_at END
              WHERE transfer_id = $1`,
            [t.transfer_id, JSON.stringify([{ ...decision, at: new Date(now()).toISOString() }]), status]);
        log.log(`[TRANSFER] ${t.transfer_id} ${decision.action} ${JSON.stringify(decision.counts)} → ${status}`);
        return status;
    }

    async function bumpCaches(t, { permissions }) {
        await redis.incr(`entcat_version:${t.org_id}`);   // routing and suggestions now see (or lose) these names
        if (permissions) {
            await redis.incr(`perm_version:${t.org_id}`);
            await redis.del(`perm:${t.to_sub}`);
        }
    }

    async function keep(userSub, transferId, sourceIds = null) {
        const t = await load(userSub, transferId);
        if (sourceIds !== null && (!Array.isArray(sourceIds) || !sourceIds.length)) throw new TransferError(400, 'Choose at least one source');
        const { changed } = await bento.keep(args(t, { source_ids: sourceIds }));
        await bumpCaches(t, { permissions: false });
        const status = await record(t, { action: 'keep', counts: { nodes: changed.length, sources: sourceIds ? sourceIds.length : 'all' } });
        return { changed: changed.length, status };
    }

    /** Every Permify tuple on a deleted node, removed one by one with exact filters (AP-28). Errors are thrown. */
    async function deleteNodeTuples(nodeId) {
        const tuples = await permify.listNodeAccess(nodeId);
        for (const tp of tuples) {
            await permify.deleteTuple('node', nodeId, tp.relation, tp.subject);
        }
        return tuples.length;
    }

    async function remove(userSub, transferId, sourceIds, { confirm } = {}) {
        if (confirm !== true) throw new TransferError(400, 'Deleting is permanent; confirm is required');
        if (!Array.isArray(sourceIds) || !sourceIds.length) throw new TransferError(400, 'Choose at least one source');
        const t = await load(userSub, transferId);
        const { deleted, kept_in_use: keptInUse } = await bento.remove(args(t, { source_ids: sourceIds }));
        let tuples = 0;
        for (const id of deleted) tuples += await deleteNodeTuples(id);
        const { rowCount: grants } = await db.query(
            `UPDATE share_grants SET status = 'revoked', revoked_at = now(), revoked_by = $2
              WHERE status = 'active' AND root_node_id = ANY($1)`, [deleted, t.to_sub]);
        await bumpCaches(t, { permissions: true });
        const status = await record(t, { action: 'delete',
            counts: { sources: sourceIds.length, nodes: deleted.length, kept_in_use: keptInUse.length, tuples, grants } });
        return { deleted: deleted.length, keptInUse: keptInUse.length, status };
    }

    async function purgeHistory(userSub, transferId, { confirm } = {}) {
        if (confirm !== true) throw new TransferError(400, 'Deleting is permanent; confirm is required');
        const t = await load(userSub, transferId);
        const { rowCount } = await db.query(
            `DELETE FROM conversations WHERE user_sub = $1 AND org_id = $2 AND status = 'deleted'`, [t.from_sub, t.org_id]);
        await record(t, { action: 'purge_hidden_chats', counts: { conversations: rowCount } });
        return { deleted: rowCount };
    }

    return { list, items, keep, remove, purgeHistory };
}

module.exports = { createTransfers, TransferError, STATUS };
