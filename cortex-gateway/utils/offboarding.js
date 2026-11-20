'use strict';
/**
 * Offboarding a person whose Clerk account is gone (S2-50, 2026-11-20).
 * Design: documents/security/offboarding-and-retention-design-2026-11-20.md (decisions D1–D8, §4 order, §11 build 1).
 *
 * Two callers, one routine:
 *   - the Clerk webhook `user.deleted` (real time; a failure answers 500 so Clerk retries), and
 *   - scripts/reconcile_offboarding.js, the orphan sweep (after every gateway deploy, and on demand), which finds ids
 *     in Permify / Neo4j / Cloud SQL that no longer exist in Clerk.
 *
 * plan(userSub) is read-only and says what would change; apply(plan) makes the changes in the design's order:
 *   1. access: every Permify tuple naming the person (except node ownership, moved in step 4), received shares
 *      marked revoked, group memberships removed                                               (D6)
 *   2. invitations they sent and invitations to their email cancelled                          (D3, D4)
 *   3. links they created revoked                                                              (D4)
 *   4. content moved to the organization's steward, with the person's name kept on each node and one
 *      content_transfers row per organization = the steward's separate "Transferred from <name>" group (D2, D5, D7)
 *   5. history: personal-scope conversations deleted, organization-scope conversations soft-deleted (D1)
 *   6. caches cleared, directory row removed, one offboarding_log row (D8)
 * Each step re-reads current state, so a second run finds nothing to do (plan.empty) and writes nothing.
 * Built from injected dependencies for unit tests (tests/verify_offboarding.js).
 */
const crypto = require('crypto');
const CONFIG = require('../config/offboarding.json');
const { ownerClerkSubs, PERSONAL_SCOPE_PREFIX } = require('./identity');

const TRIGGERS = Object.freeze({ USER_DELETED: 'user_deleted', SWEEP: 'sweep' });
const OFFBOARDING_ACTOR = 'offboarding';
const ID_PATTERN = new RegExp(CONFIG.clerk_user_id_pattern);
const ORG_ID_PREFIX = 'org_';   // Clerk organization ids

/** { userSub, displayName, email } from a Clerk user (SDK camelCase or webhook snake_case). */
function personFromClerkUser(u) {
    if (!u || !u.id) return null;
    const first = u.firstName ?? u.first_name ?? '';
    const last = u.lastName ?? u.last_name ?? '';
    const emails = u.emailAddresses ?? u.email_addresses ?? [];
    const primaryId = u.primaryEmailAddressId ?? u.primary_email_address_id;
    const primary = emails.find(e => e.id === primaryId) || emails[0];
    const email = primary ? (primary.emailAddress ?? primary.email_address ?? null) : null;
    const displayName = `${first || ''} ${last || ''}`.trim() || null;
    return { userSub: u.id, displayName, email };
}

/** Ids that must never be offboarded: the platform owner's accounts, the trial identity, anything not a Clerk user id. */
function isProtected(userSub, env = process.env) {
    if (!userSub || !ID_PATTERN.test(userSub)) return true;
    if (ownerClerkSubs(env).has(userSub)) return true;
    return CONFIG.never_offboard_env.some(name => env[name] && env[name] === userSub);
}

/** The steward who receives an organization's content (D2), or null when none is set. */
function stewardFor(orgId, env = process.env) {
    if (!orgId) return null;
    const isPlatformOrg = env.TENANT_ID && orgId === env.TENANT_ID;
    const raw = isPlatformOrg ? CONFIG.stewards.platform_org
        : (Object.prototype.hasOwnProperty.call(CONFIG.stewards, orgId) && orgId.startsWith(ORG_ID_PREFIX) ? CONFIG.stewards[orgId] : null);
    if (raw === 'platform_owner') return env.OWNER_USER_ID || null;
    return typeof raw === 'string' && ID_PATTERN.test(raw) ? raw : null;   // anything else (a comment, a typo) is no steward
}

/** Who the content came from: the directory name, else "a former user (user_3GHk…)". */
function formerOwnerName(name, userSub) {
    return name || CONFIG.unknown_person_label.replace('{short_id}', `${String(userSub).slice(0, 12)}…`);
}

/** The steward's group heading for one transfer (D2): "Transferred from <name>". */
function transferLabel(fromDisplayName) {
    return CONFIG.transfer_label.replace('{name}', fromDisplayName);
}

