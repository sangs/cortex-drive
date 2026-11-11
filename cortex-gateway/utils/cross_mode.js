'use strict';
/**
 * Cross-domain search mode (cross-domain discovery design 2026-11-09 §4.2), used when routing v2 says `cross`.
 *
 *   1. Fan out: search_enterprise_graph once per domain, in parallel, each with its own domain_intent (Invariant 3
 *      and the §4.4 exclusion rule apply per domain) and a deadline; progress reported as each domain finishes.
 *   2. Merge: per-domain lists ranked by weighted Reciprocal Rank Fusion (k = 60, weight = routing domain score) with
 *      a per-domain quota, so one busy domain cannot crowd out the others.
 *   3. Bridge between results: pair search (bridges_between) between the top results of different domains.
 *   4. Evidence for the answer: a compact per-domain summary (Invariant 6 / AP-4); an empty domain is named
 *      ("No data found … in <domain>"), a domain that missed its deadline is named as incomplete — never dropped.
 *
 * Every dependency is passed in (tool calls, filters, summaries), so the module is tested without a network.
 */
const RRF_K = 60;
// Per-domain deadline. The design's ~1.2 s assumed a direct query; a search through MCP takes a few seconds, so this
// starts at 6 s and is to be tuned from production measurements (each domain is reported as it finishes).
const CROSS_DOMAIN_SEARCH_DEADLINE_MS = Number(process.env.CROSS_DOMAIN_SEARCH_DEADLINE_MS || 6000);
const CROSS_DOMAIN_LLM_QUOTA = 5;          // results per domain in the answer's evidence
const CROSS_DOMAIN_GRAPH_CAP = 40;         // nodes per domain drawn on the graph
const CROSS_DOMAIN_ANCHORS_PER_DOMAIN = 2; // top results per domain used as bridge endpoints
const SEARCH_INTENT = { career: 'professional', podcast: 'podcast', website: 'website', document: 'document' };
const DISPLAY = { career: 'Career', podcast: 'Podcast', website: 'Website', document: 'Document' };

const withDeadline = (promise, ms) => {
    let timer;
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), ms); }),
    ]);
};

/** Results of a domain that mention one of the topic terms first (stable otherwise). */
function rankForTopics(nodes, terms) {
    const words = terms.map(t => t.toLowerCase()).filter(Boolean);
    const hit = n => words.some(w => `${n.name || ''} ${n.description || ''}`.toLowerCase().includes(w));
    return [...nodes.filter(hit), ...nodes.filter(n => !hit(n))];
}

/** Weighted RRF over per-domain ranked lists; returns [{node, domain, score}] best first. */
function rrfMerge(lists, weights) {
    const out = [];
    for (const [domain, nodes] of Object.entries(lists)) {
        const w = weights[domain] || 1;
        nodes.forEach((node, i) => out.push({ node, domain, score: w / (RRF_K + i + 1) }));
    }
    return out.sort((a, b) => b.score - a.score);
}

/**
 * @param {object} p
 * @param {string[]} p.domains            gateway domain names chosen by routing v2
 * @param {string[]} p.terms              topic words the asker used (search keyword + ranking)
 * @param {Record<string, number>} [p.weights]  routing domain scores
 * @param {(tool: string, args: object) => Promise<object>} p.callTool   parsed tool JSON (may be {error})
 * @param {(domain: string, parsed: object) => object} [p.filter]        per-domain type filter (the gateway guard)
 * @param {(e: {domain: string, status: string, count: number}) => void} [p.onProgress]
 * @param {number} [p.deadlineMs]
 */
