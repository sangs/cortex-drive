'use strict';
/**
 * Live share links (unified shares phase 1, 2026-10-29).
 * Design: documents/security/unified-shares-design-2026-10-29.md §3, §4, §6, §9.
 *
 * A link is a Permify audience: subject share_link:<link_id>, one `shared_viewer` tuple per ROOT node.
 * Everything under a root is reachable through Permify `parent` inheritance (decision A). The link page
 * reads its layout nodes LIVE through the link's permissions (Bento /nodes_by_ids); nothing is copied.
 * Before 2026-10-29 a graph-view link stored a frozen copy of the graph in Cloud SQL (graph_share_links).
 *
 * Tokens are not stored: token = "<link_id>.<hex HMAC-SHA256(secret, link_id:nonce)>". A database leak
 * exposes no working link; the owner can still copy the URL later. Migrated legacy tokens are matched
 * by their sha256 only (legacy_token_hash).
 *
 * Built from injected dependencies so it can be unit-tested without a server.
 */
const crypto = require('crypto');

const LINK_SUBJECT_PREFIX = 'share_link:';
const LINK_TOKEN_SEPARATOR = '.';
const NOTHING_TO_SHARE_ERROR = 'Nothing here can be shared: everything is already visible to everyone (Public or built-in).';
const NOT_YOURS_ERROR = 'Some of these nodes were added by someone else, so you cannot share them. Remove them from the view and try again.';

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const linkPrincipal = linkId => `${LINK_SUBJECT_PREFIX}${linkId}`;

/**
 * @param {object} deps
 *   db            { query(sql, params) }
 *   permify       { shareNodeWithLink, revokeNodeLink, checkPermission }
 *   bento         { shareRoots(nodeIds, tenantId, ownerId), nodesByIds(nodeIds, tenantId, principalId) }
 *   redis         { del(...keys) }
 *   isOwner       (userId) → boolean (platform owner)
 *   secret        HMAC secret (GATEWAY_SHARE_SECRET); required, no default (AP-24)
 *   frontendUrl   base URL for /graph-view/<token>
 */
