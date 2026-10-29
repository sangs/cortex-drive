'use strict';
/**
 * Unified shares phase 1 (2026-10-29): migrate graph_share_links (frozen copies) to live share_links.
 * Design: documents/security/unified-shares-design-2026-10-29.md §4, §9, §11 (user decisions).
 *
 *   node scripts/migrate_graph_share_links.js                 dry run: report what would happen
 *   node scripts/migrate_graph_share_links.js --apply         create the live links (+ Permify tuples)
 *   node scripts/migrate_graph_share_links.js --verify        compare each migrated link with its copy
 *
 * Per graph_share_links row:
 *   revoked / expired                → not migrated (already dead)
 *   created more than 90 days ago    → not migrated: expires with the migration (user decision 5)
 *   otherwise                        → a share_links row whose roots come from the copy's node ids
 *                                      (same rules as a new share); the old URL keeps working
 *                                      (legacy_token_hash = sha256 of the old token)
 *   roots refused (not the owner's / only Public) → not migrated, reported
 * Idempotent: rows already migrated (legacy_link_id) are skipped.
 * Deleting the copies is a separate, later step (migration 010) once --verify is clean.
 *
 * Env: DB_HOST/DB_PORT/DB_USER/DB_PASSWORD (Cloud SQL Auth Proxy), PERMIFY_API_URL + PERMIFY_API_TOKEN,
 * BENTO_SERVER_URL + BENTO_TOKEN (identity token for Bento), OWNER_USER_ID, OWNER_CLERK_SUBS,
 * GATEWAY_SHARE_SECRET. Exit code 1 on any error.
 */
const crypto = require('crypto');
const db = require('../utils/db');
const permify = require('../utils/permify_gateway');
const { isOwner } = require('../utils/identity');
const { createShareLinks, sha256, linkPrincipal } = require('../utils/share_links');

const LEGACY_LINK_MAX_AGE_DAYS = 90;

async function bentoPost(path, tenantId, body, principalId = '') {
    const res = await fetch(`${process.env.BENTO_SERVER_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId,
                   ...(principalId ? { 'x-user-id': principalId } : {}),
                   ...(process.env.BENTO_TOKEN ? { Authorization: `Bearer ${process.env.BENTO_TOKEN}` } : {}) },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Bento ${path} → ${res.status}`);
    return res.json();
}
const bento = {
    shareRoots: (ids, tenantId, ownerId) => bentoPost('/share_roots', tenantId, { node_ids: ids, owner_id: ownerId }),
    nodesByIds: (ids, tenantId, principalId) => bentoPost('/nodes_by_ids', tenantId, { node_ids: ids }, principalId),
};

async function main() {
    const apply = process.argv.includes('--apply');
    const verify = process.argv.includes('--verify');
    for (const name of ['DB_HOST', 'PERMIFY_API_URL', 'BENTO_SERVER_URL', 'OWNER_USER_ID', 'GATEWAY_SHARE_SECRET']) {
        if (!process.env[name]) throw new Error(`${name} is not set`);
    }
    const links = createShareLinks({ db, permify, bento, redis: { async del() {} }, isOwner,
                                     secret: process.env.GATEWAY_SHARE_SECRET, frontendUrl: '', log: { log() {}, error: console.error } });
    const { rows } = await db.query(
        `SELECT g.link_id, g.share_token, g.node_ids::text[] AS node_ids, g.title, g.owner_sub, g.org_id, g.expires_at,
                g.revoked_at, g.view_count, g.last_viewed_at, g.created_at,
                jsonb_array_length(COALESCE(g.graph_snapshot->'nodes', '[]'::jsonb)) AS snapshot_nodes,
                s.link_id AS migrated_to
         FROM graph_share_links g LEFT JOIN share_links s ON s.legacy_link_id = g.link_id
         ORDER BY g.created_at`);
    const cutoff = new Date(Date.now() - LEGACY_LINK_MAX_AGE_DAYS * 86400000);
    const tally = { total: rows.length, migrated: 0, already: 0, dead: 0, tooOld: 0, refused: 0 };

    for (const r of rows) {
        const label = `${r.link_id} "${r.title || ''}" (${r.created_at.toISOString().slice(0, 10)}, ${r.node_ids.length} ids)`;
        if (r.migrated_to) {
            tally.already++;
            if (verify) {
                const { rows: [l] } = await db.query('SELECT layout_node_ids FROM share_links WHERE link_id = $1', [r.migrated_to]);
                const g = await bento.nodesByIds(l.layout_node_ids, r.org_id, linkPrincipal(r.migrated_to));
                console.log(`  verify ${label}: copy had ${r.snapshot_nodes} nodes, live link shows ${g.nodes.length}`);
            }
            continue;
        }
        if (r.revoked_at || (r.expires_at && new Date(r.expires_at) <= new Date())) { tally.dead++; console.log(`  dead      ${label}`); continue; }
        if (new Date(r.created_at) < cutoff) { tally.tooOld++; console.log(`  too old   ${label} → expires with the migration`); continue; }
        const p = await links.plan({ nodeIds: r.node_ids, userId: r.owner_sub, tenantId: r.org_id });
        if (!p.ok) { tally.refused++; console.log(`  refused   ${label}: ${p.error}${p.denied ? ` (${p.denied.length})` : ''}`); continue; }
        console.log(`  migrate   ${label} → ${p.roots.length} root(s), ${p.totalNodes} nodes reachable`);
        if (!apply) continue;
        const { rows: [row] } = await db.query(
            `INSERT INTO share_links (token_nonce, link_type, root_node_ids, layout_node_ids, title, owner_sub, org_id,
                                      expires_at, view_count, last_viewed_at, created_at, legacy_token_hash, legacy_link_id)
             VALUES ($1, 'graph', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING link_id`,
            [crypto.randomBytes(16).toString('hex'), p.roots, p.layoutNodeIds, r.title, r.owner_sub, r.org_id, r.expires_at,
             r.view_count, r.last_viewed_at, r.created_at, sha256(r.share_token), r.link_id]);
        for (const root of p.roots) await permify.shareNodeWithLink(root, row.link_id);
        tally.migrated++;
    }
    console.log(`graph_share_links: ${JSON.stringify(tally)}${apply ? '' : ' (dry run)'}`);
}

main().then(() => process.exit(0)).catch(err => { console.error('migrate_graph_share_links failed:', err.message); process.exit(1); });
