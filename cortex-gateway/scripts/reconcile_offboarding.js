'use strict';
/**
 * Orphan sweep (S2-50): finds people whose Clerk account no longer exists but who still hold access, content,
 * invitations, links or history, and offboards them with the same routine as the user.deleted webhook
 * (utils/offboarding.js). Design: documents/security/offboarding-and-retention-design-2026-11-20.md §5, §11.
 *
 *   node scripts/reconcile_offboarding.js            dry run: print what each departed person still holds
 *   node scripts/reconcile_offboarding.js --apply    offboard them
 *   ... --apply --force                              allow more than sweep.max_people_per_run (config) at once
 *
 * Run by scripts/build-deploy-gateway.sh after each deploy (the backstop for a missed or failed webhook) and on demand.
 * Where ids come from: Cloud SQL (every column that holds a user id), Neo4j owner_id (Bento /owner_ids) and Permify
 * org#member/admin of every Clerk organization. Each id is checked with Clerk one by one: only a 404 counts as
 * gone; any other error leaves the person alone. Before anything, the platform owner must exist in this Clerk
 * instance (a wrong or dev key would make everyone look deleted). Prints ids and counts only, never emails.
 *
 * Env: CLERK_SECRET_KEY, PERMIFY_API_URL + PERMIFY_API_TOKEN, OWNER_USER_ID, OWNER_CLERK_SUBS, TENANT_ID,
 * DB_HOST/DB_PORT/DB_USER/DB_PASSWORD (Cloud SQL Auth Proxy), REDIS_URL, BENTO_SERVER_URL + BENTO_ID_TOKEN.
 * Exit code 1 on any error or refusal.
 */
const { createClerkClient } = require('@clerk/backend');
const Redis = require('ioredis');
const permify = require('../utils/permify_gateway');
const db = require('../utils/db');
const { createShareLinks } = require('../utils/share_links');
const { createOffboarding, personFromClerkUser, isProtected, TRIGGERS, CONFIG } = require('../utils/offboarding');
const { getCloudRunToken } = require('../utils/cloud_run_token');

const PAGE_SIZE = 100;
const REQUIRED_ENV = ['CLERK_SECRET_KEY', 'PERMIFY_API_URL', 'OWNER_USER_ID', 'TENANT_ID', 'REDIS_URL', 'BENTO_SERVER_URL'];

async function listAll(fetchPage) {
    const out = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
        const page = await fetchPage({ limit: PAGE_SIZE, offset });
        out.push(...(page.data || []));
        if (!page.data || page.data.length < PAGE_SIZE) return out;
    }
}

