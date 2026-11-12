'use strict';
/**
 * Cross-domain search mode (design 2026-11-09 §4.2), with fake tools. Run: node tests/verify_cross_mode.js (npm test).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runCrossMode, crossEvidenceText, rrfMerge, withConnectionsSection, CROSS_DOMAIN_LLM_QUOTA } = require('../utils/cross_mode.js');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };
const node = (domain, i, extra = {}) => ({ id: `${domain}-${i}`, element_id: `${domain}-${i}`, node_id: `${domain}-n${i}`, name: `${domain} item ${i}`, type: 'X', ...extra });

(async () => {
    // Parallel fan-out, per-domain quota, pairs only across domains, progress per domain
    const calls = [];
    const started = [];
    const progress = [];
    const callTool = async (tool, args) => {
        calls.push([tool, args]);
        if (tool === 'bridges_between') {
            return { bridges: [{ from: 'career item 0', to: 'podcast item 0', via: ['Graph Databases'], rels: ['USES_TOOL', 'COVERS_TECHNOLOGY'], hops: 2 }],
                     nodes: [{ id: 'v1', element_id: 'v1', name: 'Graph Databases', type: 'Technology' }], virtual_links: [{ source: 'career-0', target: 'v1', type: 'VIRTUAL_BRIDGE' }] };
        }
        started.push(args.domain_intent);
        await new Promise(r => setTimeout(r, 30));
        const domain = { professional: 'career' }[args.domain_intent] || args.domain_intent;
        if (domain === 'website') return { nodes: [], links: [] };
        return { nodes: Array.from({ length: 8 }, (_, i) => node(domain, i)), links: [{ source: `${domain}-0`, target: `${domain}-1` }] };
    };
    const t0 = Date.now();
    const r = await runCrossMode({ domains: ['career', 'podcast', 'website'], terms: ['graph databases'], callTool,
                                   onProgress: e => progress.push(`${e.domain}:${e.status}`) });
    ok(Date.now() - t0 < 80, 'domains searched in parallel, not one after another');
    eq(started.sort(), ['podcast', 'professional', 'website'], 'one search per domain, career as professional');
    eq(calls.filter(c => c[0] === 'search_enterprise_graph').every(c => c[1].scoped_expansion === true), true, 'scoped expansion');
    eq(r.status, { career: 'found', podcast: 'found', website: 'none' }, 'status per domain');
    eq(progress.filter(p => !p.endsWith('searching')).sort(), ['career:found', 'podcast:found', 'website:none'], 'progress per domain');
    eq([r.evidence.career.length, r.evidence.podcast.length], [CROSS_DOMAIN_LLM_QUOTA, CROSS_DOMAIN_LLM_QUOTA], 'quota per domain');
    const pairs = calls.find(c => c[0] === 'bridges_between')[1].pairs;
    eq(pairs.every(([a, b]) => a.split('-')[0] !== b.split('-')[0]), true, 'pairs only across domains');
    eq(pairs.length, 4, '2 × 2 anchors between career and podcast');
    eq([r.bridges.length, r.graph.virtual_links.length, r.anyEvidence], [1, 1, true], 'bridge merged into the graph');
    const text = crossEvidenceText(r, (d, nodes) => nodes.map(n => n.name).join(', '));
    ok(text.includes('No data found in Cortex-Drive for "graph databases" in website'), 'empty domain named');
    ok(text.includes('career item 0 ↔ podcast item 0 via Graph Databases'), 'connection stated');

    // Bridge endpoints are each domain's own content only
    const r4 = await runCrossMode({ domains: ['career', 'podcast'], terms: ['x'], callTool,
                                    isContent: (d, n) => !n.name.endsWith('item 0') });
    const pairs4 = calls.filter(c => c[0] === 'bridges_between').pop()[1].pairs;
    eq(pairs4.some(([a, b]) => a.endsWith('-n0') || b.endsWith('-n0')), false, 'non-content results never become endpoints');
    eq(r4.evidence.career.length, CROSS_DOMAIN_LLM_QUOTA, 'non-content results still count as evidence');

    // Deadline and failure: named, never silently dropped; a failed bridge never hides results
    const slow = async (tool, args) => {
        if (tool === 'bridges_between') throw new Error('boom');
        if (args.domain_intent === 'podcast') return new Promise(res => setTimeout(() => res({ nodes: [node('podcast', 0)] }), 200));
        if (args.domain_intent === 'website') return { error: 'neo4j down' };
        return { nodes: [node('career', 0)] };
    };
    const r2 = await runCrossMode({ domains: ['career', 'podcast', 'website'], terms: ['x'], callTool: slow, deadlineMs: 50 });
    eq(r2.status, { career: 'found', podcast: 'timeout', website: 'error' }, 'timeout and error per domain');
    const t2 = crossEvidenceText(r2, (d, ns) => ns.map(n => n.name).join(', '));
    ok(t2.includes('Podcast search did not finish in time') && t2.includes('Website search failed'), 'incomplete domains named');
    eq(r2.evidence.career.length, 1, 'results kept when bridges fail');

    // Nothing anywhere → no evidence (the gateway then answers "No data found" without an LLM call)
    const r3 = await runCrossMode({ domains: ['career', 'podcast'], terms: ['x'], callTool: async () => ({ nodes: [] }) });
    eq(r3.anyEvidence, false, 'no evidence');

    // Weighted RRF
    const merged = rrfMerge({ a: [{ id: 1 }], b: [{ id: 2 }] }, { a: 0.6, b: 1.0 });
    eq(merged[0].domain, 'b', 'higher domain score ranks first at equal rank');

    // Connections are written by code, exactly as found; any LLM-written section is replaced
    const b = [{ from: 'A', to: 'B', via: ['Graph Databases'], rels: ['USES_TOOL', 'IS_SIMILAR'] }];
    const out = withConnectionsSection('Answer.\n\n## How these connect\n- A and B share a deep purpose.', b);
    ok(!out.includes('deep purpose'), 'model-written connections removed');
    ok(out.includes('- **A** ↔ **B** via Graph Databases (USES_TOOL → IS_SIMILAR)'), 'stated as found');
    eq(withConnectionsSection('Answer.', []), 'Answer.', 'no bridges → no section');

        // Gateway wiring (static)
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    ok(/routingV2\.mode === 'cross'/.test(src) && /text\/event-stream/.test(src), 'cross mode streams when asked');
    ok(/if \(!result\.anyEvidence\) \{\s*answer = NO_DATA_FOUND_ANSWER\(question\);/.test(src), 'no evidence → No data found, no LLM call');
    ok(/temperature: ANSWER_TEMPERATURE,\s*\}\);\s*answer = completion/.test(src), 'answer call at temperature 0, no tools');
    ok(/auditResponseUrls\(answer, urls\)/.test(src), 'URL audit on the cross answer');
    ok(/answer = withConnectionsSection\(answer, result\.bridges\)/.test(src), 'connections section written by code');

    console.log(`verify_cross_mode: ${passed} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
