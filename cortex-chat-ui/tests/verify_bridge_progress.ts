/**
 * Bridge progress in the Bento panel (cross-domain discovery design 2026-11-09 §4.3, Phase 1b).
 * Run: `npm test` (node, TypeScript type stripping).
 *
 * - One call per offered domain in parallel; "auto" is resolved by the server (domain_filter), the
 *   browser holds no domain/type lists beyond list_bridge_domains.
 * - Live status line; skipped domains hidden; one combined chat summary.
 * - Nodes on screen are sent so the server does not offer them again; one Undo step per run.
 * The server side (domain share of the limit, "skipped", on-screen exclusion) is tested in
 * tests/mcp_server/test_bridges_v2.py.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bridgeCallDomains, bridgeProgressText, combineBridgeSummaries, bridgeDomainName } from '../utils/bridgeTypes.ts';

let passed = 0;
const ok = (cond: unknown, msg: string) => { assert.ok(cond, msg); passed++; };
const eq = (a: unknown, b: unknown, msg: string) => { assert.deepEqual(a, b, msg); passed++; };

const options = {
    auto: 'auto',
    domains: [
        { id: 'professional', display_name: 'Career', has_visible_content: true },
        { id: 'podcast', display_name: 'Podcast', has_visible_content: true },
        { id: 'website', display_name: 'Website', has_visible_content: false },
    ],
};

eq(bridgeCallDomains(['auto'], options), ['professional', 'podcast'], 'auto → every domain with visible content');
eq(bridgeCallDomains(['podcast'], options), ['podcast'], 'a named chip → that domain');
eq(bridgeCallDomains(['website'], options), ['website'], 'a named chip is kept even with nothing visible (server answers)');
eq(bridgeCallDomains(['unknown'], options), [], 'unknown ids dropped');
eq(bridgeCallDomains(['auto'], null), [], 'no options loaded → one call without a filter');
eq(bridgeDomainName('podcast', options), 'Podcast', 'display name from the server list');

eq(bridgeProgressText([
    { id: 'professional', name: 'Career', status: 'found', count: 3 },
    { id: 'podcast', name: 'Podcast', status: 'searching', count: 0 },
    { id: 'document', name: 'Document', status: 'skipped', count: 0 },
    { id: 'website', name: 'Website', status: 'none', count: 0 },
]), 'Career: 3 found · Podcast: searching… · Website: none', 'status line; skipped domains hidden');

eq(combineBridgeSummaries([
    { name: 'Career', summary: 'Found 2.', found: true },
    { name: 'Podcast', summary: 'No path found.', found: false },
]), '**Career:** Found 2.', 'summary lists only domains that found bridges');

const page = readFileSync(new URL('../app/dashboard/page.tsx', import.meta.url), 'utf8');
const handler = page.slice(page.indexOf('const handleDiscoverBridge'), page.indexOf('const handleShowMoreBridges'));
ok(/Promise\.all\(calls\.map/.test(handler), 'per-domain calls run in parallel');
ok(/domain_filter: \[domain\]/.test(handler), 'each call names its domain');
ok(/visible_node_ids: onScreen/.test(handler), 'nodes on screen are sent');
ok(/if \(!undoPushed\) \{\s*undoPushed = true;\s*pushUndo\(\);\s*setGraphData\(/.test(handler), 'one Undo step per run, taken right before the first merge');
ok(/setGraphData\(prev => parseDataToGraph\(result, prev\)\)/.test(handler), 'each domain merges into the latest graph');
ok(!/PODCAST|'podcast'|"podcast"/.test(handler), 'no domain names in the handler');
ok(/bridgeProgressText\(bridgeProgress\)/.test(page), 'status line rendered while bridges load');

console.log(`verify_bridge_progress: ${passed} checks passed`);