async function bentoPost(path, body) {
    const base = process.env.BENTO_SERVER_URL.replace(/\/$/, '');
    // Operator runs pass BENTO_ID_TOKEN; the daily job (Cloud Run) fetches one from its service account.
    const auth = process.env.BENTO_ID_TOKEN ? `Bearer ${process.env.BENTO_ID_TOKEN}` : await getCloudRunToken(base);
    const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': process.env.TENANT_ID,
                   ...(auth ? { Authorization: auth } : {}) },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Bento ${path} → ${res.status}`);
    return res.json();
}

/** Every user id the data stores mention (Cloud SQL, Neo4j owner_id, Permify org relations). */
async function candidateIds(clerk) {
    const { rows } = await db.query(`
        SELECT user_sub AS id FROM conversations
        UNION SELECT user_sub FROM group_members
        UNION SELECT assignee_id FROM role_assignments WHERE assignee_type = 'user' AND status = 'active'
        UNION SELECT issued_by FROM share_grants WHERE status = 'active'
        UNION SELECT owner_sub FROM share_links WHERE revoked_at IS NULL
        UNION SELECT created_by FROM groups
        UNION SELECT invited_by FROM invitations WHERE status = 'pending'
        UNION SELECT user_sub FROM people_directory`);
    const ids = new Set(rows.map(r => r.id).filter(Boolean));
    for (const id of (await bentoPost('/owner_ids', {})).owner_ids || []) ids.add(id);
    const orgs = await listAll(p => clerk.organizations.getOrganizationList(p));
    for (const org of orgs) for (const r of await permify.listOrgRelations(org.id)) ids.add(r.userId);
    return [...ids].sort();
}

/** 'alive' (with the Clerk user), 'gone' (404), or 'unknown' (any other error: leave the person alone). */
async function clerkState(clerk, id) {
    try {
        return { state: 'alive', user: await clerk.users.getUser(id) };
    } catch (err) {
        const status = err && (err.status || (err.errors && err.errors[0] && err.errors[0].status));
        return { state: status === 404 ? 'gone' : 'unknown', error: err.message };
    }
}

async function main() {
    const apply = process.argv.includes('--apply');
    const force = process.argv.includes('--force');
    for (const name of REQUIRED_ENV) if (!process.env[name]) throw new Error(`${name} is not set`);

    const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
    const owner = await clerkState(clerk, process.env.OWNER_USER_ID);
    if (owner.state !== 'alive') {
        throw new Error('the platform owner is not found in this Clerk instance (wrong key or Clerk unavailable); refusing');
    }
    const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
    try {
        const shareLinks = createShareLinks({ db, permify, redis, secret: '', log: { log() {}, error() {} } });
        const offboarding = createOffboarding({
            db, permify, redis,
            bento: {
                ownedNodes: async (ownerId, extra) => (await bentoPost('/owned_nodes', { owner_id: ownerId, extra_node_ids: extra })).nodes,
                transferOwner: async (fromSub, transfers) => (await bentoPost('/transfer_owner', { from_sub: fromSub, transfers })).changed,
                nodeTenants: async nodeIds => (await bentoPost('/node_tenants', { node_ids: nodeIds })).tenants,
            },
            revokeLink: (linkId, ownerSub) => shareLinks.revokeLink(linkId, ownerSub),
            log: { log: m => console.log(m), error: m => console.error(m) },
        });

        const all = await candidateIds(clerk);
        const ids = all.filter(id => !isProtected(id));
        const gone = [];
        let alive = 0, unknown = 0;
        for (const id of ids) {
            const s = await clerkState(clerk, id);
            if (s.state === 'alive') { alive += 1; await offboarding.upsertPerson(personFromClerkUser(s.user)); }
            else if (s.state === 'gone') gone.push(id);
            else { unknown += 1; console.log(`[OFFBOARD-SWEEP] ? ${id}: Clerk lookup failed (${s.error}); left alone`); }
        }

        const plans = [];
        for (const id of gone) {
            const p = await offboarding.plan(id);
            const waiting = offboarding.awaitingSteward(p);
            if (waiting) console.log(`[OFFBOARD-SWEEP] … ${id}: ${waiting} node(s) wait for a steward (config/offboarding.json stewards)`);
            if (offboarding.isEmpty(p)) continue;
            plans.push(p);
            const c = offboarding.countsOf(p);
            const held = Object.entries(c).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ');
            console.log(`[OFFBOARD-SWEEP] - ${id}: ${held}`);
        }
        console.log(`[OFFBOARD-SWEEP] ${all.length} id(s) found, ${all.length - ids.length} protected, ${alive} still in Clerk, ` +
                    `${unknown} unknown, ${gone.length} gone, ${plans.length} with something left${apply ? '' : ' (dry run)'}`);

        if (!apply || !plans.length) return;
        if (plans.length > CONFIG.sweep.max_people_per_run && !force) {
            throw new Error(`${plans.length} people to offboard exceeds sweep.max_people_per_run (${CONFIG.sweep.max_people_per_run}); ` +
                            'check Clerk, then rerun with --force');
        }
        for (const p of plans) {
            const r = await offboarding.apply(p, { trigger: TRIGGERS.SWEEP });
            console.log(`[OFFBOARD-SWEEP] ✓ ${p.userSub} offboarded (${r.offboardingId})`);
        }
    } finally {
        redis.disconnect();
    }
}

main().then(() => process.exit(0)).catch(err => { console.error('[OFFBOARD-SWEEP] FAILED:', err.message); process.exit(1); });
