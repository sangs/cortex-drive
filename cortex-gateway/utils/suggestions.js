'use strict';
/**
 * Starter questions (S2-102, architecture/question-suggestions-design-2026-11-23.md §3.2): one builder for the empty
 * chat, the greeting and the overview answer. Built from config/suggested_questions.json templates and the titles and
 * bridge entities the asker can open (routing lookups, AP-30), never from content they cannot open. No LLM, no search.
 *
 * Slots (config `starter_slots`, in order):
 *   overview        — the fixed overview question ("What's in Cortex-Drive for me?")
 *   single_newest   — the asker's most recently added visible source (by catalog `added`)
 *   single_other    — a title from a different domain, chosen by the day's seed
 *   across_sources  — a topic found in sources on every side that the asker opens; else another single-source question
 * Rotation is seeded by (user, UTC date, page): stable within a day, different across days; "More ideas" = next page.
 */
const SUGGESTED = require('../config/suggested_questions.json');

const SLOTS = SUGGESTED.starter_slots || [];
const TYPE_FOR_DOMAIN = SUGGESTED.starter_type_for_domain || {};
const SUGGESTIONS_MAX = SLOTS.length;
const MORE_PAGES = SUGGESTED.starter_more_pages || 1;

/** FNV-1a 32-bit: a small deterministic hash for the rotation seed (not security). */
function hash(text) {
    let h = 0x811c9dc5;
    for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
}

const templatesFor = t => (SUGGESTED.by_type || {})[t.type || TYPE_FOR_DOMAIN[t.domain]] || null;
const fill = (template, key, value) => template.split(`{${key}}`).join(value);

/**
 * @param lookups  buildRoutingLookups() result for this asker (titles, bridgeVisible)
 * @param opts     { userId, date ('YYYY-MM-DD', default today UTC), page (0-based), excludeKinds [] }
 * @returns [{ question, kind }] in slot order, at most SUGGESTIONS_MAX
 */
function starterQuestions(lookups, { userId = '', date = new Date().toISOString().slice(0, 10), page = 0, excludeKinds = [] } = {}) {
    const p = Math.max(0, Math.min(Number(page) || 0, MORE_PAGES - 1));
    const seed = i => hash(`${userId}|${date}|${p}|${i}`);
    const titles = [...(lookups.titles || [])]
        .sort((a, b) => (templatesFor(a) ? 0 : 1) - (templatesFor(b) ? 0 : 1) || a.name.localeCompare(b.name));
    const used = new Set();
    const usedDomains = new Set();
    const out = [];

    const ask = (t, i) => {
        const templates = templatesFor(t) || SUGGESTED.default || [];
        if (!templates.length) return null;
        used.add(t.name); usedDomains.add(t.domain);
        return fill(templates[seed(`tpl${i}`) % templates.length], 'title', t.name);
    };
    const pickOther = i => {
        const open = titles.filter(t => !used.has(t.name));
        if (!open.length) return null;
        const domains = [...new Set(open.map(t => t.domain))].sort();
        const fresh = domains.filter(d => !usedDomains.has(d));
        const pool = fresh.length ? fresh : domains;
        const domain = pool[seed(`dom${i}`) % pool.length];
        const inDomain = open.filter(t => t.domain === domain);
        const templated = inDomain.filter(templatesFor);
        const choices = templated.length ? templated : inDomain;
        return ask(choices[seed(`title${i}`) % choices.length], i);
    };

    SLOTS.forEach((slot, i) => {
        if (excludeKinds.includes(slot)) return;
        let question = null;
        let kind = slot;
        if (slot === 'overview') {
            question = SUGGESTED.starter_overview || null;
        } else if (slot === 'single_newest') {
            const dated = titles.filter(t => t.added && !used.has(t.name))
                .sort((a, b) => b.added.localeCompare(a.added) || a.name.localeCompare(b.name));
            question = dated.length ? ask(dated[p % dated.length], i) : null;
            if (!question) { question = pickOther(i); kind = 'single_other'; }
        } else if (slot === 'single_other') {
            question = pickOther(i);
        } else if (slot === 'across_sources') {
            const entities = lookups.bridgeVisible || [];
            const templates = SUGGESTED.starter_across_sources || [];
            if (entities.length && templates.length) {
                const entity = entities[(seed(`ent${i}`) + p) % entities.length];
                question = fill(templates[seed(`tpl${i}`) % templates.length], 'entity', entity);
            } else {
                question = pickOther(i); kind = 'single_other';   // nothing the asker opens on every side
            }
        }
        if (question && !out.some(o => o.question === question)) out.push({ question, kind });
    });
    return out;
}

/** The plain question list used inside an answer ("You could ask"); the overview answer leaves out its own question. */
function suggestedQuestions(lookups, opts = {}) {
    return starterQuestions(lookups, opts).map(s => s.question);
}

module.exports = { starterQuestions, suggestedQuestions, SUGGESTIONS_MAX, MORE_PAGES, hash };
