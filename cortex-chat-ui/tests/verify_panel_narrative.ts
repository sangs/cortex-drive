/**
 * Bento panel narrative and Impact Context (design bridge-discovery-and-bento-panel-design-2026-11-03.md
 * §3.2 A, §3.3). Run: `npm test` (node, TypeScript type stripping).
 *
 * - The on-screen id list: node_ids only, de-duplicated, sorted (stable cache key), capped.
 * - The panel cache key includes the view, so the same node in another view is refetched.
 * - Hydration keeps the node's own description: the narrative never overwrites it (both boxes used to
 *   show the same text), on the dashboard and on the guest link page.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    visibleNodeIds, panelCacheKey, panelDetailFields, PANEL_VISIBLE_IDS_MAX,
} from '../utils/graphConstants.ts';

let passed = 0;
const ok = (cond: unknown, msg: string) => { assert.ok(cond, msg); passed++; };
const eq = (a: unknown, b: unknown, msg: string) => { assert.deepEqual(a, b, msg); passed++; };

// On-screen ids
eq(visibleNodeIds([{ node_id: 'b' }, { node_id: 'a' }, { node_id: 'b' }, {}, { node_id: '' }, { node_id: 7 }]),
    ['a', 'b'], 'node_ids only, de-duplicated and sorted; groupers (no node_id) left out');
const many = Array.from({ length: PANEL_VISIBLE_IDS_MAX + 20 }, (_, i) => ({ node_id: `n${String(i).padStart(4, '0')}` }));
eq(visibleNodeIds(many).length, PANEL_VISIBLE_IDS_MAX, 'capped');

// Cache key per node + view
ok(panelCacheKey('x', ['a']) !== panelCacheKey('x', ['a', 'b']), 'same node, different view → different key');
eq(panelCacheKey('x', visibleNodeIds([{ node_id: 'b' }, { node_id: 'a' }])),
    panelCacheKey('x', visibleNodeIds([{ node_id: 'a' }, { node_id: 'b' }])), 'node order on screen does not matter');

// Narrative fields
eq(panelDetailFields({ panel_narrative: 'P', combined_narrative: 'C', description: 'D' }),
    { panel_narrative: 'P', combined_narrative: 'C' }, 'only the narrative fields, never description');
eq(panelDetailFields({}), {}, 'older server without the fields: nothing added');

// Hydration no longer writes the narrative into description (dashboard and guest link page)
for (const file of ['app/dashboard/page.tsx', 'app/graph-view/[token]/page.tsx']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    ok(!/description:\s*hydratedDesc/.test(src) && !src.includes('hydratedDesc'), `${file}: description not overwritten`);
    ok(src.includes('visible_node_ids: onScreenIds'), `${file}: sends the on-screen ids`);
    ok(src.includes('panelCacheKey('), `${file}: cache key includes the view`);
}

// Panel: Impact Context shows description only and is hidden without one; Narrative reads panel_narrative
const panel = readFileSync(new URL('../components/BentoDetailPanel.tsx', import.meta.url), 'utf8');
ok(!panel.includes("node.description || 'Metadata pending...'"), 'Impact Context has no placeholder text');
ok(/node\.panel_narrative \|\| node\.combined_narrative/.test(panel), 'Narrative prefers panel_narrative');
ok(/'narrative': \(title\) => narrativeBlock\(title\)/.test(panel), 'Narrative is a section any layout can list (design §4.2)');
ok(/aria-label="Loading narrative"/.test(panel) && /\{isBentoHydrating \? \(/.test(panel),
    'Narrative shows a loading skeleton while the panel hydrates (not the placeholder text)');

console.log(`verify_panel_narrative: ${passed} checks passed`);
