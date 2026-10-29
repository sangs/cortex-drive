'use strict';
/**
 * What each user type may do (S2-69, 2026-10-29). One source of truth for both the server checks
 * and GET /api/me/capabilities, so the UI can never offer an action the server would refuse.
 * Spec: documents/security/user-roles-and-access-model.md §3. Per-node rights (can_share = owner
 * of the node) stay in Permify / utils/share_authz.js; these are the type-level gates on top.
 */
const { USER_TYPES } = require('./identity');

// Who may add sources (decided 2026-10-28): the owner and organization admins/members. Never
// collaborators, guests or the trial key. The MCP tools apply the same rule (x-user-type).
const SOURCE_WRITER_USER_TYPES = new Set([USER_TYPES.OWNER, USER_TYPES.ORG_ADMIN, USER_TYPES.ORG_MEMBER]);
// Collaborators creating groups comes later, with groups/workspaces (roles doc §9 Q3).
const GROUP_MANAGER_USER_TYPES = SOURCE_WRITER_USER_TYPES;

const NO_CAPABILITIES = Object.freeze({
    addSource: false, sourceVisibilities: [], share: false, shareOrgWide: false, manageGroups: false, admin: false,
});

/**
 * @param {{ type: string, isOwner?: boolean, isOrgAdmin?: boolean, guest?: boolean }} principal
 */
function capabilitiesFor({ type, isOwner = false, isOrgAdmin = false, guest = false } = {}) {
    if (guest || !type) return { ...NO_CAPABILITIES, sourceVisibilities: [] };
    const writer = SOURCE_WRITER_USER_TYPES.has(type);
    const owner = writer && (isOwner || type === USER_TYPES.OWNER);
    const admin = writer && (owner || isOrgAdmin);
    return {
        addSource: writer,
        // Mirrors utils/source_visibility.js: private for every writer, organization for admins, public for the owner.
        sourceVisibilities: writer ? ['private', ...(admin ? ['organization'] : []), ...(owner ? ['public'] : [])] : [],
        // Only nodes you own can be shared (Permify can_share); only writers can own nodes.
        share: writer,
        shareOrgWide: admin,
        manageGroups: GROUP_MANAGER_USER_TYPES.has(type),
        // Schema/statistics, cache invalidation, pending-invite sweep (x-schema-readable).
        admin,
    };
}

/** Principal from the gateway-assigned headers (AP-23: never client-sent). */
function principalFromRequest(req, isOwner) {
    return {
        type: req.headers['x-user-type'] || '',
        isOwner: isOwner(req.headers['x-user-id'] || ''),
        isOrgAdmin: req.headers['x-schema-readable'] === 'true',
        guest: req.guestAuth === true,
    };
}

/** Express middleware: refuse unless the caller has `capability`. */
function createCapabilityGuard(isOwner) {
    return (capability, message) => (req, res, next) => {
        if (capabilitiesFor(principalFromRequest(req, isOwner))[capability] === true) return next();
        console.warn(`[CAPABILITY] refused ${capability} for type=${req.headers['x-user-type'] || 'none'} ${req.method} ${req.path}`);
        return res.status(403).json({ error: message });
    };
}

module.exports = { SOURCE_WRITER_USER_TYPES, GROUP_MANAGER_USER_TYPES, capabilitiesFor, principalFromRequest, createCapabilityGuard };
