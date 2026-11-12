'use strict';
/**
 * Suggested questions (§4.5, design 2026-11-09): built from config/suggested_questions.json templates and source titles
 * the asker can see (routing lookups, AP-30) — never from content they cannot open. One per domain first, in a stable
 * order, so the same user gets the same suggestions.
 */
const SUGGESTED = require('../config/suggested_questions.json');
const TYPE_FOR_DOMAIN = { document: 'DocumentSource', website: 'WebsiteSource', podcast: 'Episode', career: 'Project' };
const SUGGESTIONS_MAX = 4;

function suggestedQuestions(lookups, max = SUGGESTIONS_MAX) {
    // Titles whose type has its own templates first (a project, a talk, an episode — not a degree), then by name.
    const templatesFor = t => (SUGGESTED.by_type || {})[t.type || TYPE_FOR_DOMAIN[t.domain]];
    const byDomain = {};
    for (const t of [...(lookups.titles || [])].sort((a, b) => (templatesFor(a) ? 0 : 1) - (templatesFor(b) ? 0 : 1)
                                                              || a.name.localeCompare(b.name))) {
        (byDomain[t.domain] = byDomain[t.domain] || []).push(t);
    }
    const out = [];
    for (let round = 0; out.length < max; round++) {
        let added = false;
        for (const domain of Object.keys(TYPE_FOR_DOMAIN)) {
            const t = (byDomain[domain] || [])[round];
            if (!t || out.length >= max) continue;
            const templates = templatesFor(t) || SUGGESTED.default || [];
            if (templates.length) { out.push(templates[round % templates.length].replace('{title}', t.name)); added = true; }
        }
        if (!added) break;
    }
    return out;
}

module.exports = { suggestedQuestions, SUGGESTIONS_MAX };
