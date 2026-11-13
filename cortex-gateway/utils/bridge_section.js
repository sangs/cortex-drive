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
const { withConnectionsSection } = require('./cross_mode');

const BRIDGE_SECTION_SKIP_TYPES = new Set(['Category']);
// Bridge answers are written entirely by code (2026-11-13): even with the section above written by code and the prompt
// forbidding it, the model's own paragraph still claimed influence ("directly influenced Cortex-Drive through
// leadership roles"). Every name, type, description, relationship and note below comes from the tool results.
const BRIDGE_ITEM_DESCRIPTION_MAX = 200;
const BRIDGE_ANSWER_INTRO = (count, sources) =>
    `Cortex-Drive found ${count} connection${count === 1 ? '' : 's'} starting from ${sources.map(s => `**${s}**`).join(', ')}. `
    + 'The graph records relationships between items; it does not record influence or cause.';
const BRIDGE_ITEMS_HEADING = '## Items connected';
const BRIDGE_NOTES_HEADING = '## Search notes';
const NO_BRIDGE_ANSWER = "No strong cross-domain bridge was found. The connection may be implicit rather than captured in the graph's current ontology.";
const BRIDGE_SEARCH_FAILED_ANSWER = 'The bridge search did not complete, so no connections can be shown. Please try again.';
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
            fromType: source.type || '',
            toType: target.type || '',
            fromDescription: source.description || '',
            toDescription: target.description || '',
            via: chain.slice(0, -1).map(l => (byId.get(l.target) || {}).name).filter(Boolean),
            rels: chain.map(relOf),
        });
    }
    return out;
}

/**
 * Notes about one bridge search, verbatim from the tool's bridge_notes: target not found, partial result, same
 * author…, or, when it found nothing, the reason (e.g. "No source node found matching …").
 */
function notesFromConnectResult(result) {
    if (!result || typeof result !== 'object') return [];
    // A result without bridge_notes (an MCP revision from before 2026-11-13) that found nothing: its summary is the reason.
    const found = Array.isArray(result.virtual_links) && result.virtual_links.length > 0;
    const notes = Array.isArray(result.bridge_notes) ? result.bridge_notes : (found ? [] : [result.bridge_summary]);
    return notes.filter(n => typeof n === 'string' && n.trim()).map(n => n.trim());
}

const itemLine = (name, type, description) => {
    const text = String(description || '').replace(/\s+/g, ' ').trim();
    const shown = text.length > BRIDGE_ITEM_DESCRIPTION_MAX ? `${text.slice(0, BRIDGE_ITEM_DESCRIPTION_MAX).trimEnd()}…` : text;
    return `- **${name}**${type ? ` (${type})` : ''}${shown ? `: ${shown}` : ''}`;
};

/**
 * The whole bridge-mode answer, written by code. No model prose is kept.
 * @param {{bridges: object[], notes: string[], failed: boolean}} turn  chains and notes collected from this turn's
 *        connect_knowledge_on_demand results; failed = a bridge search returned an error.
 */
function bridgeModeAnswer({ bridges, notes, failed }) {
    const seenPair = new Set();
    const unique = bridges.filter(b => { const k = `${b.from}|${b.to}`; if (seenPair.has(k)) return false; seenPair.add(k); return true; });
    const uniqueNotes = [...new Set(notes)];
    const notesBlock = uniqueNotes.length ? `\n\n${BRIDGE_NOTES_HEADING}\n${uniqueNotes.map(n => `- ${n}`).join('\n')}` : '';
    if (!unique.length) return (failed ? BRIDGE_SEARCH_FAILED_ANSWER : NO_BRIDGE_ANSWER) + notesBlock;
    const items = new Map();
    for (const b of unique) if (!items.has(b.from)) items.set(b.from, itemLine(b.from, b.fromType, b.fromDescription));
    const sources = [...items.keys()];
    for (const b of unique) if (!items.has(b.to)) items.set(b.to, itemLine(b.to, b.toType, b.toDescription));
    const body = `${BRIDGE_ANSWER_INTRO(unique.length, sources)}\n\n${BRIDGE_ITEMS_HEADING}\n${[...items.values()].join('\n')}`;
    return withConnectionsSection(body, unique) + notesBlock;
}

module.exports = { bridgesFromConnectResult, notesFromConnectResult, bridgeModeAnswer, BRIDGE_SECTION_SKIP_TYPES,
                   BRIDGE_ITEM_DESCRIPTION_MAX, NO_BRIDGE_ANSWER, BRIDGE_SEARCH_FAILED_ANSWER };
