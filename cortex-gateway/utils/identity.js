'use strict';
/**
 * Owner identity mapping for signed-in users (S2-42, 2026-10-23).
 *
 * Permify tuples are keyed on the owner's PRODUCTION Clerk id (OWNER_USER_ID). The owner's dev Clerk
 * account has a different id, so it has to be mapped onto OWNER_USER_ID. Until 2026-10-23 the mapping
 * was unconditional (`OWNER_USER_ID || decoded.sub`), so EVERY signed-in user, including people
 * invited through "share by email", was treated as the owner.
 *
 * Now only an explicit list of the owner's own Clerk ids is mapped:
 *   - OWNER_USER_ID itself (the production account), and
 *   - OWNER_CLERK_SUBS: extra ids of the owner's own accounts (e.g. the dev Clerk id, a second sign-in),
 *     separated by `;` (or `,` locally — Cloud Run's --set-env-vars uses `,` as its own separator).
 * Everyone else keeps their real Clerk id.
 */

function ownerClerkSubs(env = process.env) {
    const subs = new Set(String(env.OWNER_CLERK_SUBS || '').split(/[;,\s]+/).map(s => s.trim()).filter(Boolean));
    if (env.OWNER_USER_ID) subs.add(env.OWNER_USER_ID);
    return subs;
}

/** The x-user-id for a verified Clerk subject. */
function resolveUserId(clerkSub, env = process.env) {
    const sub = clerkSub || '';
    if (sub && env.OWNER_USER_ID && ownerClerkSubs(env).has(sub)) return env.OWNER_USER_ID;
    return sub;
}

/** True when a gateway-assigned x-user-id is the owner. */
function isOwner(userId, env = process.env) {
    return Boolean(env.OWNER_USER_ID) && userId === env.OWNER_USER_ID;
}

// ─── User types and tenant resolution (S2-48, 2026-10-28) ────────────────────────────────────────
// documents/security/user-roles-and-access-model.md §1. Mirrored in src/mcp_server/schema_guard.py
// (USER_TYPE_*). Sent downstream only as the gateway-assigned x-user-type header (AP-23).
const USER_TYPES = Object.freeze({
    OWNER: 'owner',
    ORG_ADMIN: 'org_admin',
    ORG_MEMBER: 'org_member',
    COLLABORATOR: 'collaborator',
    GUEST: 'guest',
    TRIAL: 'trial',
});
const CLERK_ADMIN_ROLES = new Set(['org:admin', 'admin']);
// A collaborator (signed in, member of no organization) gets a scope of their own: their history,
// caches and permission version live there; it holds no graph data and allows no writes.
const PERSONAL_SCOPE_PREFIX = 'personal:';

/**
 * Who a signed-in Clerk user is and which tenant they act in.
 *   clerkSub              verified JWT `sub`
 *   jwtOrgId, jwtOrgRole  the JWT's active organization, when the session has one (signed by Clerk)
 *   memberships           [{ orgId, role }] from Clerk (cached), used when the JWT has no active org
 * Owner → TENANT_ID (the platform organization). Member of an organization → that organization, as
 * org_admin or org_member. Anyone else → collaborator in their personal scope.
 * Groups/workspaces (roles doc §6) will add fields to this object, not new branches.
 */
function resolvePrincipal({ clerkSub, jwtOrgId = '', jwtOrgRole = '', memberships = [] }, env = process.env) {
    const userId = resolveUserId(clerkSub, env);
    const fromJwt = jwtOrgId ? { orgId: jwtOrgId, role: jwtOrgRole || '' } : null;
    const membership = (fromJwt && (memberships.find(m => m.orgId === jwtOrgId) || fromJwt)) || memberships[0] || null;
    const isOrgAdmin = Boolean(membership && CLERK_ADMIN_ROLES.has(membership.role));
    if (isOwner(userId, env)) {
        const tenantId = env.TENANT_ID || (membership && membership.orgId) || `${PERSONAL_SCOPE_PREFIX}${clerkSub}`;
        return { userId, rawUserId: clerkSub || '', type: USER_TYPES.OWNER, tenantId, isOrgAdmin };
    }
    if (membership) {
        const type = isOrgAdmin ? USER_TYPES.ORG_ADMIN : USER_TYPES.ORG_MEMBER;
        return { userId, rawUserId: clerkSub || '', type, tenantId: membership.orgId, isOrgAdmin };
    }
    return { userId, rawUserId: clerkSub || '', type: USER_TYPES.COLLABORATOR,
             tenantId: `${PERSONAL_SCOPE_PREFIX}${clerkSub}`, isOrgAdmin: false };
}

/**
 * The tenant whose routing catalog a user's questions use. A collaborator's personal scope has no
 * catalog; what is shared with them lives in the platform organization, so they use its catalog,
 * filtered to titles they can open (AP-30). With several customer organizations this becomes the
 * organizations that shared with them.
 */
function routingTenantFor(type, tenantId, env = process.env) {
    return type === USER_TYPES.COLLABORATOR ? (env.TENANT_ID || tenantId) : tenantId;
}

module.exports = { ownerClerkSubs, resolveUserId, isOwner, USER_TYPES, PERSONAL_SCOPE_PREFIX, resolvePrincipal, routingTenantFor };
