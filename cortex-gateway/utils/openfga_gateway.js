/**
 * OpenFGA gateway utilities — thin wrappers around the FGA client for share operations.
 * Used by the /api/share/* endpoints in index.js.
 * All functions accept a pre-initialized OpenFgaClient instance.
 *
 * Node identity: all functions accept node_id (n.node_id property — a stable UUID4 set
 * once at node creation). UUIDs contain only hyphens which are valid in OpenFGA object IDs,
 * so no encoding is needed. Object IDs are simply `node:<uuid>`.
 */

async function makeNodeTenantWide(fga, node_id, tenantOrgId) {
    await fga.write({
        writes: [{
            user: `org:${tenantOrgId}#member`,
            relation: 'tenant_viewer',
            object: `node:${node_id}`,
        }],
    });
}

async function shareNodeWithUser(fga, node_id, targetSub, expiresAt = null) {
    const tuple = {
        user: `user:${targetSub}`,
        relation: 'shared_viewer',
        object: `node:${node_id}`,
    };
    if (expiresAt) {
        tuple.condition = { name: 'not_expired', context: { expires_at: expiresAt } };
    }
    await fga.write({ writes: [tuple] });
}

async function shareNodeWithGroup(fga, node_id, groupId, expiresAt = null) {
    const tuple = {
        user: `group:${groupId}#member`,
        relation: 'shared_viewer',
        object: `node:${node_id}`,
    };
    if (expiresAt) {
        tuple.condition = { name: 'not_expired', context: { expires_at: expiresAt } };
    }
    await fga.write({ writes: [tuple] });
}

async function revokeNodeAccess(fga, node_id, subject, relation) {
    await fga.write({
        deletes: [{
            user: subject,
            relation,
            object: `node:${node_id}`,
        }],
    });
}

async function listNodeAccess(fga, node_id) {
    const resp = await fga.readTuples({ object: `node:${node_id}` });
    const tuples = (resp.tuples || []).map(t => ({
        user: t.key.user,
        relation: t.key.relation,
        condition: t.key.condition || null,
    }));
    const now = new Date().toISOString();
    return tuples.map(t => ({
        ...t,
        expired: t.condition?.context?.expires_at ? t.condition.context.expires_at < now : false,
    }));
}

module.exports = {
    makeNodeTenantWide,
    shareNodeWithUser,
    shareNodeWithGroup,
    revokeNodeAccess,
    listNodeAccess,
};
