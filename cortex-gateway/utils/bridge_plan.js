'use strict';
/**
 * Bridge plan (bridge-pipeline-without-model-design-2026-11-13.md §4.1, §4.3). Deterministic: no LLM, no network.
 *
 * For a question routing v2 classified as a bridge, decide which items the search starts from and what it aims at —
 * the step a model performed. Used by /query for routing v2 bridge questions behind BRIDGE_PLAN (utils/bridge_mode.js).
 *
 *   planBridge(question, lookups, opts) →
 *     { kind: 'plan', rule, sources: [{node_id, name, type, domain}], target: {node_id, name} | null,
 *       target_domains: string[], subjects: string[], notes: string[] }
 *     { kind: 'clarify', clarify: { question, kind: 'bridge_source', options: [{label, entity}] } }
 *     { kind: 'no_source' }            nothing the asker can open could start a connection
 *
 * Source rules, first that yields something (§4.1 rule 3; the kind word is tried before the person alone, so
 * "Sangeetha's thought leadership" means her thought leadership, not all of her work):
 *   chosen       an item picked in a clarifying question
 *   named        catalog items named on the from-side
 *   kind         a kind word on the from-side ("thought leadership", "episodes") → visible items of its labels
 *   subject      a person on the from-side → visible items of every bridge-source kind in their work domains
 * With a person on the from-side, kind and subject use only that person's own items (ownershipRequest →
 * MCP person_work_items → opts.ownedIds), never every visible item of the kind.
 *   topic_words  the from-side's remaining words against item names (a paraphrase: "her platform engineering talk")
 * More candidates than the cap are ranked (from-side words in the name, then name) and the rest named in the notes;
 * for topic_words, none or more than the cap is a clarifying question — never a guess.
 *
 * Every name and id comes from routing lookups already filtered to what the asker may open (AP-30). Kind words and
 * limits are manifest data (domain_registry.py, mirrored in config/domain_manifests.json and config/bridge_plan.json).
 */
const CFG = require('../config/intent_keywords.js');
const MANIFESTS = require('../config/domain_manifests.json');
const LIMITS = require('../config/bridge_plan.json');
const { findAll, wordRe } = require('./routing_v2.js');
const { SEARCH_INTENT } = require('./cross_mode.js');

const BRIDGE_PLAN_MAX_SOURCES = LIMITS.max_sources;
const BRIDGE_PLAN_CLARIFY_MAX_OPTIONS = LIMITS.clarify_max_options;
const BRIDGE_AUTO_DOMAINS = 'auto';                 // mirrors domain_registry.BRIDGE_AUTO_DOMAINS
const RULE = { chosen: 'chosen', named: 'named', kind: 'kind', subject: 'subject', topicWords: 'topic_words' };
const CLARIFY_KIND = 'bridge_source';
const CHOICE_KIND = 'source';
const CLARIFY_QUESTION = 'Which item should the connection start from?';
const TOPIC_WORD_MIN_CHARS = 3;
const NOT_SEARCHED_NOTE = (searched, total, rest) =>
    `${searched} of ${total} matching items were searched. Not searched: ${rest.join('; ')}.`;
const OWNERSHIP_UNAVAILABLE_NOTE = subjects =>
    `Could not check which items belong to ${subjects.join(' and ')}; every matching item you can open was used.`;
const EXTRA_TARGETS_NOTE = (used, rest) =>
    `The search aimed at ${used}. Also named in the question, not used as the target: ${rest.join('; ')}.`;

const DIRECTION_RE = (CFG.bridgeDirectionPatternSources || []).map(src => new RegExp(src, 'id'));
const STOP_WORDS = new Set(CFG.groundingStopWords || []);
// kind word → { domain (gateway signal), labels }
const KIND_WORDS = new Map(Object.entries(MANIFESTS).flatMap(([domain, m]) =>
    Object.entries(m.bridge_source_kinds || {}).map(([word, labels]) => [word, { domain, labels }])));
const KIND_LABELS_BY_DOMAIN = Object.fromEntries(Object.entries(MANIFESTS).map(([domain, m]) =>
    [domain, [...new Set(Object.values(m.bridge_source_kinds || {}).flat())]]));

const within = (hit, span) => Boolean(span) && hit.start >= span[0] && hit.end <= span[1];
const byName = (a, b) => a.name.localeCompare(b.name);

/** Sides of the question and the catalog items named on each. */
function parse(q, names) {
    const span = sides(q);
    const fromText = span ? q.slice(span.from[0], span.from[1]) : q;
    const toText = span ? q.slice(span.to[0], span.to[1]) : '';
    const hits = findAll(q, names).sort((a, b) => a.start - b.start);
    const fromHits = span ? hits.filter(h => within(h, span.from)) : hits.slice(0, 1);
    const toHits = span ? hits.filter(h => within(h, span.to)) : hits.slice(1);
    return { span, fromText, toText, fromHits, toHits };
}

