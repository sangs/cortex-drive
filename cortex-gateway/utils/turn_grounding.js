'use strict';
/**
 * Per-turn grounding rules driven by the routing v2 decision (AP-25, Invariant 11; validation run 2026-11-12).
 *
 * 1. toolsForRoute: in single mode the LLM is offered only the tools for the routed domain — the document passage search
 *    is withheld unless the route includes documents (4.1: a website question went to the document tool).
 * 2. discoveryEvidence: when routing found nothing of the question in the asker's catalog (mode "discovery"), a tool
 *    result counts as evidence only if it contains every meaningful word of what was searched for, as whole words.
 *    Loose keyword and semantic matches (5.7: "quantum computing" → a company and projects; "blockchain" → LangChain)
 *    are not evidence, so the answer becomes "No data found" instead of general knowledge.
 */
const { groundingStopWords } = require('../config/intent_keywords');
const { DOCUMENT_SEARCH_TOOL } = require('./document_evidence');

const STOP = new Set(groundingStopWords);
const MIN_TERM_CHARS = 3;
const toolName = t => (t && t.function && t.function.name) || (t && t.name);

function toolsForRoute(tools, routing) {
    if (!routing || routing.mode !== 'single' || (routing.domains || []).includes('document')) return tools;
    return tools.filter(t => toolName(t) !== DOCUMENT_SEARCH_TOOL);
}

function meaningfulTerms(text) {
    return [...new Set(String(text || '').toLowerCase().replace(/['’]s\b/g, '').split(/[^a-z0-9+#.-]+/)
        .map(w => w.replace(/^[.-]+|[.-]+$/g, ''))
        .filter(w => w.length >= MIN_TERM_CHARS && !STOP.has(w)))];
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** "databases" also matches "database", and the other way round. */
function termPattern(term) {
    const stem = term.length > 4 && term.endsWith('s') ? term.slice(0, -1) : term;
    return new RegExp(`(^|[^a-z0-9])${escapeRe(stem)}s?($|[^a-z0-9])`, 'i');
}

/**
 * @param {object} p
 * @param {object|null} p.routing      routing v2 result (null when routing v2 is off for this user)
 * @param {object} p.toolArgs          the LLM's tool arguments (keyword / question)
 * @param {string} p.question          the user's question (fallback for the search terms)
 * @param {string} p.toolContent       the tool result after the domain guard
 */
function discoveryEvidence({ routing, toolArgs = {}, question, toolContent }) {
    if (!routing || routing.mode !== 'discovery') return true;
    const terms = meaningfulTerms(toolArgs.keyword || toolArgs.question || question);
    if (!terms.length) return false;
    const text = String(toolContent || '');
    return terms.every(t => termPattern(t).test(text));
}

module.exports = { toolsForRoute, discoveryEvidence, meaningfulTerms };
