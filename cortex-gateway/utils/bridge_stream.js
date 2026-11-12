'use strict';
/**
 * Bento panel bridges on one streamed request (cross-domain design 2026-11-09 §4.2 decision, step 4c). Replaces the
 * panel's per-domain parallel calls: one request, one auth, one audit entry; the gateway fans out per domain.
 *
 *   1. Domains: the offered ones the asker can see something in (list_bridge_domains), narrowed to the chips chosen;
 *      the server still resolves "auto" and answers `skipped` for the node's own domain.
 *   2. Each domain in parallel with its share of the limit; a `partial` event per domain as soon as it is done (the
 *      panel merges it into the graph straight away) and a `progress` event.
 *   3. Unused slots: when the domains found fewer bridges than the limit, domains that have more are asked again with a
 *      larger per-domain limit, excluding what was already returned; their extra bridges arrive as `partial` events.
 *   4. A final `result`: per-domain summaries, has_more, limits for "Show more".
 */
const AUTO = 'auto';

const targetsOf = r => (r && Array.isArray(r.nodes) ? r.nodes.filter(n => n.bridge_reason) : []);

/**
 * @param {object} p
 * @param {(tool: string, args: object) => Promise<object>} p.callTool   parsed tool JSON
 * @param {(event: object) => void} p.send
 * @param {{ sourceNodeId: string, sourceNodeName?: string, targetDomains?: string[], limit?: number,
 *           visibleNodeIds?: string[] }} p.request
 */
async function runBridgeStream({ callTool, send, request }) {
    const targetDomains = request.targetDomains && request.targetDomains.length ? request.targetDomains : [AUTO];
    const options = await callTool('list_bridge_domains', {});
    const offered = (options.domains || []).filter(d => d.has_visible_content).map(d => d.id);
    const domains = targetDomains.includes(options.auto || AUTO)
        ? offered
        : targetDomains.filter(d => (options.domains || []).some(o => o.id === d));
    const base = {
        source_node_id: request.sourceNodeId,
        source_node_name: request.sourceNodeName || '',
        target_domains: targetDomains,
        ...(request.limit ? { limit: request.limit } : {}),
    };
    const shown = new Set(request.visibleNodeIds || []);
    const perDomain = {};

    send({ type: 'progress', domains: domains.map(d => ({ domain: d, status: 'searching', count: 0 })) });
    await Promise.all(domains.map(async domain => {
        let result;
        try {
            result = await callTool('connect_knowledge_on_demand', { ...base, domain_filter: [domain], visible_node_ids: [...shown] });
        } catch (e) {
            result = { error: e.message };
        }
        const status = result.error ? 'error' : result.skipped ? 'skipped' : (targetsOf(result).length ? 'found' : 'none');
        perDomain[domain] = { result, status, targets: targetsOf(result).length };
        if (status === 'found') send({ type: 'partial', domain, result });
        send({ type: 'progress', domain, status, count: targetsOf(result).length });
    }));

    // Unused slots → domains that have more (skipping bridges already returned).
    const answered = Object.values(perDomain).filter(p => !p.result.error && !p.result.skipped);
    const limit = (answered[0] && answered[0].result.limit) || request.limit || 0;
    const total = answered.reduce((n, p) => n + p.targets, 0);
    const withMore = Object.entries(perDomain).filter(([, p]) => p.status === 'found' && p.result.has_more);
    if (limit && total < limit && withMore.length) {
        targetsAlready(perDomain).forEach(id => shown.add(id));
        const extraEach = Math.ceil((limit - total) / withMore.length);
        await Promise.all(withMore.map(async ([domain, p]) => {
            try {
                const extra = await callTool('connect_knowledge_on_demand', {
                    ...base, domain_filter: [domain], visible_node_ids: [...shown], per_domain_limit: extraEach,
                });
                const n = targetsOf(extra).length;
                if (n && !extra.error) {
                    send({ type: 'partial', domain, result: extra, extra: true });
                    p.targets += n;
                    p.extra = extra;
                    send({ type: 'progress', domain, status: 'found', count: p.targets });
                }
            } catch (e) { /* extra slots are a bonus; never fail the run */ }
        }));
    }

    const summaries = Object.entries(perDomain)
        .filter(([, p]) => p.status === 'found')
        .map(([domain, p]) => ({ domain, summary: p.result.bridge_summary }));
    const reasons = Object.values(perDomain).map(p => p.result.bridge_summary)
        .filter(t => t && /own author|time limit/.test(t));
    const first = answered[0] && answered[0].result;
    send({
        type: 'result',
        found: summaries.length > 0,
        summaries,
        reason: reasons[0] || null,
        partial: answered.some(p => p.result.search && p.result.search.partial),
        has_more: answered.some(p => p.result.has_more),
        limit: first ? first.limit : null,
        max_limit: first ? first.max_limit : null,
        show_more_step: first ? first.show_more_step : null,
        status: Object.fromEntries(Object.entries(perDomain).map(([d, p]) => [d, { status: p.status, count: p.targets }])),
    });
}

function targetsAlready(perDomain) {
    return Object.values(perDomain).flatMap(p => targetsOf(p.result).map(n => n.node_id)).filter(Boolean);
}

module.exports = { runBridgeStream };
