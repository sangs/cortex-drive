'use strict';
/**
 * Panel bridges on one streamed request (design 2026-11-09 §4.2 decision, step 4c), with fake tools.
 * Run: node tests/verify_bridge_stream.js (npm test).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runBridgeStream } = require('../utils/bridge_stream.js');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };
const target = (d, i) => ({ id: `${d}${i}`, node_id: `${d}-n${i}`, name: `${d} ${i}`, bridge_reason: 'Connected via: X' });
const OPTIONS = { auto: 'auto', domains: [
    { id: 'professional', has_visible_content: true }, { id: 'podcast', has_visible_content: true },
    { id: 'website', has_visible_content: true }, { id: 'document', has_visible_content: false }] };

(async () => {
    const calls = [];
    const callTool = async (tool, args) => {
        calls.push([tool, JSON.parse(JSON.stringify(args))]);
        if (tool === 'list_bridge_domains') return OPTIONS;
        const d = args.domain_filter[0];
        if (d === 'website') return { skipped: true, nodes: [], limit: 10 };   // the node's own domain
        if (d === 'podcast') return { nodes: [target('p', 0)], virtual_links: [{}], limit: 10, max_limit: 25, show_more_step: 10,
                                      has_more: false, bridge_summary: 'P found 1.' };
        const n = args.per_domain_limit || 5;   // professional: has more
        const start = args.per_domain_limit ? 5 : 0;
        return { nodes: Array.from({ length: n }, (_, i) => target('c', start + i)), virtual_links: [{}], limit: 10, max_limit: 25,
                 show_more_step: 10, has_more: true, bridge_summary: 'C found.' };
    };
    const events = [];
    await runBridgeStream({ callTool, send: e => events.push(e), request: { sourceNodeId: 'x', targetDomains: ['auto'], visibleNodeIds: ['on-screen'] } });
    const searches = calls.filter(c => c[0] === 'connect_knowledge_on_demand');
    eq(searches.slice(0, 3).map(c => c[1].domain_filter[0]).sort(), ['podcast', 'professional', 'website'], 'one search per visible domain (document has nothing)');
    ok(searches.every(c => c[1].visible_node_ids.includes('on-screen')), 'on-screen nodes sent');
    const extra = searches.find(c => c[1].per_domain_limit);
    ok(extra && extra[1].domain_filter[0] === 'professional', 'unused slots asked of the domain that has more');
    eq(extra[1].per_domain_limit, 4, '10 − (5 + 1) found = 4 extra');
    ok(['c-n0', 'p-n0'].every(id => extra[1].visible_node_ids.includes(id)), 'already-returned bridges excluded');
    eq(events.filter(e => e.type === 'partial').map(e => e.domain).sort(), ['podcast', 'professional', 'professional'], 'partials incl. the extra');
    const final = events.find(e => e.type === 'result');
    eq([final.found, final.has_more, final.limit, final.status.website.status, final.status.professional.count],
       [true, true, 10, 'skipped', 9], 'final result');
    ok(events.indexOf(final) === events.length - 1, 'result is the last event');

    // A failing domain is reported, never fails the run; nothing found → found=false with the server's reason
    const failing = async (tool, args) => tool === 'list_bridge_domains' ? OPTIONS
        : args.domain_filter[0] === 'podcast' ? (() => { throw new Error('down'); })()
        : { nodes: [], limit: 10, bridge_summary: "'X' connects to other domains only through its own author or owner (S)." };
    const ev2 = [];
    await runBridgeStream({ callTool: failing, send: e => ev2.push(e), request: { sourceNodeId: 'x' } });
    const f2 = ev2.find(e => e.type === 'result');
    eq([f2.found, f2.status.podcast.status], [false, 'error'], 'error reported per domain');
    ok(/own author/.test(f2.reason), 'reason passed through');

    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    ok(/app\.post\('\/api\/bridges\/stream', authMiddleware/.test(src), 'route behind auth');
    ok(/res\.on\('close', \(\) => \{ if \(!res\.writableEnded\) closed = true; \}\)/.test(src), 'disconnect detection (AP-17)');

    console.log(`verify_bridge_stream: ${passed} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
