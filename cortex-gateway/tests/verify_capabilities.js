'use strict';
/**
 * S2-69 (2026-10-29): what each user type may do, served to the UI by GET /api/me/capabilities and
 * enforced by the same rules on the routes. Run: node tests/verify_capabilities.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { USER_TYPES } = require('../utils/identity');
const { capabilitiesFor, createCapabilityGuard } = require('../utils/capabilities');
const { createVisibilityGuard } = require('../utils/source_visibility');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); passed++; };

const OWNER_ID = 'user_owner';
const isOwner = id => id === OWNER_ID;
const PRINCIPALS = {
    owner:        { type: USER_TYPES.OWNER, isOwner: true, isOrgAdmin: true },
    org_admin:    { type: USER_TYPES.ORG_ADMIN, isOrgAdmin: true },
    org_member:   { type: USER_TYPES.ORG_MEMBER },
    collaborator: { type: USER_TYPES.COLLABORATOR },
    guest:        { type: USER_TYPES.GUEST, guest: true },
    trial:        { type: USER_TYPES.TRIAL },
    unknown:      { type: '' },
};

// ── 1. the roles doc §3 matrix ──────────────────────────────────────────────────────────────────
const EXPECTED = {   // addSource, visibilities, share, shareOrgWide, manageGroups, admin
    owner:        [true,  ['private', 'organization', 'public'], true,  true,  true,  true],
    org_admin:    [true,  ['private', 'organization'],           true,  true,  true,  true],
    org_member:   [true,  ['private'],                           true,  false, true,  false],
    collaborator: [false, [],                                    false, false, false, false],
    guest:        [false, [],                                    false, false, false, false],
    trial:        [false, [],                                    false, false, false, false],
    unknown:      [false, [],                                    false, false, false, false],
};
for (const [name, p] of Object.entries(PRINCIPALS)) {
    const c = capabilitiesFor(p);
    const [addSource, vis, share, orgWide, groups, admin] = EXPECTED[name];
    eq([c.addSource, c.sourceVisibilities, c.share, c.shareOrgWide, c.manageGroups, c.admin],
       [addSource, vis, share, orgWide, groups, admin], `${name}: capabilities match roles doc §3`);
}
eq(capabilitiesFor().addSource, false, 'no principal: nothing allowed (fail closed)');
eq(capabilitiesFor({ type: USER_TYPES.COLLABORATOR, isOrgAdmin: true }).admin, false,
   'a stray admin flag never lifts a collaborator');
eq(capabilitiesFor({ type: USER_TYPES.GUEST, isOwner: true }).addSource, false, 'guest is never a writer');

// ── 2. the list the UI shows == what the visibility guard accepts ───────────────────────────────
const headersFor = (name, p) => ({
    'x-user-type': p.type, 'x-user-id': p.isOwner ? OWNER_ID : `user_${name}`,
    ...(p.isOrgAdmin ? { 'x-schema-readable': 'true' } : {}),
});
const visGuard = createVisibilityGuard({ isOwner });
for (const [name, p] of Object.entries(PRINCIPALS)) {
    if (!capabilitiesFor(p).addSource) continue;
    for (const v of ['private', 'organization', 'public']) {
        let passedGuard = false, status = 200;
        visGuard({ headers: headersFor(name, p), body: { visibility: v } },
                 { status(s) { status = s; return { json() {} }; } }, () => { passedGuard = true; });
        eq(passedGuard, capabilitiesFor(p).sourceVisibilities.includes(v),
           `${name}/${v}: offered in the UI exactly when the server accepts it (status ${status})`);
    }
}

// ── 3. the route guard ──────────────────────────────────────────────────────────────────────────
const requireCapability = createCapabilityGuard(isOwner);
function run(capability, name) {
    const p = PRINCIPALS[name];
    const req = { headers: headersFor(name, p), method: 'POST', path: '/x', guestAuth: p.guest === true };
    let nextCalled = false, status = 0;
    const origWarn = console.warn; console.warn = () => {};
    requireCapability(capability, 'no')(req, { status(s) { status = s; return { json() {} }; } }, () => { nextCalled = true; });
    console.warn = origWarn;
    return nextCalled ? 200 : status;
}
eq(run('addSource', 'collaborator'), 403, 'collaborator: add source refused');
eq(run('addSource', 'guest'), 403, 'guest: add source refused');
eq(run('addSource', 'org_member'), 200, 'member: add source allowed');
eq(run('manageGroups', 'collaborator'), 403, 'collaborator: create group refused (roles doc §9 Q3, later)');
eq(run('shareOrgWide', 'org_member'), 403, 'member: organization-wide toggle refused');
eq(run('shareOrgWide', 'org_admin'), 200, 'admin: organization-wide toggle allowed');
eq(run('nonexistent', 'owner'), 403, 'unknown capability: refused');

// ── 4. index.js wiring ──────────────────────────────────────────────────────────────────────────
const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
ok(/app\.get\('\/api\/me\/capabilities', authMiddleware,/.test(src), 'capabilities endpoint is behind authMiddleware');
ok(/capabilitiesFor\(principalFromRequest\(req, isOwner\)\)/.test(src), 'endpoint uses the same rule as the guards');
ok(/app\.post\('\/api\/groups', authMiddleware, requireCapability\('manageGroups'/.test(src), 'group creation is gated');
ok(/app\.post\('\/api\/share\/tenant-wide', authMiddleware, requireCapability\('shareOrgWide'/.test(src), 'org-wide on is gated');
ok(/app\.delete\('\/api\/share\/tenant-wide', authMiddleware, requireCapability\('shareOrgWide'/.test(src), 'org-wide off is gated');
ok(!/SOURCE_WRITER_USER_TYPES = new Set/.test(src), 'no second copy of the source-writer list in index.js');

console.log(`verify_capabilities: ${passed} checks passed`);