/**
 * db: { query }, permify: { listSubjectTuples, deleteUserTuple, writeNodeOwner },
 * redis: { del, incr }, bento: { ownedNodes(ownerId, extraNodeIds), transferOwner(fromSub, transfers) },
 * revokeLink(linkId, ownerSub)
 */
function createOffboarding({ db, permify, redis, bento, revokeLink, env = process.env, log = console }) {
    const personal = PERSONAL_SCOPE_PREFIX;
    const ownerRelation = CONFIG.node_owner_relation;

    async function upsertPerson(person) {
        if (!person || !person.userSub) return;
        await db.query(
            `INSERT INTO people_directory (user_sub, display_name, email, updated_at) VALUES ($1, $2, $3, now())
             ON CONFLICT (user_sub) DO UPDATE SET display_name = EXCLUDED.display_name, email = EXCLUDED.email, updated_at = now()`,
            [person.userSub, person.displayName, person.email]);
    }

    /** What offboarding this person would change. Read-only. */
    async function plan(userSub) {
        const tuples = await permify.listSubjectTuples(userSub, CONFIG.permify_subject_entity_types);
        const accessTuples = tuples.filter(t => !(t.entityType === 'node' && t.relation === ownerRelation));
        const ownerTupleNodeIds = tuples.filter(t => t.entityType === 'node' && t.relation === ownerRelation).map(t => t.entityId);
        const owned = await bento.ownedNodes(userSub, ownerTupleNodeIds);

        const q = async (sql, args) => (await db.query(sql, args)).rows;
        const [person] = await q('SELECT display_name, email FROM people_directory WHERE user_sub = $1', [userSub]);
        const emailRows = await q(
            `SELECT DISTINCT lower(e) AS email FROM (
                 SELECT email AS e FROM people_directory WHERE user_sub = $1
                 UNION SELECT email FROM group_members WHERE user_sub = $1
                 UNION SELECT assignee_email FROM role_assignments WHERE assignee_type = 'user' AND assignee_id = $1) x
             WHERE e IS NOT NULL AND e <> ''`, [userSub]);
        const emails = emailRows.map(r => r.email);

        return {
            userSub,
            name: (person && (person.display_name || person.email)) || null,
            accessTuples,
            ownerTupleNodeIds,
            ownedNodes: owned,
            receivedShares: await q(`SELECT assignment_id FROM role_assignments
                                     WHERE assignee_type = 'user' AND assignee_id = $1 AND status = 'active'`, [userSub]),
            groupMemberships: await q('SELECT group_id FROM group_members WHERE user_sub = $1', [userSub]),
            invitationsSent: await q(`SELECT invitation_id FROM invitations WHERE invited_by = $1 AND status = 'pending'`, [userSub]),
            invitationsToThem: emails.length ? await q(
                `SELECT invitation_id FROM invitations WHERE lower(invited_email) = ANY($1) AND status = 'pending'`, [emails]) : [],
            links: await q('SELECT link_id FROM share_links WHERE owner_sub = $1 AND revoked_at IS NULL', [userSub]),
            grantsIssued: await q(`SELECT grant_id, root_node_id FROM share_grants WHERE issued_by = $1 AND status = 'active'`, [userSub]),
            groupsCreated: await q('SELECT group_id, org_id FROM groups WHERE created_by = $1', [userSub]),
            personalConversations: await q(`SELECT conversation_id FROM conversations WHERE user_sub = $1 AND org_id LIKE $2`,
                                           [userSub, `${personal}%`]),
            orgConversations: await q(`SELECT conversation_id, org_id FROM conversations
                                       WHERE user_sub = $1 AND org_id NOT LIKE $2 AND status = 'active'`, [userSub, `${personal}%`]),
            directoryRow: Boolean(person),
        };
    }

    /**
     * What this run can act on. Content in an organization with no steward can't move (D2); it is reported as
     * `awaiting_steward` and doesn't count, so the sweep doesn't re-run (and re-log) for it until a steward is set.
     */
    function countsOf(p) {
        const nodeTenant = new Map(p.ownedNodes.map(n => [n.node_id, n.tenant_id]));
        const movable = n => Boolean(stewardFor(n.tenant_id, env));
        const ownerTupleActionable = id => !nodeTenant.has(id) || Boolean(stewardFor(nodeTenant.get(id), env));
        return {
            access_tuples: p.accessTuples.length,
            owner_tuples: p.ownerTupleNodeIds.filter(ownerTupleActionable).length,
            owned_nodes: p.ownedNodes.filter(movable).length,
            received_shares: p.receivedShares.length, group_memberships: p.groupMemberships.length,
            invitations_sent: p.invitationsSent.length, invitations_to_them: p.invitationsToThem.length, links: p.links.length,
            grants_issued: p.grantsIssued.filter(g => nodeTenant.has(g.root_node_id) && stewardFor(nodeTenant.get(g.root_node_id), env)).length,
            groups_created: p.groupsCreated.filter(g => stewardFor(g.org_id, env)).length,
            personal_conversations: p.personalConversations.length, org_conversations: p.orgConversations.length,
        };
    }

    /** Owned nodes that stay with the departed person because their organization has no steward. */
    function awaitingSteward(p) {
        return p.ownedNodes.filter(n => !stewardFor(n.tenant_id, env)).length;
    }

    /** True when there is nothing left to do (the directory row alone doesn't count). */
    function isEmpty(p) {
        return Object.values(countsOf(p)).every(n => n === 0);
    }

    /** Make the changes. Writes one offboarding_log row (completed or failed); rethrows on failure. */
    async function apply(p, { trigger, actor = null } = {}) {
        const offboardingId = crypto.randomUUID();
        const done = { planned: countsOf(p), transferred: {}, awaiting_steward: 0, kept_shares: 0 };   // awaiting_steward counted below
        const tenantsTouched = new Set();
        const transfers = [];
        const startedAt = new Date();
        try {
            // 1. Access (D6).
            for (const t of p.accessTuples) await permify.deleteUserTuple(t.entityType, t.entityId, t.relation, p.userSub);
            if (p.receivedShares.length) {
                await db.query(`UPDATE role_assignments SET status = 'revoked', revoked_at = now(), revoked_by = $2
                                WHERE assignee_type = 'user' AND assignee_id = $1 AND status = 'active'`, [p.userSub, OFFBOARDING_ACTOR]);
            }
            if (p.groupMemberships.length) await db.query('DELETE FROM group_members WHERE user_sub = $1', [p.userSub]);

            // 2. Invitations (D3, D4).
            const invitationIds = [...p.invitationsSent, ...p.invitationsToThem].map(r => r.invitation_id);
            if (invitationIds.length) {
                await db.query(`UPDATE invitations SET status = 'cancelled' WHERE invitation_id = ANY($1) AND status = 'pending'`,
                               [invitationIds]);
            }

            // 3. Links they created (D4).
            for (const l of p.links) await revokeLink(l.link_id, p.userSub);

            // 4. Content → the organization's steward (D2, D5, D7).
            const byTenant = new Map();
            for (const n of p.ownedNodes) {
                if (!byTenant.has(n.tenant_id)) byTenant.set(n.tenant_id, []);
                byTenant.get(n.tenant_id).push(n.node_id);
            }
            const transferredNodes = new Set();
            const stewardOfNode = new Map();
            for (const [tenantId, nodeIds] of byTenant) {
                const steward = stewardFor(tenantId, env);
                if (!steward) { done.awaiting_steward += nodeIds.length; continue; }
                transfers.push({ tenant_id: tenantId, to_sub: steward, transfer_id: crypto.randomUUID(),
                                 from_name: formerOwnerName(p.name, p.userSub), node_ids: nodeIds });
            }
            if (transfers.length) {
                const changed = await bento.transferOwner(p.userSub, transfers);
                for (const t of transfers) {
                    const moved = changed[t.tenant_id] || [];
                    t.moved = moved;
                    done.transferred[t.tenant_id] = moved.length;
                    tenantsTouched.add(t.tenant_id);
                    for (const nodeId of t.node_ids) { transferredNodes.add(nodeId); stewardOfNode.set(nodeId, t.to_sub); }
                }
            }
            const ownerTuples = new Set(p.ownerTupleNodeIds);
            const knownNodes = new Set(p.ownedNodes.map(n => n.node_id));
            for (const nodeId of transferredNodes) {
                await permify.writeNodeOwner(nodeId, stewardOfNode.get(nodeId));
                if (ownerTuples.has(nodeId)) await permify.deleteUserTuple('node', nodeId, ownerRelation, p.userSub);
            }
            // Owner tuples on nodes that no longer exist in the graph: nothing to transfer, so remove them.
            for (const nodeId of p.ownerTupleNodeIds) {
                if (!knownNodes.has(nodeId)) await permify.deleteUserTuple('node', nodeId, ownerRelation, p.userSub);
            }
            for (const g of p.grantsIssued) {
                const steward = stewardOfNode.get(g.root_node_id);
                if (!steward) continue;
                await db.query('UPDATE share_grants SET issued_by = $1 WHERE grant_id = $2', [steward, g.grant_id]);
                await db.query(`UPDATE role_assignments SET assigned_by = $1
                                WHERE resource_type = 'grant' AND resource_id = $2 AND assigned_by = $3`,
                               [steward, String(g.grant_id), p.userSub]);
                done.kept_shares += 1;
            }
            for (const g of p.groupsCreated) {
                const steward = stewardFor(g.org_id, env);
                if (steward) await db.query('UPDATE groups SET created_by = $1 WHERE group_id = $2', [steward, g.group_id]);
            }

            // 5. History (D1).
            if (p.personalConversations.length) {
                await db.query('DELETE FROM conversations WHERE user_sub = $1 AND org_id LIKE $2', [p.userSub, `${personal}%`]);
            }
            if (p.orgConversations.length) {
                await db.query(`UPDATE conversations SET status = 'deleted', deleted_at = now()
                                WHERE user_sub = $1 AND org_id NOT LIKE $2 AND status = 'active'`, [p.userSub, `${personal}%`]);
                p.orgConversations.forEach(c => tenantsTouched.add(c.org_id));
            }

            // 6. Caches, directory, record (D8).
            p.groupsCreated.forEach(g => tenantsTouched.add(g.org_id));
            if (env.TENANT_ID) tenantsTouched.add(env.TENANT_ID);
            const stewards = new Set(transfers.map(t => t.to_sub));
            await redis.del(`perm:${p.userSub}`, `org_memberships:${p.userSub}`, ...[...stewards].map(s => `perm:${s}`));
            for (const tenantId of tenantsTouched) {
                await redis.incr(`perm_version:${tenantId}`);
                await redis.incr(`entcat_version:${tenantId}`);
            }
            await db.query('DELETE FROM people_directory WHERE user_sub = $1', [p.userSub]);
            await db.query(`INSERT INTO offboarding_log (offboarding_id, user_sub, trigger, actor, status, counts, started_at, finished_at)
                            VALUES ($1, $2, $3, $4, 'completed', $5, $6, now())`,
                           [offboardingId, p.userSub, trigger, actor, JSON.stringify(done), startedAt]);
            for (const t of transfers) {
                if (!t.moved || !t.moved.length) continue;
                await db.query(`INSERT INTO content_transfers (transfer_id, offboarding_id, from_sub, from_display_name, to_sub, org_id, node_ids)
                                VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                               [t.transfer_id, offboardingId, p.userSub, t.from_name, t.to_sub, t.tenant_id, t.moved]);
            }
            log.log(`[OFFBOARD] ${p.userSub} (${trigger}) completed: ${JSON.stringify(done)}`);
            return { offboardingId, ...done };
        } catch (err) {
            log.error(`[OFFBOARD] ${p.userSub} (${trigger}) failed: ${err.message}`);
            await db.query(`INSERT INTO offboarding_log (offboarding_id, user_sub, trigger, actor, status, counts, error, started_at, finished_at)
                            VALUES ($1, $2, $3, $4, 'failed', $5, $6, $7, now())`,
                           [offboardingId, p.userSub, trigger, actor, JSON.stringify(done), String(err.message).slice(0, 500), startedAt])
                .catch(e => log.error('[OFFBOARD] could not record the failure:', e.message));
            throw err;
        }
    }

    /** Plan, then apply unless empty. Refuses protected ids. Returns { skipped, reason } or apply()'s result. */
    async function offboard(userSub, { trigger, actor = null } = {}) {
        if (isProtected(userSub, env)) return { skipped: true, reason: 'protected' };
        const p = await plan(userSub);
        if (isEmpty(p)) {
            if (p.directoryRow) await db.query('DELETE FROM people_directory WHERE user_sub = $1', [userSub]);
            return { skipped: true, reason: 'nothing_to_do' };
        }
        return apply(p, { trigger, actor });
    }

    return { upsertPerson, plan, apply, offboard, countsOf, isEmpty, awaitingSteward };
}

module.exports = { createOffboarding, personFromClerkUser, isProtected, stewardFor, formerOwnerName, transferLabel, TRIGGERS, CONFIG };
