/**
 * Bento panel layouts (design bridge-discovery-and-bento-panel-design-2026-11-03.md §4.2).
 * Run: `npm test` (node, TypeScript type stripping).
 *
 * - The panel draws the server's `panel_layout`; it holds no node-type lists and never reads the chat's
 *   domain (an episode opened during a career conversation keeps the podcast layout).
 * - Hydration keeps `panel_layout` and `outline`; malformed values are dropped.
 * - Consecutive half-width sections are paired side by side.
 * The server side (layout per node type, section ids equal to the panel's renderers) is tested in
 * tests/mcp_server/test_panel_layout.py.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { groupHalfSections, panelDetailFields } from '../utils/graphConstants.ts';

let passed = 0;
const ok = (cond: unknown, msg: string) => { assert.ok(cond, msg); passed++; };
const eq = (a: unknown, b: unknown, msg: string) => { assert.deepEqual(a, b, msg); passed++; };

// Pairing half-width sections
const ids = (groups: { id: string }[][]) => groups.map(g => g.map(s => s.id));
eq(ids(groupHalfSections([
    { id: 'description', title: '' }, { id: 'people', title: '', width: 'half' }, { id: 'published', title: '', width: 'half' },
    { id: 'topics', title: '' },
])), [['description'], ['people', 'published'], ['topics']], 'two halves side by side');
eq(ids(groupHalfSections([
    { id: 'a', title: '', width: 'half' }, { id: 'b', title: '', width: 'half' }, { id: 'c', title: '', width: 'half' },
])), [['a', 'b'], ['c']], 'three halves: a pair, then one alone');

// Hydration keeps the layout and the outline; malformed ones are dropped
const layout = { sections: [{ id: 'description', title: 'Summary' }], primary_action: 'Open Resource', layout: 'default' };
const outline = { sections: [{ title: '1 Introduction', page_start: 1 }], total: 36 };
eq(panelDetailFields({ panel_layout: layout, outline }), { panel_layout: layout, outline }, 'layout and outline kept');
eq(panelDetailFields({ panel_layout: { sections: 'x' }, outline: 'y' }), {}, 'malformed layout/outline dropped');

// The panel picks no layout by type or chat domain
const panel = readFileSync(new URL('../components/BentoDetailPanel.tsx', import.meta.url), 'utf8');
ok(!panel.includes('PODCAST_DOMAIN_TYPES'), 'no podcast type list');
ok(!/domainSignal/.test(panel), 'no chat-domain input');
ok(!/node\.type\s*[!=]==/.test(panel), 'no branch on the node type');
ok(panel.includes('node.panel_layout'), 'draws the server layout');
const dashboard = readFileSync(new URL('../app/dashboard/page.tsx', import.meta.url), 'utf8');
ok(!/BentoDetailPanel[\s\S]{0,600}domainSignal=/.test(dashboard), 'dashboard no longer passes the chat domain to the panel');

// The guest page has no bridge handler, so the Bridge section renders nothing there
const guest = readFileSync(new URL('../app/graph-view/[token]/page.tsx', import.meta.url), 'utf8');
ok(!/onDiscoverBridge=/.test(guest), 'guest page passes no bridge handler');
ok(/const knowledgeBridge = \(title: string\) => onDiscoverBridge \?/.test(panel), 'Bridge section renders only with a handler');

// Group nodes ("Topics (4)", isGrouper) are never listed as topics or people (found in production, BERT)
ok(/TOPIC_NODE_TYPES\.has\(n\.type\) && !n\.isGrouper/.test(panel), 'Topics section skips group nodes');
ok(/n\.type === 'Person' && !n\.isGrouper/.test(panel), 'People section skips group nodes');

console.log(`verify_panel_layout: ${passed} checks passed`);
