'use strict';
/**
 * Reconcile organization membership: Clerk (source of truth) → Permify org#member / org#admin (S2-46).
 *
 *   node scripts/reconcile_org_membership.js            dry run: print the differences, change nothing
 *   node scripts/reconcile_org_membership.js --apply    make Permify match Clerk
 *
 * Covers every Clerk organization. Run by scripts/build-deploy-gateway.sh after each deploy (the
 * backstop for a missed webhook) and on demand. Exit code 1 on any error.
 * Env: CLERK_SECRET_KEY, PERMIFY_API_URL (+ PERMIFY_API_TOKEN outside Cloud Run), OWNER_USER_ID,
 * OWNER_CLERK_SUBS. Cached permissions expire on their own (perm:* 300 s, org_memberships:* 600 s);
 * the webhook path clears them immediately.
 */
const { createClerkClient } = require('@clerk/backend');
const permify = require('../utils/permify_gateway');
const { createOrgMembershipSync } = require('../utils/org_membership_sync');

const PAGE_SIZE = 100;

async function listAll(fetchPage) {
    const out = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
        const page = await fetchPage({ limit: PAGE_SIZE, offset });
        out.push(...(page.data || []));
        if (!page.data || page.data.length < PAGE_SIZE) return out;
    }
}

async function main() {
    const apply = process.argv.includes('--apply');
    for (const name of ['CLERK_SECRET_KEY', 'PERMIFY_API_URL', 'OWNER_USER_ID']) {
        if (!process.env[name]) throw new Error(`${name} is not set`);
    }
    const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
    const sync = createOrgMembershipSync({ permify, log: { log() {} } });
    const orgs = await listAll(p => clerk.organizations.getOrganizationList(p));
    let changes = 0;
    for (const org of orgs) {
        const members = await listAll(p => clerk.organizations.getOrganizationMembershipList({ organizationId: org.id, ...p }));
        const clerkMembers = members
            .filter(m => m.publicUserData && m.publicUserData.userId)
            .map(m => ({ clerkSub: m.publicUserData.userId, role: m.role }));
        const diff = await sync.reconcile({ orgId: org.id, clerkMembers, apply });
        changes += diff.toWrite.length + diff.toDelete.length;
        console.log(`[RECONCILE] org ${org.slug || org.id}: ${clerkMembers.length} Clerk member(s); ` +
                    `${diff.toWrite.length} to add, ${diff.toDelete.length} to remove${apply ? ' (applied)' : ' (dry run)'}`);
        for (const t of diff.toWrite) console.log(`  + org#${t.relation} ${t.userId}`);
        for (const t of diff.toDelete) console.log(`  - org#${t.relation} ${t.userId}`);
    }
    console.log(`[RECONCILE] ${orgs.length} organization(s), ${changes} difference(s)${apply ? ' fixed' : ''}`);
}

main().catch(err => { console.error('[RECONCILE] FAILED:', err.message); process.exit(1); });
