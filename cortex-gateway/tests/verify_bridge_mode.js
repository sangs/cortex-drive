'use strict';
/**
 * Bridge mode without a model (bridge-pipeline-without-model-design-2026-11-13.md §4.2, §9 step 3; utils/bridge_mode.js).
 * - BRIDGE_PLAN off | owner | true; anything else is off;
 * - a named person's kind ("Sangeetha's thought leadership") uses only their own items (person_work_items); a failed
 *   lookup is stated in the notes;
 * - one connect_knowledge_on_demand per source, by node id, with the question as query_context and the plan's target;
 * - progress per source; a failed or slow source is a note and the others still answer; all failed → "did not complete";
 * - the graph is the answer's chains only (grouping sections dropped, only virtual-link endpoints); no bridge → no graph;
 * - clarify and no_source pass through; no LLM in the module; /query wiring behind the flag, after cross mode.
 * No network. Run: node tests/verify_bridge_mode.js (npm test).
 */
process.env.ENABLE_DOCUMENT_DOMAIN = 'true';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildRoutingLookups } = require('../utils/intent_classifier.js');
const { runBridgeMode, bridgePlanMode, bridgePlanFor, SOURCE_DID_NOT_COMPLETE_NOTE } = require('../utils/bridge_mode.js');
const { NO_BRIDGE_ANSWER, BRIDGE_SEARCH_FAILED_ANSWER } = require('../utils/bridge_section.js');
const { CLARIFY_QUESTION } = require('../utils/bridge_plan.js');
const FIXTURE = require('./fixtures/bridge_result_1_3.json');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };

const OWNER = 'user_owner';
const entry = (name, domain, type, node_id, extra = {}) => ({ name, domain, type, node_id, tier: 'org', owner_id: OWNER, ...extra });
const CATALOG = {
    entries: [
        entry('Sangeetha Ramadurai', 'person', null, 'p1', { tier: 'PUBLIC', work_domains: ['career'] }),
        entry('Alex Other', 'person', null, 'p2', { work_domains: ['career'] }),
        entry('Cortex-Drive', 'career', 'Project', 'c1', { tier: 'PUBLIC' }),
        entry('Ignite Social Learning Community @ JPMC', 'career', 'ThoughtLeadership', 'tl1', { tier: 'PUBLIC' }),
        entry('Platform Talk', 'career', 'ThoughtLeadership', 'tl2', { tier: 'PUBLIC' }),
        entry('Alex Keynote', 'career', 'ThoughtLeadership', 'tl3'),
        entry('Graph database', 'website', 'WebsiteSource', 'w1'),
    ],
};
const lookups = buildRoutingLookups(CATALOG, { isOwner: true, userId: OWNER, allowedIds: [] });
const DEMO = "How did Sangeetha's thought leadership influence Cortex-Drive?";
const empty = { nodes: [], virtual_links: [], bridge_notes: ['No bridge found from this item.'] };

/** Fake MCP: records calls; answers by tool and source. */
function fakeTools({ owned = ['tl1', 'tl2'], ownershipError = false, bySource = {} } = {}) {
    const calls = [];
    const callTool = async (tool, args) => {
        calls.push({ tool, args });
        if (tool === 'person_work_items') return ownershipError ? { error: 'down' } : { items: owned.map(id => ({ node_id: id, name: id })) };
        const r = bySource[args.source_node_id];
        if (r === 'slow') return new Promise(() => {});
        if (r === 'error') return { error: 'boom' };
        return r || empty;
    };
    return { calls, callTool };
}

