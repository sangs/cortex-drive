'use strict';
/**
 * Ownership checks for the share and group endpoints (S2-43, 2026-10-23).
 *
 * Before this, only PATCH /api/nodes/:id/privacy checked that the caller owns what they act on;
 * every other share/group endpoint trusted the node, grant or group id in the request. That was
 * masked by S2-42 (every signed-in user was mapped to the owner) and became the main hole once
 * S2-42 was fixed.
 *
 *   node actions  → Permify `can_share` on every node involved (the schema grants it to the owner)
 *   grant actions → share_grants.issued_by is the caller, or the caller can share the grant's root
 *   group actions → groups.created_by is the caller (same org)
 *
 * Fail closed: if Permify is not configured or errors, the action is refused.
 * Built from injected `db` / `permify` so it can be unit-tested without a server.
 */

const SHARE_PERMISSION = 'can_share';
const MAX_NODES_PER_CHECK = 200;

function createShareAuthz({ db, permify, log = console }) {
    async function canShareAll(nodeIds, userId) {
        if (!permify.configured()) return { ok: false, status: 503, error: 'Authorization service not configured' };
        const ids = [...new Set((nodeIds || []).filter(Boolean).map(String))];
        if (ids.length === 0) return { ok: false, status: 400, error: 'node id required' };
        if (ids.length > MAX_NODES_PER_CHECK) return { ok: false, status: 400, error: `at most ${MAX_NODES_PER_CHECK} nodes per request` };
        try {
            const results = await Promise.all(ids.map(id => permify.checkPermission(id, userId, SHARE_PERMISSION)));
            const denied = ids.filter((_, i) => !results[i]);
            if (denied.length) return { ok: false, status: 403, error: 'Only the owner of a node can share it or manage its access', denied };
            return { ok: true };
        } catch (err) {
            log.error('[SHARE-AUTHZ] Permify check failed:', err.message);
            return { ok: false, status: 503, error: 'Authorization check failed' };
        }
    }

    function refuse(res, verdict, what) {
        if (verdict.status === 403) {
            log.warn(`[SHARE-AUTHZ] refused ${what}${verdict.denied ? ` nodes=${verdict.denied.length}` : ''}`);
        }
        return res.status(verdict.status).json({ error: verdict.error });
    }

    /** Middleware: the caller must be able to share every node returned by getNodeIds(req). */
    function requireNodeShare(getNodeIds) {
        return async (req, res, next) => {
            const raw = getNodeIds(req);
            const ids = Array.isArray(raw) ? raw : [raw];
            const verdict = await canShareAll(ids, req.headers['x-user-id']);
            return verdict.ok ? next() : refuse(res, verdict, `${req.method} ${req.route?.path || req.path}`);
        };
    }

    /** Middleware: the caller issued the grant (or can share its root node). */
    function requireGrantIssuer(paramName = 'grant_id') {
        return async (req, res, next) => {
            const grantId = req.params[paramName];
            const userId = req.headers['x-user-id'];
            try {
                const { rows: [grant] } = await db.query(
                    'SELECT issued_by, root_node_id FROM share_grants WHERE grant_id = $1', [grantId]);
                if (!grant) return res.status(404).json({ error: 'Grant not found' });
                if (userId && grant.issued_by === userId) return next();
                const verdict = await canShareAll([grant.root_node_id], userId);
                return verdict.ok ? next() : refuse(res, verdict, `${req.method} grant`);
            } catch (err) {
                log.error('[SHARE-AUTHZ] grant lookup failed:', err.message);
                return res.status(503).json({ error: 'Authorization check failed' });
            }
        };
    }

    /** Middleware: the caller created the group, in their own org. */
    function requireGroupCreator(paramName = 'id') {
        return async (req, res, next) => {
            const groupId = req.params[paramName];
            const userId = req.headers['x-user-id'];
            const orgId = req.headers['x-tenant-id'];
            try {
                const { rows: [group] } = await db.query(
                    'SELECT created_by FROM groups WHERE group_id = $1 AND org_id = $2', [groupId, orgId]);
                if (!group) return res.status(404).json({ error: 'Group not found' });
                if (userId && group.created_by === userId) return next();
                log.warn(`[SHARE-AUTHZ] refused ${req.method} group action by non-creator`);
                return res.status(403).json({ error: 'Only the creator of a group can manage it' });
            } catch (err) {
                log.error('[SHARE-AUTHZ] group lookup failed:', err.message);
                return res.status(503).json({ error: 'Authorization check failed' });
            }
        };
    }

    return { canShareAll, requireNodeShare, requireGrantIssuer, requireGroupCreator };
}

module.exports = { createShareAuthz, SHARE_PERMISSION, MAX_NODES_PER_CHECK };
