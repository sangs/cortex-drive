/**
 * Graph view: expand → collapse (2026-10-28). Run: `npm test` (node, TypeScript type stripping).
 *
 * Reproduces the production report: career map with 6 nodes (person + 5 career categories);
 * double-clicking "Open Source & Independent Ventures" fetched 2 neighbours, and the merge regrouped
 * the WHOLE graph (7a3f525, 2026-09-17), folding all 5 categories, the expanded one included, into
 * "Categories (5)": 6 → 3 nodes, nothing left to collapse. Also: auto-fit zoom bounds (S2-58 follow-up).
 * Pure functions only (utils/graphConstants.ts); the collapse step mirrors handleNodeDoubleClick.
 */
import assert from 'node:assert/strict';
import {
    finalizeGraphForRender, mergeFragmentNodes, clampZoom,
    GRAPH_AUTOFIT_MIN_ZOOM, GRAPH_AUTOFIT_MAX_ZOOM,
} from '../utils/graphConstants.ts';

let passed = 0;
const ok = (cond: unknown, msg: string) => { assert.ok(cond, msg); passed++; };
const eq = (a: unknown, b: unknown, msg: string) => { assert.deepEqual(a, b, msg); passed++; };

const CATEGORIES = ['Open Source & Independent Ventures', 'Professional Experience', 'Thought Leadership',
    'Education & Continuous Learning', 'Hackathons'];
function careerMap() {
    const nodes: any[] = [{ id: 'p', node_id: 'n-p', name: 'Sangeetha Ramadurai', type: 'Person' }]
        .concat(CATEGORIES.map((name, i) => ({ id: `c${i}`, node_id: `n-c${i}`, name, type: 'Category' })));
    const links: any[] = CATEGORIES.map((_, i) => ({ source: 'p', target: `c${i}`, type: 'HAS_PORTFOLIO' }));
    return { nodes, links };
}

// The expansion merge as parseDataToGraph does it (fragment branch), then finalize.
function expand(prev: { nodes: any[]; links: any[] }, fragment: { nodes: any[]; links: any[] }, keep: boolean) {
    const nodes = [...prev.nodes], links = [...prev.links];
    const onScreen = new Set<string>(nodes.map(n => n.id));
    const remap = mergeFragmentNodes(nodes, fragment.nodes);
    const id = (x: string) => remap.get(x) || x;
    fragment.links.forEach(l => links.push({ ...l, source: id(l.source), target: id(l.target) }));
    return finalizeGraphForRender(nodes, links, false, undefined, keep ? onScreen : undefined);
}

// The server returns the expanded category under a DIFFERENT id (elementId vs on-screen id) with
// the same node_id, plus two Project neighbours.
const fragment = {
    nodes: [
        { id: '4:abc:677', node_id: 'n-c0', name: CATEGORIES[0], type: 'Category' },
        { id: 'x1', node_id: 'n-x1', name: 'Cortex-Drive', type: 'Project' },
        { id: 'x2', node_id: 'n-x2', name: 'Side Project', type: 'Project' },
    ],
    links: [{ source: '4:abc:677', target: 'x1', type: 'CONTAINS' }, { source: '4:abc:677', target: 'x2', type: 'CONTAINS' }],
};

// ── the bug, as it was (no keepIds) ─────────────────────────────────────────────────────────────
{
    const before = careerMap();
    const after = expand(before, fragment, false);
    ok(!after.nodes.some(n => n.id === 'c0'), 'old behaviour reproduced: the expanded category is folded into a grouper');
    ok(after.nodes.some(n => String(n.name).startsWith('Categories (')), 'old behaviour reproduced: "Categories (n)" appears');
}

// ── fixed ───────────────────────────────────────────────────────────────────────────────────────
{
    const before = careerMap();
    const after = expand(before, fragment, true);
    const ids = new Set(after.nodes.map(n => n.id));
    ok(before.nodes.every(n => ids.has(n.id)), 'every node already on screen survives the expansion with its id');
    ok(!after.nodes.some(n => n.id === '4:abc:677'), 'the fetched copy of the expanded node merged into the on-screen one');
    ok(after.links.some(l => l.source === 'c0' && !before.nodes.some(b => b.id === l.target)),
       'fetched links are re-pointed at the on-screen node (to the new neighbours or their grouper)');
    const contributed = new Set(after.nodes.map(n => n.id).filter(id => !before.nodes.some(b => b.id === id)));
    ok(contributed.size > 0, 'the expansion added nodes');

    // collapse (handleNodeDoubleClick's collapse branch)
    const nodes = after.nodes.filter(n => !contributed.has(n.id));
    const links = after.links.filter(l => nodes.some(n => n.id === l.source) && nodes.some(n => n.id === l.target));
    eq(new Set(nodes.map(n => n.id)), new Set(before.nodes.map(n => n.id)), 'collapse restores exactly the original nodes');
    eq(links.length, before.links.length, 'collapse restores exactly the original links');

    // expand again → same result; two different categories one after the other both stay
    const again = expand({ nodes, links }, fragment, true);
    eq(again.nodes.length, after.nodes.length, 'expand → collapse → expand gives the same graph');
    const second = expand(after, { nodes: [{ id: 'y1', node_id: 'n-y1', name: 'Hack 1', type: 'Hackathon' },
        { id: 'y2', node_id: 'n-y2', name: 'Hack 2', type: 'Hackathon' }],
        links: [{ source: 'c4', target: 'y1' }, { source: 'c4', target: 'y2' }] }, true);
    ok(after.nodes.every(n => second.nodes.some(m => m.id === n.id)), 'a second expansion leaves the first one intact');
}

// ── merge keeps ids, fills fields ───────────────────────────────────────────────────────────────
{
    const nodes: any[] = [{ id: 'a', node_id: 'N1', name: 'A', type: 'Topic' }];
    const remap = mergeFragmentNodes(nodes, [{ id: 'elem-1', node_id: 'N1', name: 'A', type: 'Topic', description: 'd' } as any,
        { id: 'b', name: 'B', type: 'Topic' } as any]);
    eq(nodes.map(n => n.id), ['a', 'b'], 'matched node keeps its id; new node appended');
    eq((nodes[0] as any).description, 'd', 'fetched fields are taken over');
    eq([...remap], [['elem-1', 'a']], 'remap returned for the fetched id');
}

// ── auto-fit zoom bounds ────────────────────────────────────────────────────────────────────────
eq(clampZoom(6, GRAPH_AUTOFIT_MIN_ZOOM, GRAPH_AUTOFIT_MAX_ZOOM), 1, 'small graph: never zoomed in past normal size');
eq(clampZoom(0.08, GRAPH_AUTOFIT_MIN_ZOOM, GRAPH_AUTOFIT_MAX_ZOOM), 0.35, 'large graph: never below the readable floor');
eq(clampZoom(0.6, GRAPH_AUTOFIT_MIN_ZOOM, GRAPH_AUTOFIT_MAX_ZOOM), 0.6, 'in range: unchanged');

console.log(`verify_graph_expand_collapse: ${passed} checks passed`);
