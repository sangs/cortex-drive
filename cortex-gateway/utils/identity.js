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
 *   - OWNER_CLERK_SUBS: comma-separated extra ids of the owner's own accounts (e.g. the dev Clerk id).
 * Everyone else keeps their real Clerk id.
 */

function ownerClerkSubs(env = process.env) {
    const subs = new Set(String(env.OWNER_CLERK_SUBS || '').split(',').map(s => s.trim()).filter(Boolean));
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

module.exports = { ownerClerkSubs, resolveUserId, isOwner };
