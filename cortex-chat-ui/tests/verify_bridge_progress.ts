/**
 * Bridge progress in the Bento panel (cross-domain discovery design 2026-11-09 §4.3, Phase 1b).
 * Run: `npm test` (node, TypeScript type stripping).
 *
 * - One streamed request (gateway /api/bridges/stream, step 4c); the server picks the domains and fans out.
 * - Live status line; skipped domains hidden; one combined chat summary.
 * - Nodes on screen are sent so the server does not offer them again; one Undo step per run.
 * The server side (domain share of the limit, "skipped", on-screen exclusion) is tested in
 * tests/mcp_server/test_bridges_v2.py.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bridgeProgressText, combineBridgeSummaries, bridgeDomainName } from '../utils/bridgeTypes.ts';

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
const handler = page.slice(page.indexOf('const handleDiscoverBridge'), page.indexOf('// Clarifying question (routing v2'));
ok(/await streamBridges\(\{/.test(handler), 'one streamed request (step 4c), not one call per domain');
ok(!/Promise\.all\(/.test(handler) && !/domain_filter/.test(handler), 'no per-domain calls from the browser');
ok(/visible_node_ids: onScreen/.test(handler), 'nodes on screen are sent');
ok(/if \(!undoPushed\) \{\s*undoPushed = true;\s*pushUndo\(\);\s*setGraphData\(/.test(handler), 'one Undo step per run, taken right before the first merge');
ok(/e\.type === 'partial'[\s\S]{0,400}setGraphData\(prev => parseDataToGraph\(e\.result, prev\)\)/.test(handler), 'each domain merged as it arrives');
ok(!/PODCAST|'podcast'|"podcast"/.test(handler), 'no domain names in the handler');
ok(/bridgeProgressText\(bridgeProgress\)/.test(page), 'status line rendered while bridges load');
const client = readFileSync(new URL('../lib/mcp-client.ts', import.meta.url), 'utf8');
ok(/\/api\/bridges\/stream/.test(client) && /readEventStream\(response\.body, onEvent\)/.test(client), 'client reads the bridge stream');

console.log(`verify_bridge_progress: ${passed} checks passed`);