/**
 * Whose items to look up before planning (design 2026-11-13 §10 gap 1): when the from-side names a person and no item,
 * the node ids of those people and the labels asked for (the from-side's kind words, else every bridge-source kind of
 * their work domains). null when no lookup is needed. The caller passes the result to MCP person_work_items.
 */
function ownershipRequest(question, lookups) {
    const q = String(question || '');
    const { names } = itemNames(lookups);
    const { fromText, fromHits } = parse(q, names);
    if (fromHits.length) return null;
    const subjects = subjectsIn(fromText, lookups);
    const personIds = subjects.flatMap(n => (lookups.personIds && lookups.personIds.get(n)) || []);
    if (!personIds.length) return null;
    const kinds = kindsIn(fromText);
    const work = name => (lookups.personWork && lookups.personWork.get(name)) || [];
    const labels = kinds.length ? kinds.flatMap(k => k.labels) : subjects.flatMap(work).flatMap(d => KIND_LABELS_BY_DOMAIN[d] || []);
    const unique = [...new Set(labels)].sort();
    return unique.length ? { person_ids: [...new Set(personIds)], labels: unique, subjects } : null;
}

/** The from-side and to-side of the question as [start, end] spans, or null when no direction is stated. */
function sides(q) {
    for (const re of DIRECTION_RE) {
        const m = re.exec(q);
        if (m && m.indices && m.indices.groups.from && m.indices.groups.to) {
            return { from: m.indices.groups.from, to: m.indices.groups.to };
        }
    }
    return null;
}

/** Visible catalog items that can start a search (they carry a node id), by lowercase name and title head. */
function itemNames(lookups) {
    const items = (lookups.titles || []).filter(t => t.node_id);
    const names = new Map(items.map(t => [t.name.toLowerCase(), t]));
    for (const t of items) {
        for (const sep of CFG.routingTitleHeadSeparators || []) {
            const head = t.name.split(sep)[0].trim().toLowerCase();
            if (head !== t.name.toLowerCase() && head.split(/\s+/).length >= (CFG.routingTitleHeadMinWords || 2) && !names.has(head)) {
                names.set(head, t);
            }
        }
    }
    return { items, names };
}

/** People named in a piece of text: full names, or a name part only one visible person has. */
function subjectsIn(text, lookups) {
    const full = findAll(text, lookups.person || new Map()).map(h => h.value);
    if (full.length) return [...new Set(full)];
    return [...new Set((lookups.personPart || []).filter(p => p.pattern.test(text)).map(p => p.name))];
}

function kindsIn(text) {
    return findAll(text, KIND_WORDS).map(h => h.value);
}

function scopeDomainsIn(text) {
    return Object.entries(CFG.routingScopeWords || {})
        .filter(([, words]) => words.some(w => wordRe(w).test(text))).map(([domain]) => domain);
}

function meaningfulWords(text) {
    return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
        .filter(w => w.length >= TOPIC_WORD_MIN_CHARS && !STOP_WORDS.has(w)))];
}

const wordMatches = (item, words) => words.filter(w => wordRe(w).test(item.name)).length;

/** Most from-side words in the name first, then by name — the same order for the same question, every time. */
function rank(items, words) {
    return [...items].sort((a, b) => wordMatches(b, words) - wordMatches(a, words) || byName(a, b));
}

const asSource = t => ({ node_id: t.node_id, name: t.name, type: t.type || null, domain: t.domain });
const asOption = t => ({ label: t.name, entity: { kind: CHOICE_KIND, name: t.name, node_id: t.node_id } });

/** A clarifying-question choice from the browser, kept only if every id is an item this asker can open. */
function resolveBridgeSourceChoice(choice, lookups) {
    if (!choice || choice.kind !== CHOICE_KIND) return [];
    const visible = new Set((lookups.titles || []).map(t => t.node_id).filter(Boolean));
    const ids = Array.isArray(choice.node_ids) ? choice.node_ids : [choice.node_id];
    const ok = ids.filter(id => typeof id === 'string' && visible.has(id));
    return ok.length === ids.length ? ok : [];
}

/**
 * @param {string} question
 * @param {object} lookups  buildRoutingLookups(...) for this asker
 * @param {{resolvedSources?: string[], ownedIds?: Set<string>, ownershipFailed?: boolean}} [opts]
 *        resolvedSources: node ids from resolveBridgeSourceChoice;
 *        ownedIds: node ids of the named people's own items (MCP person_work_items for ownershipRequest's labels);
 *        ownershipFailed: that lookup failed — every visible item of the kind is used and the notes say so.
 */
