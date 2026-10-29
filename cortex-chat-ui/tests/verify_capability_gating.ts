/**
 * S2-69 (2026-10-29): the UI shows a control only when /api/me/capabilities allows it, and shows
 * nothing until it has answered (fail closed). Source checks; the gateway enforces the same rules
 * (cortex-gateway/tests/verify_capabilities.js). Run: `npm test`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0;
const ok = (cond: unknown, msg: string) => { assert.ok(cond, msg); passed++; };
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const hook = read('hooks/use-capabilities.ts');
ok(/useState<Capabilities>\(NO_CAPABILITIES\)/.test(hook), 'starts with no capabilities (fail closed while loading)');
ok(/if \(!resp\.ok\) return NO_CAPABILITIES/.test(hook), 'a failed call grants nothing');
ok(/addSource: false, sourceVisibilities: \[\], share: false, shareOrgWide: false, manageGroups: false, admin: false/.test(hook),
   'NO_CAPABILITIES is all false');

const dash = read('app/dashboard/page.tsx');
ok(/\{caps\.addSource && \(\s*<button\s*onClick=\{\(\) => setAddSourceModalOpen\(true\)\}/.test(dash), 'Add Source button needs addSource');
ok(/open=\{addSourceModalOpen && caps\.addSource\}/.test(dash), 'Add Source dialog cannot open without addSource');
ok(/allowedVisibilities=\{caps\.sourceVisibilities\}/.test(dash), 'visibility choices come from the capabilities');
ok(/graphData\.nodes\.length > 0 && caps\.share && \(/.test(dash), 'Share Graph needs share');
ok(/\{\(caps\.share \|\| caps\.manageGroups\) && \(\s*<Link href="\/settings\/sharing"/.test(dash), 'settings link needs share or groups');

const modal = read('components/AddSourceModal.tsx');
ok(/visibilityOptions\.map\(o => <option/.test(modal) && !/VISIBILITY_OPTIONS\.map\(o => <option/.test(modal),
   'Add Source lists only the allowed visibilities');

ok(/\{caps\.share && \(\s*<button\s*onClick=\{\(\) => setShareModalOpen\(true\)\}/.test(read('components/BentoDetailPanel.tsx')),
   'node Share button needs share');
ok(/\{caps\.shareOrgWide && \(\s*<div/.test(read('components/ShareModal.tsx')), 'org-wide toggle needs shareOrgWide');

console.log(`verify_capability_gating: ${passed} checks passed`);
