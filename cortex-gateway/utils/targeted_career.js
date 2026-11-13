'use strict';
/**
 * Targeted career answers (a career question about one item, not the whole career map): which node the curated graph
 * centres on. The node the question searched for wins over type order (validation 2.5, 2026-11-12: "What is
 * Cortex-Drive?" searched "Cortex-Drive", but type order picked the InfoQ talk and the graph showed no Cortex-Drive
 * project).
 */
const ANSWER_TYPE_PRIORITY = ['ThoughtLeadership', 'Publication', 'Project', 'Startup', 'Company', 'Hackathon', 'Certification'];

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * @param {object[]} nodes      the turn's graph nodes
 * @param {string[]} keywords   search keywords used this turn
 * @returns {object|null}
 */
function pickTargetedAnswerNode(nodes, keywords = []) {
    const candidates = ANSWER_TYPE_PRIORITY.flatMap(t => nodes.filter(n => n.type === t && n.name));
    const keys = keywords.map(norm).filter(k => k.length >= 3);
    const byName = test => candidates.find(n => keys.some(k => test(norm(n.name), k)));
    return byName((name, k) => name === k)
        || byName((name, k) => name.includes(k))
        || byName((name, k) => k.includes(name) && name.length >= 3)
        || candidates[0]
        || null;
}

module.exports = { ANSWER_TYPE_PRIORITY, pickTargetedAnswerNode };
