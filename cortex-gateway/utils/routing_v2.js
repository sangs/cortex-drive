'use strict';
/**
 * Routing v2 (cross-domain discovery design 2026-11-09 §4.1, §4.5). Deterministic: no LLM, no paid call.
 *
 * Output (backward compatible — `domain` and `confident` mean what classifyDomain's do):
 *   { domain, confident, mode, domains, domain_scores, roles: {subject, topic, container}, content_kind, clarify? }
 *   mode: single | cross | bridge | clarify | discovery
 *
 * Order of decisions (labelling rules G1–G8 in tests/routing_eval/README.md):
 *   1. Bridge phrasing ("how did X influence Y", "relation between") → bridge over the domains named.
 *   2. Document structure ("on page 3 of", "according to the paper") → document.
 *   3. A name part shared by two visible people and no full name → clarify ("Which David?").
 *   4. Explicit scope words (incl. containers: "the … page", "episodes") → those domains; a career person asking
 *      about their own work adds career.
 *   5. A named person → the domains of their own work (catalog `work_domains`).
 *   6. A source title (not also a topic) → its domain.
 *   7. Topics → every domain with content on them (coverage check): one → single, several → cross.
 *   8. Nothing recognised → discovery (AP-21: domain stays the safe default, confident=false).
 * Names come from routing lookups already filtered to what the asker may open (AP-30); coverage is the caller's
 * permission-filtered check (MCP/Bento domain_coverage), so nothing hidden can shape the answer.
 */
const CFG = require('../config/intent_keywords.js');
const { INTENT_PATTERNS } = require('./intent_classifier.js');
const { documentDomainEnabled } = require('./feature_flags');

const SAFE_DEFAULT = 'career';
const CAREER = 'career';
const DOCUMENT = 'document';
const CROSS_DOMAIN = 'cross_domain';
const SCORE = { scope: 1.0, subject: 0.9, title: 0.9, coverage: 0.6, contentKind: 0.1 };

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = phrase => new RegExp(`(?<![\\p{L}\\p{N}])${esc(phrase)}(?![\\p{L}\\p{N}])`, 'iu');
const WORK_RE = (CFG.subjectWorkWords || []).length ? new RegExp(`\\b(?:${CFG.subjectWorkWords.map(esc).join('|')})\\b`, 'i') : null;
const BRIDGE_RE = [
    ...INTENT_PATTERNS.filter(p => p.domain_signal === CROSS_DOMAIN).map(p => p.pattern),
    ...(CFG.routingBridgePatternSource ? [new RegExp(CFG.routingBridgePatternSource, 'i')] : []),
];
const DOCUMENT_STRUCTURE_RE = INTENT_PATTERNS.filter(p => p.domain_signal === DOCUMENT).map(p => p.pattern);

function enabled(domain) { return domain !== DOCUMENT || documentDomainEnabled(); }

/** Longest-first, non-overlapping matches of `names` (lowercase → value) in q, plural tolerant. */
function findAll(q, names) {
    const hits = [];
    const taken = [];
    const keys = [...names.keys()].sort((a, b) => b.length - a.length);
    for (const key of keys) {
        for (const form of new Set([key, key.endsWith('s') ? key.slice(0, -1) : `${key}s`])) {
            const m = wordRe(form).exec(q);
            if (!m) continue;
            const [start, end] = [m.index, m.index + m[0].length];
            if (taken.some(([s, e]) => start < e && end > s)) continue;
            taken.push([start, end]);
            hits.push({ key, value: names.get(key), start, end });
            break;
        }
    }
    return hits;
}

/** Career titles also answer to their head ("Volarisation Engine @ IBM Dev Day 2026" → "Volarisation Engine"). */
function titleNames(lookups) {
    const names = new Map(lookups.entity || []);
    for (const [name, domain] of lookups.entity || []) {
        for (const sep of CFG.routingTitleHeadSeparators || []) {
            const head = name.split(sep)[0].trim();
            if (head !== name && head.split(/\s+/).length >= (CFG.routingTitleHeadMinWords || 2) && !names.has(head)) {
                names.set(head, domain);
            }
        }
    }
    return names;
}