(async () => {
    // ── flag ────────────────────────────────────────────────────────────────────────────────────────────
    eq(['off', 'owner', 'true', undefined, 'yes', 'TRUE'].map(bridgePlanMode), ['off', 'owner', 'true', 'off', 'off', 'off']);
    eq([bridgePlanFor('off', true), bridgePlanFor('owner', true), bridgePlanFor('owner', false), bridgePlanFor('true', false)],
       [false, true, false, true]);

    // ── the demo question: her own thought leadership only, by node id, target named ────────────────────
    {
        const t = fakeTools({ owned: ['tl1', 'tl2'], bySource: { tl1: FIXTURE } });
        const progress = [];
        const r = await runBridgeMode({ question: DEMO, lookups, callTool: t.callTool, onProgress: e => progress.push(e) });
        eq(r.kind, 'answer');
        const own = t.calls.find(c => c.tool === 'person_work_items');
        eq(own.args, { person_node_ids: ['p1'], labels: ['ThoughtLeadership'] }, 'ownership asked for her, for the kind');
        const bridgeCalls = t.calls.filter(c => c.tool === 'connect_knowledge_on_demand');
        eq(bridgeCalls.map(c => c.args.source_node_id).sort(), ['tl1', 'tl2'], "Alex's keynote is not a source");
        ok(bridgeCalls.every(c => c.args.target_node_name === 'Cortex-Drive' && c.args.query_context === DEMO && !c.args.source_node_name),
           'by node id, with the question and the named target');
        eq(r.plan.rule, 'kind');
        ok(/^Cortex-Drive found 3 connection/.test(r.answer), r.answer.slice(0, 80));
        ok(r.answer.includes('No bridge found from this item.'), "the empty source's note is shown");
        ok(!r.answer.includes('Thought Leadership & Community'), 'grouping section not in the answer');
        const ids = new Set(r.graph.nodes.map(n => n.element_id));
        ok(![...ids].some(id => id.endsWith(':680')), 'grouping section not in the graph');
        ok(r.graph.virtual_links.every(l => ids.has(l.source) && ids.has(l.target)), 'every link has both ends');
        ok(r.graph.nodes.every(n => r.graph.virtual_links.some(l => l.source === n.element_id || l.target === n.element_id)),
           'only bridge participants');
        eq(progress.filter(e => e.status === 'searching').map(e => e.label).sort(),
           ['Ignite Social Learning Community @ JPMC', 'Platform Talk']);
        eq(progress.filter(e => e.status !== 'searching').map(e => [e.label, e.status, e.count]).sort(),
           [['Ignite Social Learning Community @ JPMC', 'found', 3], ['Platform Talk', 'none', 0]]);
    }

    // ── ownership lookup failed: every visible item of the kind, and the notes say so ────────────────────
    {
        const t = fakeTools({ ownershipError: true, bySource: { tl1: FIXTURE } });
        const r = await runBridgeMode({ question: DEMO, lookups, callTool: t.callTool });
        eq(t.calls.filter(c => c.tool === 'connect_knowledge_on_demand').map(c => c.args.source_node_id).sort(), ['tl1', 'tl2', 'tl3']);
        ok(r.answer.includes('Could not check which items belong to Sangeetha Ramadurai'), 'stated');
    }

    // ── a person whose own items include none of the kind: not everyone's items, one question instead ────
    {
        const t = fakeTools({ owned: [] });
        const r = await runBridgeMode({ question: DEMO, lookups, callTool: t.callTool });
        ok(r.kind === 'clarify' || r.kind === 'no_source', r.kind);
        ok(!t.calls.some(c => c.tool === 'connect_knowledge_on_demand'), 'no search from items that are not hers');
    }

    // ── a slow or failed source is a note; the others still answer ──────────────────────────────────────
    {
        const t = fakeTools({ bySource: { tl1: FIXTURE, tl2: 'slow' } });
        const r = await runBridgeMode({ question: DEMO, lookups, callTool: t.callTool, deadlineMs: 50 });
        eq(r.failedSources, ['Platform Talk']);
        ok(r.answer.includes(SOURCE_DID_NOT_COMPLETE_NOTE('Platform Talk')), 'timeout noted');
        ok(r.bridges.length === 3, 'the finished source still answers');
        const all = fakeTools({ bySource: { tl1: 'error', tl2: 'error' } });
        const f = await runBridgeMode({ question: DEMO, lookups, callTool: all.callTool });
        ok(f.answer.startsWith(BRIDGE_SEARCH_FAILED_ANSWER), 'all failed → did not complete');
        eq(f.graph.nodes, [], 'no graph');
    }

    // ── no bridge → the no-bridge answer and an empty canvas ─────────────────────────────────────────────
    {
        const t = fakeTools();
        const r = await runBridgeMode({ question: DEMO, lookups, callTool: t.callTool });
        ok(r.answer.startsWith(NO_BRIDGE_ANSWER), 'no bridge');
        eq(r.graph, { nodes: [], links: [], virtual_links: [] });
    }

    // ── named item, no person: no ownership lookup; target domains when no item is named on the to-side ──
    {
        const t = fakeTools();
        const r = await runBridgeMode({ question: 'How does the Graph database page connect to the podcasts?', lookups, callTool: t.callTool });
        ok(!t.calls.some(c => c.tool === 'person_work_items'), 'no lookup needed');
        const c = t.calls.find(x => x.tool === 'connect_knowledge_on_demand');
        eq([c.args.source_node_id, c.args.target_domains, c.args.target_node_name], ['w1', ['podcast'], undefined]);
        eq(r.plan.rule, 'named');
    }

    // ── clarify and the click; no_source ─────────────────────────────────────────────────────────────────
    {
        const t = fakeTools();
        const r = await runBridgeMode({ question: 'How did it influence that?', lookups, callTool: t.callTool });
        eq(r.kind, 'clarify'); eq(r.clarify.question, CLARIFY_QUESTION);
        eq(t.calls, [], 'no tool call before the user picks');
        const picked = await runBridgeMode({ question: 'How did it influence Cortex-Drive?', lookups, callTool: t.callTool,
                                             clarifyChoice: { kind: 'source', node_id: 'tl3' } });
        eq(picked.plan.rule, 'chosen'); eq(picked.plan.sources.map(s => s.node_id), ['tl3']);
        const nobody = buildRoutingLookups({ entries: [] }, { isOwner: false, userId: 'x', allowedIds: [] });
        eq(await runBridgeMode({ question: DEMO, lookups: nobody, callTool: fakeTools().callTool }), { kind: 'no_source' });
    }

    // ── no model in the module; /query wiring ───────────────────────────────────────────────────────────
    {
        const mod = fs.readFileSync(path.join(__dirname, '..', 'utils', 'bridge_mode.js'), 'utf8');
        ok(!/openai|chat\.completions/i.test(mod), 'no LLM call in bridge mode');
        ok(!/\b(MERGE|CREATE|SET)\b/.test(mod), 'nothing written (Invariant 5)');
        const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
        const at = index.indexOf("routingV2.mode === 'bridge' && bridgePlanFor(BRIDGE_PLAN_MODE, isOwner(userId))");
        ok(at > index.indexOf("if (routingV2.mode === 'cross')"), 'after cross mode');
        ok(at < index.indexOf('const bridgeContext = resolveBridgeContext('), 'before the model path');
        ok(/const BRIDGE_PLAN_MODE = bridgePlanMode\(process\.env\.BRIDGE_PLAN\)/.test(index), 'flag read once');
        const start = index.indexOf('async function answerBridgeMode');
        const fn = index.slice(start, index.indexOf('\n}\n', start));
        ok(fn.length > 0 && !/openai/.test(fn), 'answerBridgeMode makes no LLM call');
        ok(/auditResponseUrls\(run\.answer, urls\)/.test(fn), 'URL audit (AP-15)');
        ok(/cacheable: false/.test(fn) && /isCacheableResponse\(\{ auditedAnswer, hadToolFailure, hasGraph \}\)/.test(fn),
           'clarify never cached; answers only as a grounded success (AP-22)');
        const policy = require('../utils/tool_policy.js');
        for (const isGuest of [false, true]) {
            eq(policy.toolsOfferedFor({ isGuest }, [{ function: { name: 'person_work_items' } }]), [],
               'person_work_items is never offered to the chat model');
        }
    }

    console.log(`verify_bridge_mode: ${passed} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
