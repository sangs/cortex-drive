'use strict';
/**
 * "Remove person" (S2-50 build 2b; design documents/security/offboarding-and-retention-design-2026-11-20.md §2, §5, §7).
 *
 * Two kinds, both previewed first (counts from a dry run), then confirmed:
 *   member        (E1) an owner or organization admin removes someone from THEIR organization. The scoped offboarding
 *                 routine runs for that organization with the remover as receiver (their content → the remover, as a
 *                 "Transferred from <name>" group), then the Clerk membership is deleted. The account stays.
 *   collaborator  (E3) anyone who shared removes an outside person: every share THEY gave that person is revoked
 *                 (exact Permify deletes) and the person leaves the groups THEY created. Nothing else changes.
 * The organization is always the caller's gateway-assigned tenant, never the request body (§7).
 */

const { TRIGGERS } = require('./offboarding');

class RemoveError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

const KINDS = Object.freeze({ MEMBER: 'member', COLLABORATOR: 'collaborator' });

/**
 * @param deps.offboarding   utils/offboarding.js instance (plan, apply, countsOf, isEmpty)
 * @param deps.isProtected   (userSub) => bool (owner accounts, trial id, non-Clerk ids)
 * @param deps.listOrgMembers (orgId) => [{ userId, relation }]  (Permify org relations)
 * @param deps.deleteClerkMembership (orgId, userSub) => Promise
 * @param deps.revokeAudienceAccess (audience, nodeIds) => failures (index.js, exact deletes)
 * @param deps.removeGroupMember (groupId, userSub) => Promise  (Permify, exact)
 */
function createRemovePerson({ db, redis, offboarding, isProtected, listOrgMembers, deleteClerkMembership,
                              revokeAudienceAccess, removeGroupMember, log = console }) {
    function check(caller, target) {
        if (!target || !/^user_[A-Za-z0-9]{10,60}$/.test(String(target))) throw new RemoveError(400, 'Unknown person');
        if (target === caller) throw new RemoveError(400, 'You cannot remove yourself');
        if (isProtected(target)) throw new RemoveError(403, 'This account cannot be removed');
    }

    // ── E1: remove a member from the caller's organization ─────────────────────────────────────────────────────────
    async function memberPlan(caller, orgId, target) {
        check(caller, target);
        if (!orgId) throw new RemoveError(400, 'No organization');
        const members = await listOrgMembers(orgId);
        if (!members.some(m => m.userId === target)) throw new RemoveError(404, 'Not a member of your organization');
        return offboarding.plan(target, { orgId, receiver: caller });
    }

    async function previewMember(caller, orgId, target) {
        const p = await memberPlan(caller, orgId, target);
        return { kind: KINDS.MEMBER, counts: offboarding.countsOf(p), contentTo: 'you' };
    }

    async function removeMember(caller, orgId, target) {
        const p = await memberPlan(caller, orgId, target);
        const result = offboarding.isEmpty(p) ? { skipped: true } : await offboarding.apply(p, { trigger: TRIGGERS.REMOVE_PERSON, actor: caller });
        // Clerk last: if it fails, the person has already lost access here and the next membership reconcile
        // (or a retry) removes the Clerk membership; access never outlives the click.
        await deleteClerkMembership(orgId, target);
        log.log(`[REMOVE-PERSON] member ${target} removed from ${orgId} by ${caller}`);
        return { kind: KINDS.MEMBER, counts: offboarding.countsOf(p), offboardingId: result.offboardingId || null };
    }

    // ── E3: remove an outside collaborator from what the caller shared ─────────────────────────────────────────────
    async function collaboratorPlan(caller, target) {
        check(caller, target);
        const { rows: assignments } = await db.query(
            `SELECT ra.assignment_id, ra.assignee_type, ra.assignee_id, sg.child_node_ids
               FROM role_assignments ra JOIN share_grants sg ON ra.resource_type = 'grant' AND ra.resource_id = sg.grant_id::text
              WHERE ra.assignee_type = 'user' AND ra.assignee_id = $1 AND ra.status = 'active'
                AND sg.issued_by = $2 AND sg.status = 'active'`, [target, caller]);
        const { rows: groups } = await db.query(
            `SELECT gm.group_id FROM group_members gm JOIN groups g ON g.group_id = gm.group_id
              WHERE gm.user_sub = $1 AND g.created_by = $2`, [target, caller]);
        return { assignments, groups };
    }

    async function previewCollaborator(caller, target) {
        const p = await collaboratorPlan(caller, target);
        return { kind: KINDS.COLLABORATOR, counts: { shares: p.assignments.length, groups: p.groups.length } };
    }

    async function removeCollaborator(caller, target) {
        const p = await collaboratorPlan(caller, target);
        for (const a of p.assignments) {
            const failures = await revokeAudienceAccess([a], a.child_node_ids || []);
            if (failures > 0) throw new RemoveError(502, 'Could not remove access in the authorization service; nothing was marked revoked. Please retry.');
            await db.query(`UPDATE role_assignments SET status = 'revoked', revoked_at = now(), revoked_by = $1 WHERE assignment_id = $2`,
                           [caller, a.assignment_id]);
        }
        for (const g of p.groups) {
            await removeGroupMember(g.group_id, target);
            await db.query('DELETE FROM group_members WHERE group_id = $1 AND user_sub = $2', [g.group_id, target]);
        }
        await redis.del(`perm:${target}`);
        log.log(`[REMOVE-PERSON] collaborator ${target} removed from ${caller}'s shares (${p.assignments.length}) and groups (${p.groups.length})`);
        return { kind: KINDS.COLLABORATOR, counts: { shares: p.assignments.length, groups: p.groups.length } };
    }

    return { previewMember, removeMember, previewCollaborator, removeCollaborator };
}

module.exports = { createRemovePerson, RemoveError, KINDS };