function createShareLinks({ db, permify, bento, redis, isOwner = () => false, secret, frontendUrl, log = console }) {
    function requireSecret() {
        if (!secret) throw Object.assign(new Error('Share links are not configured (GATEWAY_SHARE_SECRET missing)'), { status: 503 });
        return secret;
    }
    const sign = (linkId, nonce) => crypto.createHmac('sha256', requireSecret()).update(`${linkId}:${nonce}`).digest('hex');
    const tokenFor = (linkId, nonce) => `${linkId}${LINK_TOKEN_SEPARATOR}${sign(linkId, nonce)}`;
    const urlFor = (linkId, nonce) => `${frontendUrl}/graph-view/${tokenFor(linkId, nonce)}`;

    /**
     * Which of the selected nodes become roots (design §3). Returns
     * { ok, roots, layoutNodeIds, totalNodes, dropped: { everyone, display }, covered } or
     * { ok: false, status, error, denied? }. The platform owner may share their tenant's nodes that
     * nobody else added; everyone else needs Permify can_share (= Permify owner) on every node.
     */
    async function plan({ nodeIds, userId, tenantId }) {
        const owner = isOwner(userId);
        const r = await bento.shareRoots(nodeIds, tenantId, owner ? userId : '');
        const candidates = [...r.roots, ...r.covered];
        const toCheck = owner ? r.others : candidates;
        const allowed = await Promise.all(toCheck.map(id => permify.checkPermission(id, userId, 'can_share')));
        const denied = toCheck.filter((_, i) => !allowed[i]);
        if (denied.length) return { ok: false, status: 403, error: NOT_YOURS_ERROR, denied };
        if (!r.roots.length) return { ok: false, status: 409, error: NOTHING_TO_SHARE_ERROR, everyone_visible: true };
        return {
            ok: true,
            roots: r.roots,
            covered: r.covered,
            layoutNodeIds: [...candidates, ...r.everyone],
            totalNodes: r.total_nodes,
            dropped: { everyone: r.everyone.length, display: r.unknown.length },
        };
    }

    /** Create a live graph-view link. Writes the Permify tuples; undoes them if the database write fails. */
    async function createGraphLink({ nodeIds, title, expiresAt, userId, tenantId }) {
        const p = await plan({ nodeIds, userId, tenantId });
        if (!p.ok) return p;
        requireSecret();
        const nonce = crypto.randomBytes(16).toString('hex');
        const { rows: [row] } = await db.query(
            `INSERT INTO share_links (token_nonce, link_type, root_node_ids, layout_node_ids, title, owner_sub, org_id, expires_at)
             VALUES ($1, 'graph', $2, $3, $4, $5, $6, $7) RETURNING link_id`,
            [nonce, p.roots, p.layoutNodeIds, title || null, userId, tenantId, expiresAt || null]);
        const written = [];
        try {
            for (const root of p.roots) { await permify.shareNodeWithLink(root, row.link_id); written.push(root); }
        } catch (err) {
            log.error('[SHARE-LINK] Permify write failed, rolling back:', err.message);
            for (const root of written) await permify.revokeNodeLink(root, row.link_id).catch(e => log.error('[SHARE-LINK] rollback:', e.message));
            await db.query('DELETE FROM share_links WHERE link_id = $1', [row.link_id]);
            throw err;
        }
        log.log(`[SHARE-LINK] created ${row.link_id} roots=${p.roots.length} total=${p.totalNodes} by=${userId}`);
        return { ok: true, linkId: row.link_id, shareUrl: urlFor(row.link_id, nonce), plan: p };
    }

    /** The active link a token opens, or null. Legacy (migrated) tokens are matched by sha256 only. */
    async function resolveToken(token) {
        const t = String(token || '');
        let row = null;
        const sep = t.indexOf(LINK_TOKEN_SEPARATOR);
        if (sep > 0) {
            const linkId = t.slice(0, sep);
            if (!/^[0-9a-f-]{36}$/i.test(linkId)) return null;
            const { rows } = await db.query('SELECT * FROM share_links WHERE link_id = $1', [linkId]);
            if (!rows.length) return null;
            const given = Buffer.from(t.slice(sep + 1));
            const expected = Buffer.from(sign(rows[0].link_id, rows[0].token_nonce));
            if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
            row = rows[0];
        } else if (t) {
            const { rows } = await db.query('SELECT * FROM share_links WHERE legacy_token_hash = $1', [sha256(t)]);
            row = rows[0] || null;
        }
        if (!row || row.revoked_at) return null;
        if (row.expires_at && new Date(row.expires_at) <= new Date()) return null;
        return row;
    }

    /** The live graph for a link: its layout nodes the link can see now, and the links between them. */
    async function viewGraphLink(token) {
        const link = await resolveToken(token);
        if (!link) return null;
        const graph = await bento.nodesByIds(link.layout_node_ids, link.org_id, linkPrincipal(link.link_id));
        db.query('UPDATE share_links SET view_count = view_count + 1, last_viewed_at = NOW() WHERE link_id = $1', [link.link_id])
            .catch(() => {});
        return { link, graph };
    }

    /** The owner's links, newest first, each with its URL (re-derived from the nonce). */
    async function listLinks(userId) {
        const { rows } = await db.query(
            `SELECT link_id, token_nonce, title, array_length(root_node_ids, 1) AS root_count,
                    array_length(layout_node_ids, 1) AS node_count, created_at, expires_at, revoked_at,
                    view_count, last_viewed_at,
                    CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
                         WHEN expires_at IS NOT NULL AND expires_at < NOW() THEN 'expired'
                         ELSE 'active' END AS status
             FROM share_links WHERE owner_sub = $1 ORDER BY created_at DESC`, [userId]);
        return rows.map(({ token_nonce, ...r }) => ({ ...r, shareUrl: urlFor(r.link_id, token_nonce) }));
    }

    /** Revoke: exact-delete each root tuple (AP-28), mark revoked, drop the link's cached allowlist. */
    async function revokeLink(linkId, userId) {
        const { rows } = await db.query(
            'SELECT link_id, root_node_ids FROM share_links WHERE link_id = $1 AND owner_sub = $2 AND revoked_at IS NULL',
            [linkId, userId]);
        if (!rows.length) return false;
        for (const root of rows[0].root_node_ids) await permify.revokeNodeLink(root, linkId);
        await db.query('UPDATE share_links SET revoked_at = NOW() WHERE link_id = $1', [linkId]);
        await redis.del(`perm:${linkPrincipal(linkId)}`);
        log.log(`[SHARE-LINK] revoked ${linkId} roots=${rows[0].root_node_ids.length}`);
        return true;
    }

    return { plan, createGraphLink, resolveToken, viewGraphLink, listLinks, revokeLink, tokenFor, linkPrincipal };
}

module.exports = { createShareLinks, linkPrincipal, sha256, LINK_SUBJECT_PREFIX, NOTHING_TO_SHARE_ERROR, NOT_YOURS_ERROR };
