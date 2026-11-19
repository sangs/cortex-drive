/**
 * S2-92 (2026-11-19): sign out and sign back in. Design:
 * documents/architecture/sign-out-and-sign-in-design-2026-11-18.md. Run: `npm test`.
 *
 * Behaviour checks on lib/session-state.ts (pure), plus source checks that every signed-in page
 * has the account menu, routes come from config, and the dashboard never restores another user's
 * chat and graph.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    AFTER_SIGN_OUT_URL, AUTH_ROUTES, PUBLIC_ROUTES, STORAGE_KEYS, USER_SESSION_STORAGE_KEYS,
    clearUserClientState, isPublicPath, ownedDashboardState, registerUserStateClearer, sessionTransition,
} from '../lib/session-state.ts';

let passed = 0;
const ok = (cond: unknown, msg: string) => { assert.ok(cond, msg); passed++; };
const eq = (a: unknown, b: unknown, msg: string) => { assert.deepEqual(a, b, msg); passed++; };
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ── Registry and routes ──────────────────────────────────────────────────────────────────────
ok(USER_SESSION_STORAGE_KEYS.includes('cortex_dashboard'), 'dashboard chat + graph key is registered');
ok(USER_SESSION_STORAGE_KEYS.includes('pending_activated'), 'pending-activation flag is registered');
eq(AFTER_SIGN_OUT_URL, '/sign-in?signed_out=1', 'after sign-out: the sign-in page with the note (owner decision)');
ok(PUBLIC_ROUTES.length > 0, 'public routes come from config');

// ── Clearing ─────────────────────────────────────────────────────────────────────────────────
const store = new Map<string, string>([['cortex_dashboard', '{}'], ['pending_activated', '1'], ['unrelated', 'x']]);
let extraCleared = 0;
registerUserStateClearer(() => { extraCleared++; });
registerUserStateClearer(() => { throw new Error('one failing clearer must not stop the rest'); });
clearUserClientState({ removeItem: (k: string) => { store.delete(k); } });
ok(!store.has('cortex_dashboard') && !store.has('pending_activated'), 'every registered key is removed');
ok(store.has('unrelated'), 'keys outside the registry are left alone');
eq(extraCleared, 1, 'registered in-memory caches are cleared too');
clearUserClientState(null);   // no storage (server render, blocked storage) is not an error
ok(true, 'clearing with no storage does not throw');

// ── Saved dashboard state belongs to one user ────────────────────────────────────────────────
const saved = { ownerUserId: 'user_A', messages: [1] };
eq(ownedDashboardState(saved, 'user_A'), saved, 'the owner gets their state back');
eq(ownedDashboardState(saved, 'user_B'), null, 'another user on the same tab gets nothing');
eq(ownedDashboardState({ messages: [1] }, 'user_A'), null, 'state with no owner (pre-S2-92) is not restored');
eq(ownedDashboardState(saved, null), null, 'nobody signed in: nothing restored');

// ── Session transitions (every way a session ends) ───────────────────────────────────────────
eq(sessionTransition('user_A', null, '/dashboard'), 'clear-and-redirect', 'sign-out on a protected page: clear and go to sign-in');
eq(sessionTransition('user_A', null, '/graph-view/abc'), 'clear', 'sign-out on a guest link page: clear, stay');
eq(sessionTransition(null, null, '/sign-in'), 'clear', 'signed out on load: clear');
eq(sessionTransition('user_A', 'user_B', '/dashboard'), 'clear-and-reload', 'a different user on the same tab: clear and reload');
eq(sessionTransition(null, 'user_A', '/dashboard'), 'none', 'first load signed in: keep state (reload survives)');
eq(sessionTransition('user_A', 'user_A', '/dashboard'), 'none', 'same user: nothing');

// ── Public paths match proxy.ts patterns ─────────────────────────────────────────────────────
ok(isPublicPath('/') && isPublicPath('/sign-in') && isPublicPath('/sign-in/factor-one'), 'landing and sign-in are public');
ok(isPublicPath('/graph-view/tok123'), 'guest graph links are public');
ok(!isPublicPath('/dashboard') && !isPublicPath('/settings/sharing') && !isPublicPath('/finops') && !isPublicPath('/admin'),
   'signed-in pages are protected');

// ── Wiring (source checks) ───────────────────────────────────────────────────────────────────
const layout = read('app/layout.tsx');
ok(/<SessionGuard \/>/.test(layout), 'SessionGuard is mounted once in the root layout');
ok(/afterSignOutUrl=\{AFTER_SIGN_OUT_URL\}/.test(layout) && /signInUrl=\{AUTH_ROUTES\.signIn\}/.test(layout),
   'ClerkProvider routes come from config');

const proxy = read('proxy.ts');
ok(/createRouteMatcher\(\[\.\.\.PUBLIC_ROUTES\]\)/.test(proxy), 'proxy.ts public routes come from config');
ok(!/"\/graph-view\(\.\*\)"/.test(proxy), 'no inline public route list in proxy.ts');

const guard = read('components/SessionGuard.tsx');
ok(/clearUserClientState\(\)/.test(guard) && /window\.location\.replace\(AFTER_SIGN_OUT_URL\)/.test(guard),
   'SessionGuard clears state and hard-navigates on sign-out');
ok(/useAuth\(\)/.test(guard) && !/onClick/.test(guard), 'SessionGuard watches the session, not a button');

const menu = read('components/AccountMenu.tsx');
ok(/signOut\(\{ redirectUrl: AFTER_SIGN_OUT_URL \}\)/.test(menu), 'Sign out ends the session and lands on sign-in');
ok(/<UserButton/.test(menu), 'Clerk account page (active devices) stays reachable');

for (const page of ['app/dashboard/page.tsx', 'app/settings/sharing/page.tsx', 'app/settings/groups/page.tsx',
                    'app/finops/page.tsx', 'app/admin/page.tsx']) {
    ok(/<AccountMenu[\s/>]/.test(read(page)), `${page} shows the account menu`);
}

const dash = read('app/dashboard/page.tsx');
ok(!/afterSignOutUrl=/.test(dash), 'deprecated UserButton afterSignOutUrl prop removed');
ok(!/Enterprise Tier/.test(dash), 'hard-coded tier label removed');
ok(!/'cortex_dashboard'|'pending_activated'/.test(dash), 'dashboard uses STORAGE_KEYS, not string literals');
ok(/ownerUserId: userId/.test(dash), 'saved dashboard state records its owner');
ok(/ownedDashboardState\(/.test(dash), 'restore checks the owner');
eq(STORAGE_KEYS.dashboard, 'cortex_dashboard', 'dashboard key unchanged (existing tabs keep working for the same user)');

const signIn = read('app/sign-in/[[...sign-in]]/page.tsx');
ok(/AUTH_ROUTES\.signedOutParam/.test(signIn) && /You have signed out/.test(signIn), 'sign-in page shows the signed-out note');
eq(AUTH_ROUTES.afterSignIn, '/dashboard', 'after sign-in fallback is the dashboard');

console.log(`verify_sign_out: ${passed} checks passed`);