function planBridge(question, lookups, opts = {}) {
    const q = String(question || '');
    const { items, names } = itemNames(lookups);
    if (!items.length) return { kind: 'no_source' };
    const { fromText, toText, fromHits, toHits } = parse(q, names);
    const notes = [];

    // Target: a named item on the to-side, else the domains the to-side names, else every other domain.
    const targetItem = toHits.length ? toHits[0].value : null;
    if (toHits.length > 1) notes.push(EXTRA_TARGETS_NOTE(targetItem.name, toHits.slice(1).map(h => h.value.name)));
    const work = name => (lookups.personWork && lookups.personWork.get(name)) || [];
    const toDomains = targetItem ? [] : [...new Set([
        ...scopeDomainsIn(toText), ...kindsIn(toText).map(k => k.domain), ...subjectsIn(toText, lookups).flatMap(work),
    ])].filter(d => SEARCH_INTENT[d]).sort();
    const target = targetItem ? { node_id: targetItem.node_id, name: targetItem.name } : null;
    const targetDomains = target ? [] : (toDomains.length ? toDomains.map(d => SEARCH_INTENT[d]) : [BRIDGE_AUTO_DOMAINS]);

    const notTarget = t => !targetItem || t.node_id !== targetItem.node_id;
    const subjects = subjectsIn(fromText, lookups);
    const words = meaningfulWords(fromText);
    const plan = (rule, candidates, ranked) => {
        const ordered = ranked ? rank(candidates, words) : candidates;
        const used = ordered.slice(0, BRIDGE_PLAN_MAX_SOURCES);
        if (ordered.length > used.length) {
            notes.push(NOT_SEARCHED_NOTE(used.length, ordered.length, ordered.slice(used.length).map(t => t.name)));
        }
        return { kind: 'plan', rule, sources: used.map(asSource), target, target_domains: targetDomains, subjects, notes };
    };
    const ofLabels = (domain, labels) => items.filter(t => t.domain === domain && labels.includes(t.type) && notTarget(t));

    // chosen: picked in a clarifying question.
    const chosenIds = new Set(opts.resolvedSources || []);
    const chosen = items.filter(t => chosenIds.has(t.node_id));
    if (chosen.length) return plan(RULE.chosen, chosen, false);

    // named: items named on the from-side, in order of appearance.
    const named = [...new Map(fromHits.map(h => [h.value.node_id, h.value])).values()].filter(notTarget);
    if (named.length) return plan(RULE.named, named, false);

    // A person on the from-side: only their own items (ownedIds), never everyone's items of that kind.
    const owned = subjects.length && opts.ownedIds instanceof Set ? opts.ownedIds : null;
    if (subjects.length && opts.ownershipFailed) notes.push(OWNERSHIP_UNAVAILABLE_NOTE(subjects));
    const unique = list => [...new Map(list.map(t => [t.node_id, t])).values()];

    // kind: a kind word on the from-side.
    const kinds = kindsIn(fromText);
    if (kinds.length) {
        const byKind = owned ? items.filter(t => owned.has(t.node_id) && notTarget(t))
            : unique(kinds.flatMap(k => ofLabels(k.domain, k.labels)));
        if (byKind.length) return plan(RULE.kind, byKind, true);
    } else if (subjects.length) {
        // subject: a person on the from-side → their items of every bridge-source kind of their work domains.
        const bySubject = owned ? items.filter(t => owned.has(t.node_id) && notTarget(t))
            : unique(subjects.flatMap(work).flatMap(d => ofLabels(d, KIND_LABELS_BY_DOMAIN[d] || [])));
        if (bySubject.length) return plan(RULE.subject, bySubject, true);
    }

    // topic_words: a paraphrase. A usable match is 1..cap items; otherwise ask.
    // Only the items matching the most from-side words count ("platform engineering" beats "platform" alone).
    const matching = items.filter(t => notTarget(t) && wordMatches(t, words) > 0);
    const most = Math.max(0, ...matching.map(t => wordMatches(t, words)));
    const byWords = rank(matching.filter(t => wordMatches(t, words) === most), words);
    if (byWords.length && byWords.length <= BRIDGE_PLAN_MAX_SOURCES) return plan(RULE.topicWords, byWords, false);

    // Nothing usable: one clarifying question, options only from what the asker can open.
    const sourceLabels = new Set(Object.values(KIND_LABELS_BY_DOMAIN).flat());
    const pool = byWords.length ? byWords : items.filter(t => notTarget(t) && sourceLabels.has(t.type)).sort(byName);
    const options = (pool.length ? pool : items.filter(notTarget).sort(byName)).slice(0, BRIDGE_PLAN_CLARIFY_MAX_OPTIONS);
    if (!options.length) return { kind: 'no_source' };
    return { kind: 'clarify', clarify: { question: CLARIFY_QUESTION, kind: CLARIFY_KIND, options: options.map(asOption) } };
}

module.exports = { planBridge, ownershipRequest, resolveBridgeSourceChoice, sides, BRIDGE_PLAN_MAX_SOURCES, BRIDGE_PLAN_CLARIFY_MAX_OPTIONS,
    CLARIFY_QUESTION, RULE };