async function runCrossMode({ domains, terms, weights = {}, callTool, filter = (d, x) => x, onProgress = () => {},
                              deadlineMs = CROSS_DOMAIN_SEARCH_DEADLINE_MS }) {
    const keyword = terms.join(' ');
    const searched = await Promise.all(domains.map(async domain => {
        onProgress({ domain, status: 'searching', count: 0 });
        try {
            const parsed = await withDeadline(callTool('search_enterprise_graph',
                { keyword, domain_intent: SEARCH_INTENT[domain] || domain, scoped_expansion: true }), deadlineMs);
            if (!parsed || parsed.error) {
                onProgress({ domain, status: 'error', count: 0 });
                return { domain, status: 'error', parsed: { nodes: [], links: [] } };
            }
            const kept = filter(domain, parsed) || parsed;
            const nodes = rankForTopics((kept.nodes || []).filter(n => n && (n.name || n.title)), terms);
            onProgress({ domain, status: nodes.length ? 'found' : 'none', count: nodes.length });
            return { domain, status: nodes.length ? 'found' : 'none', parsed: { ...kept, nodes } };
        } catch (e) {
            const status = e.message === 'deadline' ? 'timeout' : 'error';
            onProgress({ domain, status, count: 0 });
            return { domain, status, parsed: { nodes: [], links: [] } };
        }
    }));

    const lists = Object.fromEntries(searched.map(s => [s.domain, s.parsed.nodes]));
    const merged = rrfMerge(lists, weights);
    const evidence = Object.fromEntries(domains.map(d => [d, merged.filter(m => m.domain === d).slice(0, CROSS_DOMAIN_LLM_QUOTA).map(m => m.node)]));

    // Graph: each domain's top results (capped) and the links among them.
    const graph = { nodes: [], links: [], virtual_links: [] };
    const seen = new Set();
    for (const s of searched) {
        for (const n of s.parsed.nodes.slice(0, CROSS_DOMAIN_GRAPH_CAP)) {
            const id = n.element_id || n.id;
            if (id && !seen.has(id)) { seen.add(id); graph.nodes.push({ ...n, __crossDomain: s.domain }); }
        }
    }
    for (const s of searched) {
        for (const l of s.parsed.links || []) if (seen.has(l.source) && seen.has(l.target)) graph.links.push(l);
    }

    // Bridges between the top results of different domains (pair search).
    const anchors = domains.map(d => evidence[d].filter(n => n.node_id).slice(0, CROSS_DOMAIN_ANCHORS_PER_DOMAIN));
    const pairs = [];
    for (let i = 0; i < anchors.length; i++) {
        for (let j = i + 1; j < anchors.length; j++) {
            for (const a of anchors[i]) for (const b of anchors[j]) pairs.push([a.node_id, b.node_id]);
        }
    }
    let bridges = [];
    if (pairs.length) {
        try {
            const out = await callTool('bridges_between', { pairs });
            if (out && !out.error) {
                bridges = out.bridges || [];
                for (const n of out.nodes || []) {
                    const id = n.element_id || n.id;
                    if (id && !seen.has(id)) { seen.add(id); graph.nodes.push(n); }
                }
                graph.virtual_links.push(...(out.virtual_links || []));
            }
        } catch (e) { /* bridges are an addition; their failure never hides the domain results */ }
    }

    const status = Object.fromEntries(searched.map(s => [s.domain, s.status]));
    return { status, evidence, graph, bridges, keyword, anyEvidence: searched.some(s => s.parsed.nodes.length) || bridges.length > 0 };
}

/** The evidence text the answer is written from (compact; `summarise(domain, nodes)` is the gateway's summariser). */
function crossEvidenceText({ status, evidence, bridges, keyword }, summarise) {
    const parts = [];
    for (const [domain, st] of Object.entries(status)) {
        const name = DISPLAY[domain] || domain;
        if (st === 'found') parts.push(`## ${name}\n${summarise(domain, evidence[domain])}`);
        else if (st === 'timeout') parts.push(`## ${name}\n${name} search did not finish in time; results from ${name.toLowerCase()} may be incomplete.`);
        else if (st === 'error') parts.push(`## ${name}\n${name} search failed; results from ${name.toLowerCase()} are missing.`);
        else parts.push(`## ${name}\nNo data found in Cortex-Drive for "${keyword}" in ${name.toLowerCase()}.`);
    }
    if (bridges.length) {
        parts.push('## Connections between domains (session-only virtual bridges, not stored)\n' + bridges
            .map(b => `- ${b.from} ↔ ${b.to}${b.via.length ? ` via ${b.via.join(' → ')}` : ''} (${b.rels.join(' → ')})`).join('\n'));
    }
    return parts.join('\n\n');
}

module.exports = { runCrossMode, crossEvidenceText, rrfMerge, rankForTopics, SEARCH_INTENT, DISPLAY,
                   CROSS_DOMAIN_LLM_QUOTA, CROSS_DOMAIN_ANCHORS_PER_DOMAIN, RRF_K };
