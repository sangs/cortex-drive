'use strict';
/**
 * Organization membership: Clerk → Permify (S2-46, 2026-10-28).
 *
 * Clerk is the single source of truth for who belongs to an organization. Permify `org#member` and
 * `org#admin` are derived from it and are written by nothing else:
 *   - the Clerk webhook (organizationMembership.created|updated|deleted) applies each change, and
 *   - scripts/reconcile_org_membership.js compares the two and fixes Permify (runs at every gateway
 *     deploy, and on demand), catching any webhook that was missed.
 * Design: documents/security/user-roles-and-access-model.md §2, §6.
 *
 * User ids go through identity.resolveUserId, so the owner's alias accounts map to OWNER_USER_ID,
 * the id every owner tuple in Permify is keyed on. Built from injected dependencies for unit tests.
 */
const { resolveUserId } = require('./identity');

const ORG_MEMBER_RELATION = 'member';
const ORG_ADMIN_RELATION = 'admin';
const CLERK_ADMIN_ROLES = new Set(['org:admin', 'admin']);

/** Permify relations a Clerk role implies. Every member gets `member`; admins also get `admin`. */
function relationsForRole(role) {
    return CLERK_ADMIN_ROLES.has(role) ? [ORG_MEMBER_RELATION, ORG_ADMIN_RELATION] : [ORG_MEMBER_RELATION];
}

/** { orgId, userId, role } from a Clerk organizationMembership webhook payload (snake_case). */
function membershipFromClerkEvent(data, env = process.env) {
    const orgId = data && data.organization && data.organization.id;
    const clerkSub = data && data.public_user_data && data.public_user_data.user_id;
    if (!orgId || !clerkSub) return null;
    return { orgId, userId: resolveUserId(clerkSub, env), clerkSub, role: data.role || '' };
}

const key = (relation, userId) => `${relation}|${userId}`;

/**
 * Desired tuples from Clerk memberships ([{ clerkSub, role }]) vs. the tuples Permify holds.
 * Returns { toWrite, toDelete }, each [{ relation, userId }]. Several Clerk accounts that map to
 * the same user (the owner's aliases) collapse to one, keeping the strongest role.
 */
function diffMembership(clerkMembers, permifyRelations, env = process.env) {
    const desired = new Map();
    for (const m of clerkMembers) {
        const userId = resolveUserId(m.clerkSub, env);
        if (!userId) continue;
        for (const relation of relationsForRole(m.role)) desired.set(key(relation, userId), { relation, userId });
    }
    const actual = new Map();
    for (const t of permifyRelations) {
        if (t.relation === ORG_MEMBER_RELATION || t.relation === ORG_ADMIN_RELATION) actual.set(key(t.relation, t.userId), t);
    }
    return {
        toWrite: [...desired].filter(([k]) => !actual.has(k)).map(([, v]) => v),
        toDelete: [...actual].filter(([k]) => !desired.has(k)).map(([, v]) => ({ relation: v.relation, userId: v.userId })),
    };
}

/**
 * permify: { writeOrgRelation, deleteOrgRelation, listOrgRelations }
 * clearUserCaches(userId, clerkSub): drops the user's cached permissions and tenant resolution.
 */
function createOrgMembershipSync({ permify, clearUserCaches = async () => {}, log = console }) {
    /** Make Permify match one Clerk membership (created or role changed). Throws on failure. */
    async function applyMembership({ orgId, userId, clerkSub, role }) {
        const wanted = new Set(relationsForRole(role));
        for (const relation of wanted) await permify.writeOrgRelation(orgId, relation, userId);
        if (!wanted.has(ORG_ADMIN_RELATION)) await permify.deleteOrgRelation(orgId, ORG_ADMIN_RELATION, userId);
        await clearUserCaches(userId, clerkSub);
        log.log(`[ORG-SYNC] ${userId} → org ${orgId} as ${[...wanted].join('+')}`);
    }

    /** Remove a user's org tuples (membership deleted). Throws on failure. */
    async function removeMembership({ orgId, userId, clerkSub }) {
        await permify.deleteOrgRelation(orgId, ORG_ADMIN_RELATION, userId);
        await permify.deleteOrgRelation(orgId, ORG_MEMBER_RELATION, userId);
        await clearUserCaches(userId, clerkSub);
        log.log(`[ORG-SYNC] ${userId} removed from org ${orgId}`);
    }

    /** Compare one org's Clerk memberships with Permify; fix Permify when apply is true. */
    async function reconcile({ orgId, clerkMembers, apply = false, env = process.env }) {
        const diff = diffMembership(clerkMembers, await permify.listOrgRelations(orgId), env);
        if (apply) {
            for (const t of diff.toWrite) await permify.writeOrgRelation(orgId, t.relation, t.userId);
            for (const t of diff.toDelete) await permify.deleteOrgRelation(orgId, t.relation, t.userId);
            for (const userId of new Set([...diff.toWrite, ...diff.toDelete].map(t => t.userId))) {
                await clearUserCaches(userId, null);
            }
        }
        return diff;
    }

    return { applyMembership, removeMembership, reconcile };
}

module.exports = {
    ORG_MEMBER_RELATION, ORG_ADMIN_RELATION, relationsForRole,
    membershipFromClerkEvent, diffMembership, createOrgMembershipSync,
};
