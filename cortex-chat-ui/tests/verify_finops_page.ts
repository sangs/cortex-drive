/**
 * Owner-only /finops page (FinOps S2-83 release 4). Source checks: the page asks the gateway (which answers 404 to
 * everyone but the owner) and turns that 404 into the page's own not-found; it never decides access itself.
 * Run: `npm test`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0;
const ok = (cond: unknown, msg: string) => { assert.ok(cond, msg); passed++; };
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const page = read('app/finops/page.tsx');
ok(/\$\{GATEWAY_URL\}\/api\/finops\/summary/.test(page), 'reads the gateway summary at the configured gateway address');
ok(/Authorization: `Bearer \$\{token\}`/.test(page), 'sends the signed-in user\'s Clerk token');
ok(/if \(res\.status === 404\) \{ setMissing\(true\); return; \}/.test(page), 'gateway 404 → page not found');
ok(/if \(missing\) notFound\(\);/.test(page), 'not found never reveals the page');
ok(/if \(!token\) \{ setMissing\(true\); return; \}/.test(page), 'no token → not found');
ok(/cache: 'no-store'/.test(page), 'never cached by the browser');
ok(!/isOwner|OWNER_USER_ID|user_type/.test(page), 'the page does not decide who is the owner');

const types = read('lib/finops-types.ts');
ok(/@finops-admin\/contract/.test(types), 'types marked as a local copy of finops-admin\'s contract (RV-14)');
ok(/threshold: number \| null/.test(types), 'record only: threshold may be null');

const chart = read('components/FinopsDailyChart.tsx');
ok(/providerColor\(p\.provider\)/.test(chart), 'colour by provider, never by rank');

const proxy = read('proxy.ts');
ok(!/"\/finops/.test(proxy), '/finops is not a public route (Clerk sign-in required)');

console.log(`verify_finops_page: ${passed} checks passed`);
