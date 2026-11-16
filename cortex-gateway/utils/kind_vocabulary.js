'use strict';
/**
 * Kind vocabulary (bridge-pipeline-without-model-design-2026-11-13.md §13). Deterministic: no LLM, no network.
 *
 * A kind word names a type of item ("episode", "paper", "article"). Each domain manifest lists its kind words
 * (`bridge_source_kinds`: word → labels); the same word may belong to several domains ("article": career thought
 * leadership, website pages, documents). Nothing here lists ambiguous words: a word is ambiguous when the manifests
 * give it more than one meaning.
 *
 *   buildKindVocabulary(manifests) → Map word → [{ domain, labels }]   (domain = the gateway's routing name)
 *   kindMentions(text)             → [{ word, start, end, meanings }]  (plural tolerant, longest first)
 *   resolveKind(mention, ctx)      → { meanings, step } | { ask: true, meanings, step: 'e' }
 *
 * Order for a word with several meanings (§13.3), first that settles it wins:
 *   a  another kind word on the same side has a single meaning among these
 *   b  the side's other words match item names of only one meaning (most matching words)
 *   c  a named person on the side: their catalog work domains
 *   d  few enough visible items across the meanings (≤ maxAll): all of them
 *   e  otherwise ask which kind (callers that must not ask — the target side — use all meanings instead)
 * Meanings with no item the asker can open are dropped first (AP-30), so nothing reveals hidden content.
 * Used by utils/bridge_plan.js; routing's content-kind words move here in Phase C (tracker RV-6).
 */
const CFG = require('../config/intent_keywords.js');
const MANIFESTS = require('../config/domain_manifests.json');
const { externalSignal } = require('./domain_ids');
const { findAll, wordRe } = require('./routing_v2.js');

const KIND_STEP = { a: 'a', b: 'b', c: 'c', d: 'd', e: 'e' };
const TOPIC_WORD_MIN_CHARS = 3;
const STOP_WORDS = new Set(CFG.groundingStopWords || []);

function buildKindVocabulary(manifests = MANIFESTS) {
    const vocab = new Map();
    for (const [id, m] of Object.entries(manifests)) {
        const domain = externalSignal(id) || id;
        for (const [word, labels] of Object.entries(m.bridge_source_kinds || {})) {
            const key = word.trim().toLowerCase();
            if (!vocab.has(key)) vocab.set(key, []);
            vocab.get(key).push({ domain, labels: [...labels] });
        }
    }
    return vocab;
}

const VOCAB = buildKindVocabulary();
// Words of the kind words themselves ("thought", "leadership", "episode(s)") never narrow a kind.
const KIND_TOKENS = new Set([...VOCAB.keys()].flatMap(k => k.split(/\s+/)).flatMap(w => [w, `${w}s`]));

/** Every bridge-source label per routing domain. */
const labelsByDomain = (vocab = VOCAB) => {
    const out = {};
    for (const meanings of vocab.values()) {
        for (const { domain, labels } of meanings) out[domain] = [...new Set([...(out[domain] || []), ...labels])];
    }
    return out;
};

function kindMentions(text, vocab = VOCAB) {
    return findAll(String(text || ''), vocab)
        .sort((a, b) => a.start - b.start)
        .map(h => ({ word: h.key, start: h.start, end: h.end, meanings: h.value }));
}

function meaningfulWords(text) {
    return [...new Set((String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
        .filter(w => w.length >= TOPIC_WORD_MIN_CHARS && !STOP_WORDS.has(w)))];
}

const wordMatches = (item, words) => words.filter(w => wordRe(w).test(item.name)).length;

/** The words of a side that can pick an item: not stop words, kind words or the named people's names. */
function narrowingWords(text, subjects = []) {
    const names = new Set(subjects.flatMap(s => meaningfulWords(s)));
    return meaningfulWords(text).filter(w => !KIND_TOKENS.has(w) && !names.has(w));
}

const itemsOf = (items, meaning) => items.filter(t => t.domain === meaning.domain && meaning.labels.includes(t.type));

/**
 * @param {{word, meanings}} mention
 * @param {object} ctx
 * @param {string} ctx.text         the side's text
 * @param {Array}  ctx.items        items the asker can open (routing lookups titles with node ids)
 * @param {Array}  [ctx.others]     the other kind mentions on the same side
 * @param {string[]} [ctx.subjects] people named on the side
 * @param {(name: string) => string[]} [ctx.work]  a person's routing work domains
 * @param {number} ctx.maxAll       step d ceiling (BRIDGE_PLAN_MAX_SOURCES)
 * @param {boolean} [ctx.mayAsk=true]
 */
function resolveKind(mention, ctx) {
    const items = ctx.items || [];
    const visible = mention.meanings.filter(m => itemsOf(items, m).length > 0);
    if (visible.length <= 1) return { meanings: visible, step: null };
    const domains = new Set(visible.map(m => m.domain));
    const keep = ds => visible.filter(m => ds.has(m.domain));

    // a: another kind word on the side with one meaning among these.
    const single = new Set((ctx.others || []).filter(o => o !== mention)
        .map(o => o.meanings.filter(m => domains.has(m.domain) && itemsOf(items, m).length))
        .filter(ms => ms.length === 1).map(ms => ms[0].domain));
    if (single.size === 1) return { meanings: keep(single), step: KIND_STEP.a };

    // b: the side's other words match item names of only one meaning.
    const words = narrowingWords(ctx.text, ctx.subjects || []);
    if (words.length) {
        const best = visible.map(m => [m.domain, Math.max(0, ...itemsOf(items, m).map(t => wordMatches(t, words)))]);
        const top = Math.max(...best.map(([, n]) => n));
        const winners = best.filter(([, n]) => n === top).map(([d]) => d);
        if (top > 0 && winners.length === 1) return { meanings: keep(new Set(winners)), step: KIND_STEP.b };
    }

    // c: a named person's work domains.
    const work = new Set((ctx.subjects || []).flatMap(s => (ctx.work ? ctx.work(s) : [])).filter(d => domains.has(d)));
    if (work.size) return { meanings: keep(work), step: KIND_STEP.c };

    // d: few enough to search all; e: ask (or, where asking is not allowed, use all).
    const total = visible.reduce((n, m) => n + itemsOf(items, m).length, 0);
    if (total <= ctx.maxAll) return { meanings: visible, step: KIND_STEP.d };
    if (ctx.mayAsk === false) return { meanings: visible, step: KIND_STEP.e };   // target side: every meaning's domain
    return { ask: true, meanings: visible, step: KIND_STEP.e };
}

module.exports = { buildKindVocabulary, kindMentions, resolveKind, labelsByDomain, narrowingWords, meaningfulWords,
    wordMatches, itemsOf, KIND_STEP, VOCAB };