function scopeDomains(q) {
    const out = new Set();
    for (const [domain, words] of Object.entries(CFG.routingScopeWords || {})) {
        if (enabled(domain) && words.some(w => wordRe(w).test(q))) out.add(domain);
    }
    return out;
}

function contentKind(q) {
    const kinds = {};
    for (const [domain, words] of Object.entries(CFG.routingContentKindWords || {})) {
        if (words.some(w => wordRe(w).test(q))) kinds[domain] = true;
    }
    return kinds;
}

function result(mode, domains, extra = {}) {
    const list = [...domains].filter(enabled).sort();
    const domain = mode === 'single' ? list[0]
        : (mode === 'cross' || mode === 'bridge') ? CROSS_DOMAIN : SAFE_DEFAULT;
    return { domain, confident: mode !== 'discovery' && mode !== 'clarify', mode, domains: list, ...extra };
}

/**
 * @param {string} question
 * @param {object} lookups  buildRoutingLookups(...) for this asker
 * @param {{coverage?: (terms: string[]) => Promise<Record<string, boolean>|null>, resolvedPersons?: string[]}} [opts]
 *        coverage: per-domain "does the asker see anything on these terms" (gateway domain names); null = unavailable.
 *        resolvedPersons: people chosen in a clarifying question (only names in the asker's catalog are used).
 */
