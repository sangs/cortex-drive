'use strict';
/**
 * Bridge mode "How these connect" section, written by code from connect_knowledge_on_demand results (validation 1.3,
 * 2026-11-12). The LLM turned plain relationships into causal claims the graph does not contain ("AWS and ML are
 * integral to Cortex-Drive", "the community directly led to the Cortex-Drive project") and left out that the
 * connections are session-only. Cross mode already writes this section by code (utils/cross_mode.js
 * withConnectionsSection); bridge mode now uses the same section.
 *
 * Each target with a bridge_reason is traced back to the source along the result's virtual_links (path order), giving
 * {from, to, via, rels} — exactly the chain the tool found, no interpretation. Paths that end on a grouping category
 * ("filed under Thought Leadership & Community") explain nothing and are left out of the section (they stay on the
 * graph).
 */
const BRIDGE_SECTION_SKIP_TYPES = new Set(['Category']);
const relOf = l => String(l.discovery_reason || l.type || '').replace(/^via\s+/i, '').trim();

/** @returns {{from: string, to: string, via: string[], rels: string[]}[]} */
function bridgesFromConnectResult(result) {
    const nodes = (result && Array.isArray(result.nodes)) ? result.nodes : [];
    const links = (result && Array.isArray(result.virtual_links)) ? result.virtual_links : [];
    const byId = new Map(nodes.map(n => [n.element_id || n.id, n]));
    const incoming = new Map();
    for (const l of links) if (!incoming.has(l.target)) incoming.set(l.target, l);
    const out = [];
    for (const target of nodes) {
        if (!target.bridge_reason || BRIDGE_SECTION_SKIP_TYPES.has(target.type)) continue;
        const chain = [];
        const seen = new Set();
        let id = target.element_id || target.id;
        while (incoming.has(id) && !seen.has(id)) {
            seen.add(id);
            const l = incoming.get(id);
            chain.unshift(l);
            id = l.source;
        }
        const source = byId.get(id);
        if (!chain.length || !source || !source.name || !target.name) continue;
        out.push({
            from: source.name,
            to: target.name,
            via: chain.slice(0, -1).map(l => (byId.get(l.target) || {}).name).filter(Boolean),
            rels: chain.map(relOf),
        });
    }
    return out;
}

module.exports = { bridgesFromConnectResult, BRIDGE_SECTION_SKIP_TYPES };
