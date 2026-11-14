'use strict';
/**
 * Bridge mode without a model (bridge-pipeline-without-model-design-2026-11-13.md §4.2, §9 step 3).
 *
 * For a routing v2 bridge question, behind BRIDGE_PLAN = off | owner | true:
 *   1. whose items: when the from-side names a person, their own items (MCP person_work_items);
 *   2. plan: sources and target in code (utils/bridge_plan.js) — or one clarifying question, or no source;
 *   3. one connect_knowledge_on_demand per source, by node id, in parallel, each with its own deadline;
 *   4. the graph is the bridge chains only (virtual-link endpoints; grouping sections dropped), and the answer is
 *      written by code from the same chains (utils/bridge_section.js). No LLM call anywhere (Invariant 11).
 * Invariant 5: nothing is written; virtual links live only in the returned graph. Invariant 6: tool results never reach
 * a model. Every tool call carries the asker's identity; the MCP security clause applies on every hop (AP-30).
 */
const LIMITS = require('../config/bridge_plan.json');
const { planBridge, ownershipRequest, resolveBridgeSourceChoice } = require('./bridge_plan');
const { bridgesFromConnectResult, notesFromConnectResult, bridgeModeAnswer, dropGroupingBridges,
        groupingIdsFromConnectResult } = require('./bridge_section');

const BRIDGE_PLAN_SOURCE_DEADLINE_MS = LIMITS.source_deadline_ms;
const BRIDGE_TOOL = 'connect_knowledge_on_demand';
const OWNERSHIP_TOOL = 'person_work_items';
const SOURCE_DID_NOT_COMPLETE_NOTE = name => `The search from "${name}" did not complete; its connections are not shown.`;
const STATUS = { searching: 'searching', found: 'found', none: 'none', error: 'error', timeout: 'timeout' };

// BRIDGE_PLAN = off (default) | owner (the platform owner only) | true (everyone). Applies only where routing v2 runs.
function bridgePlanMode(value) {
    return ['owner', 'true'].includes(value) ? value : 'off';
}
const bridgePlanFor = (mode, isOwnerUser) => mode === 'true' || (mode === 'owner' && Boolean(isOwnerUser));

const withDeadline = (promise, ms) => {
    let timer;
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), ms); }),
    ]);
};

/** nodes / links / virtual_links merged by id (first copy wins), like the tool loop's mergeGraphData. */
function mergeGraphs(results) {
    const graph = { nodes: [], links: [], virtual_links: [] };
    const nodeIds = new Set();
    const linkKeys = new Set();
    const key = l => `${l.source}|${l.target}|${l.type || ''}`;
    for (const r of results) {
        for (const n of r.nodes || []) {
            const id = n.id || n.element_id || n.name;
            if (id && !nodeIds.has(id)) { nodeIds.add(id); graph.nodes.push(n); }
        }
        for (const field of ['links', 'virtual_links']) {
            for (const l of r[field] || []) {
                if (!linkKeys.has(key(l))) { linkKeys.add(key(l)); graph[field].push(l); }
            }
        }
    }
    return graph;
}

/** Only the bridge participants reach the browser; no bridge → an empty canvas (same rule as the tool-loop path). */
function keepBridgeParticipants(graph) {
    if (!graph.virtual_links.length) return { nodes: [], links: [], virtual_links: [] };
    const ids = new Set(graph.virtual_links.flatMap(l => [l.source, l.target]));
    return {
        nodes: graph.nodes.filter(n => ids.has(n.element_id || n.id || n.name)),
        links: graph.links.filter(l => ids.has(l.source) && ids.has(l.target)),
        virtual_links: graph.virtual_links,
    };
}

/**
 * @param {object} p
 * @param {string} p.question
 * @param {object} p.lookups        routing lookups for this asker (AP-30)
 * @param {object} [p.clarifyChoice] the browser's clarify_choice
 * @param {(tool: string, args: object) => Promise<object>} p.callTool  parsed tool JSON (may be {error}); asker's identity
 * @param {(e: object) => void} [p.onProgress]
 * @param {number} [p.deadlineMs]
 * @returns {Promise<{kind: 'answer', answer, graph, bridges, failedSources, plan}
 *                   | {kind: 'clarify', clarify} | {kind: 'no_source'}>}
 */
async function runBridgeMode({ question, lookups, clarifyChoice, callTool, onProgress = () => {},
                               deadlineMs = BRIDGE_PLAN_SOURCE_DEADLINE_MS }) {
    const opts = { resolvedSources: resolveBridgeSourceChoice(clarifyChoice, lookups) };
    const own = opts.resolvedSources.length ? null : ownershipRequest(question, lookups);
    if (own) {
        try {
            const r = await withDeadline(callTool(OWNERSHIP_TOOL, { person_node_ids: own.person_ids, labels: own.labels }), deadlineMs);
            if (!r || r.error || !Array.isArray(r.items)) opts.ownershipFailed = true;
            else opts.ownedIds = new Set(r.items.map(i => i.node_id));
        } catch (e) {
            opts.ownershipFailed = true;
        }
    }
    const plan = planBridge(question, lookups, opts);
    if (plan.kind !== 'plan') return plan;

    const base = plan.target ? { target_node_name: plan.target.name } : { target_domains: plan.target_domains };
    const runs = await Promise.all(plan.sources.map(async source => {
        onProgress({ domain: source.node_id, label: source.name, status: STATUS.searching, count: 0 });
        try {
            const parsed = await withDeadline(callTool(BRIDGE_TOOL, { ...base, source_node_id: source.node_id, query_context: question }), deadlineMs);
            if (!parsed || parsed.error) {
                onProgress({ domain: source.node_id, label: source.name, status: STATUS.error, count: 0 });
                return { source, status: STATUS.error, parsed: null };
            }
            const chains = bridgesFromConnectResult(parsed).length;
            onProgress({ domain: source.node_id, label: source.name, status: chains ? STATUS.found : STATUS.none, count: chains });
            return { source, status: chains ? STATUS.found : STATUS.none, parsed };
        } catch (e) {
            const status = e.message === 'deadline' ? STATUS.timeout : STATUS.error;
            onProgress({ domain: source.node_id, label: source.name, status, count: 0 });
            return { source, status, parsed: null };
        }
    }));

    const done = runs.filter(r => r.parsed);
    const failed = runs.filter(r => !r.parsed);
    const bridges = done.flatMap(r => bridgesFromConnectResult(r.parsed));
    const notes = [...plan.notes, ...done.flatMap(r => notesFromConnectResult(r.parsed)),
                   ...failed.map(r => SOURCE_DID_NOT_COMPLETE_NOTE(r.source.name))];
    const grouping = new Set(done.flatMap(r => groupingIdsFromConnectResult(r.parsed)));
    const merged = mergeGraphs(done.map(r => r.parsed));
    // The graph shows the same connections the answer lists (grouping sections are in neither).
    dropGroupingBridges(merged, grouping);
    const graph = keepBridgeParticipants(merged);
    const answer = bridgeModeAnswer({ bridges, notes, failed: failed.length > 0 && !done.length });
    return { kind: 'answer', answer, graph, bridges, failedSources: failed.map(r => r.source.name), plan,
             results: done.map(r => r.parsed) };
}

module.exports = { runBridgeMode, bridgePlanMode, bridgePlanFor, mergeGraphs, keepBridgeParticipants,
    BRIDGE_PLAN_SOURCE_DEADLINE_MS, SOURCE_DID_NOT_COMPLETE_NOTE };
