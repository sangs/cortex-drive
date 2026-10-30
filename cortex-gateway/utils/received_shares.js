'use strict';
/**
 * "Shared with me" (unified shares phase 2, 2026-10-29; design security/unified-shares-design-2026-10-29.md §5).
 *
 * What a signed-in user has received: active grants to them directly or through a group they belong
 * to, each listed only if they can STILL open its root right now (Bento /nodes_by_ids under their own
 * Permify allowlist), so a revoked or newly private item disappears on the next refresh.
 * Suggested questions are deterministic templates (config/suggested_questions.json): never an LLM.
 *
 * Built from injected dependencies so it can be unit-tested without a server.
 */
const SUGGESTED = require('../config/suggested_questions.json');

/** Suggested questions for one shared item: templates for its node type, filled with its exact title. */
function suggestedQuestions(type, title) {
    const name = String(title || '').trim();
    if (!name) return [];
    const templates = SUGGESTED.by_type[type] || SUGGESTED.default;
    return templates.slice(0, SUGGESTED.max_per_item).map(t => t.split('{title}').join(name));
}

// Active grants to the user or to a group they are in; never their own shares.
const RECEIVED_SQL = `
    SELECT sg.grant_id, sg.root_node_id, sg.grant_type, COALESCE(array_length(sg.child_node_ids, 1), 1) AS node_count,
           sg.issued_by, sg.issued_at, sg.expires_at, ra.assignee_type, g.name AS group_name
    FROM role_assignments ra
    JOIN share_grants sg ON ra.resource_type = 'grant' AND ra.resource_id = sg.grant_id::text
    LEFT JOIN groups g ON ra.assignee_type = 'group' AND g.group_id::text = ra.assignee_id
    WHERE ra.status = 'active' AND sg.status = 'active'
      AND (sg.expires_at IS NULL OR sg.expires_at > now())
      AND (ra.expires_at IS NULL OR ra.expires_at > now())
      AND sg.issued_by <> $1
      AND ((ra.assignee_type = 'user' AND ra.assignee_id = $1)
        OR (ra.assignee_type = 'group' AND ra.assignee_id IN (SELECT group_id::text FROM group_members WHERE user_sub = $1)))
    ORDER BY sg.issued_at DESC`;

/**
 * @param {object} deps
 *   db        { query(sql, params) }
 *   bento     { nodesByIds(nodeIds, tenantId, principalId) } — runs under the principal's own permissions
 *   userName  async (sub) → display name of the sharer (best effort)
 */
function createReceivedShares({ db, bento, userName = async () => '', log = console }) {
    async function list({ userId, tenantId }) {
        const { rows } = await db.query(RECEIVED_SQL, [userId]);
        if (!rows.length) return [];
        // One grant can reach a user twice (directly and through a group): keep the first (newest).
        const byGrant = new Map();
        for (const r of rows) if (!byGrant.has(r.grant_id)) byGrant.set(r.grant_id, r);
        const grants = [...byGrant.values()];
        const roots = [...new Set(grants.map(g => g.root_node_id))];
        const graph = await bento.nodesByIds(roots, tenantId, userId);
        const visible = new Map((graph.nodes || []).map(n => [n.node_id, n]));
        const names = new Map();
        for (const sub of new Set(grants.map(g => g.issued_by))) {
            names.set(sub, await userName(sub).catch(() => '') || 'Someone');
        }
        const items = [];
        for (const g of grants) {
            const node = visible.get(g.root_node_id);
            if (!node) continue;   // revoked in Permify, made private, or deleted: not shown
            items.push({
                grantId: g.grant_id,
                nodeId: g.root_node_id,
                title: node.name,
                type: node.type,
                description: node.description || '',
                nodeCount: Number(g.node_count) || 1,
                sharedBy: names.get(g.issued_by),
                sharedAt: g.issued_at,
                expiresAt: g.expires_at,
                via: g.assignee_type === 'group' ? { group: g.group_name || 'a group' } : { direct: true },
                questions: suggestedQuestions(node.type, node.name),
            });
        }
        log.log(`[SHARED-WITH-ME] user=${userId} grants=${grants.length} visible=${items.length}`);
        return items;
    }
    return { list };
}

module.exports = { createReceivedShares, suggestedQuestions, RECEIVED_SQL };