async function routeQuestion(question, lookups, opts = {}) {
    const q = String(question || '');
    const titles = findAll(q, titleNames(lookups));
    // A shorter topic inside a longer title ("Software" in "Software Engineering Daily") is part of that title.
    const covers = (a, b) => a.start <= b.start && a.end >= b.end;
    const topicHits = findAll(q, lookups.topics || new Map())
        .filter(h => !titles.some(t => covers(t, h) && (t.end - t.start) > (h.end - h.start)));
    const persons = findAll(q, lookups.person || new Map());
    const scope = scopeDomains(q);
    const kinds = contentKind(q);

    // A name that is both a title and a topic is a topic unless the question uses a container word (rule 1).
    const overlaps = (a, b) => a.start < b.end && a.end > b.start;
    const isTopicToo = t => topicHits.some(h => covers(h, t));
    const titleOnly = titles.filter(t => !isTopicToo(t) || scope.has(t.value));
    // A person named inside a title ("Iceberg at Netflix and Beyond with Ryan Blue") is part of that title.
    const insideTitle = p => titles.some(t => overlaps(t, p));
    let subject = persons.filter(p => !insideTitle(p)).map(p => p.value);
    // A person chosen in a clarifying question (§4.5), already checked against the asker's visible catalog.
    const resolved = (opts.resolvedPersons || []).filter(n => [...(lookups.person || new Map()).values()].includes(n));
    if (resolved.length) subject = resolved;
    const outsideTitles = (re) => { const m = re.exec(q); return m && !titles.some(t => m.index < t.end && m.index + m[0].length > t.start); };
    if (!subject.length) {
        const part = (lookups.personPart || []).find(p => outsideTitles(p.pattern));
        if (part) subject = [part.name];
    }
    const shared = !subject.length && !resolved.length ? (lookups.personPartShared || []).find(p => outsideTitles(p.pattern)) : null;
    const work = name => (lookups.personWork && lookups.personWork.get(name)) || [];
    const subjectDomains = new Set(subject.flatMap(work));
    const subjectWork = subject.length && WORK_RE && WORK_RE.test(q);
    const roles = { subject, topic: topicHits.map(t => t.value), container: titleOnly.filter(t => scope.has(t.value)).map(t => t.value) };
    const scores = {};
    const bump = (d, s) => { if (enabled(d)) scores[d] = Math.max(scores[d] || 0, s); };
    for (const d of Object.keys(kinds)) scores[d] = (scores[d] || 0) + SCORE.contentKind;
    const extra = () => ({ domain_scores: scores, roles, content_kind: Object.keys(kinds).sort()[0] || null });

    let coverageUnavailable = false;
    async function covered() {
        if (!topicHits.length || !opts.coverage) return new Set();
        // The words the asker used ("zero trust"), which also match the node's full name.
        const c = await opts.coverage(topicHits.map(t => q.slice(t.start, t.end)));
        if (c == null) { coverageUnavailable = true; return new Set(); }   // never read a failed check as "no data"
        const out = new Set(Object.entries(c || {}).filter(([d, hit]) => hit && enabled(d)).map(([d]) => d));
        out.forEach(d => bump(d, SCORE.coverage));
        return out;
    }

    // 1. Bridge phrasing: the domains named by titles, people and scope words; topics only if nothing else.
    if (BRIDGE_RE.some(re => re.test(q))) {
        const named = new Set([...titleOnly.map(t => t.value), ...subjectDomains, ...scope]);
        titleOnly.forEach(t => bump(t.value, SCORE.title));
        // A topic that is also a title ("Apache Iceberg") names its source domain in a bridge question.
        titles.filter(isTopicToo).forEach(t => named.add(t.value));
        const domains = named.size ? named : await covered();
        return result('bridge', domains, extra());
    }
    // 2. Document structure.
    if (enabled(DOCUMENT) && DOCUMENT_STRUCTURE_RE.some(re => re.test(q))) {
        bump(DOCUMENT, SCORE.scope);
        return result('single', [DOCUMENT], extra());
    }
    // 3. Ambiguous person → one clarifying question, options only from what the asker can see.
    if (shared) {
        const domains = new Set(shared.names.flatMap(work));
        const first = shared.names[0].split(/\s+/)[0];
        return result('clarify', domains, {
            ...extra(),
            clarify: {
                question: `Which ${first}?`,
                options: [...shared.names.map(n => ({ label: n, entity: { kind: 'person', name: n } })), { label: 'Both', entity: null }],
            },
        });
    }
    // 4. Explicit scope.
    if (scope.size) {
        const domains = new Set(scope);
        scope.forEach(d => bump(d, SCORE.scope));
        if (subjectWork && subjectDomains.has(CAREER)) { domains.add(CAREER); bump(CAREER, SCORE.subject); }
        return result(domains.size > 1 ? 'cross' : 'single', domains, extra());
    }
    // 5. A named person → their own work.
    if (subjectDomains.size) {
        const domains = subjectDomains.has(CAREER) ? new Set([CAREER]) : subjectDomains;
        domains.forEach(d => bump(d, SCORE.subject));
        return result(domains.size > 1 ? 'cross' : 'single', domains, extra());
    }
    // 6. Source titles.
    if (titleOnly.length) {
        const domains = new Set(titleOnly.map(t => t.value));
        domains.forEach(d => bump(d, SCORE.title));
        return result(domains.size > 1 ? 'cross' : 'single', domains, extra());
    }
    // 7. Topics → coverage.
    if (topicHits.length) {
        const domains = await covered();
        if (domains.size) return result(domains.size > 1 ? 'cross' : 'single', domains, extra());
        if (coverageUnavailable) return result('discovery', [], { ...extra(), coverage_unavailable: true });
        return result('discovery', [], { ...extra(), no_data: true });
    }
    // 8. Nothing recognised.
    return result('discovery', [], extra());
}

/** What the browser sees of a routing v2 decision (no names the asker cannot open: roles come from their catalog). */
function routingSummary(r) {
    return { version: 'v2', mode: r.mode, domains: r.domains, roles: r.roles, ...(r.no_data ? { no_data: true } : {}) };
}
/** Clarify and "no data" answers (§4.5): no search, no LLM, never cached (no graph). */
function routingV2EarlyResponse(r, fallbackSignal) {
    if (r.mode === 'clarify' && r.clarify) {
        return { answer: r.clarify.question, clarify: r.clarify, raw_data: null, domain_signal: r.domain || fallbackSignal,
                 routing: routingSummary(r) };
    }
    if (r.no_data) {
        const topics = r.roles.topic.length ? r.roles.topic.join(', ') : 'this question';
        return { answer: `No data found in Cortex-Drive for "${topics}".`, raw_data: null, domain_signal: fallbackSignal,
                 routing: routingSummary(r) };
    }
    return null;
}

module.exports = { routeQuestion, routingSummary, routingV2EarlyResponse };
