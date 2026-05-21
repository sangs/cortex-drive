/**
 * OpenFGA gateway utilities — thin wrappers around the FGA client for share operations.
 * Used by the /api/share/* endpoints in index.js.
 * All functions accept a pre-initialized OpenFgaClient instance.
 */

// Neo4j elementIds ('4:uuid:num') contain colons which OpenFGA disallows in object IDs.
// Encode ':' → '.' for storage; getAllowedNodeIds decodes '.' → ':' on read.
const encodeEid = (elementId) => elementId.replace(/:/g, '.');
const decodeEid = (encoded) => encoded.replace(/\./g, ':');

async function makeNodeTenantWide(fga, elementId, tenantOrgId) {
    await fga.write({
        writes: [{
            user: `org:${tenantOrgId}#member`,
            relation: 'tenant_viewer',
            object: `node:${encodeEid(elementId)}`,
        }],
    });
}

async function shareNodeWithUser(fga, elementId, targetSub, expiresAt = null) {
    const tuple = {
        user: `user:${targetSub}`,
        relation: 'shared_viewer',
        object: `node:${encodeEid(elementId)}`,
    };
    if (expiresAt) {
        tuple.condition = { name: 'not_expired', context: { expires_at: expiresAt } };
    }
    await fga.write({ writes: [tuple] });
}

async function shareNodeWithGroup(fga, elementId, groupId, expiresAt = null) {
    const tuple = {
        user: `group:${groupId}#member`,
        relation: 'shared_viewer',
        object: `node:${encodeEid(elementId)}`,
    };
    if (expiresAt) {
        tuple.condition = { name: 'not_expired', context: { expires_at: expiresAt } };
    }
    await fga.write({ writes: [tuple] });
}

async function revokeNodeAccess(fga, elementId, subject, relation) {
    await fga.write({
        deletes: [{
            user: subject,
            relation,
            object: `node:${encodeEid(elementId)}`,
        }],
    });
}

async function listNodeAccess(fga, elementId) {
    const resp = await fga.readTuples({ object: `node:${encodeEid(elementId)}` });
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
    encodeEid,
    decodeEid,
};
