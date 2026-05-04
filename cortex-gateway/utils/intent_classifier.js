'use strict';

/**
 * Phase 1: Regex-based intent classifier.
 * Deterministic, <1ms, zero dependencies.
 *
 * Phase 2 design: layer embedding similarity (Aurelio Semantic Router pattern)
 * on top of this as Stage 1, with this regex approach as Stage 2 fallback.
 * See documents/architecture/intent-classification-research-2026-04-25.md.
 */

const INTENT_PATTERNS = [
    {
        domain_signal: 'podcast',
        pattern: /\bepisode|podcast|guest|interview|transcript|talks?\s+about|discuss/i
    },
    {
        domain_signal: 'cross_domain',
        pattern: /influenc|how\s+did.*affect|how\s+did.*shape|bridge|connects?\s+.*to|relation.*between|impact.*on.*design|decision\s+trace|trace.*from|from.*to.*(?:architecture|security|design|system|platform)|led\s+to|drove.*(?:architecture|design|security)|shaped.*(?:architecture|design|security)/i
    },
    {
        domain_signal: 'career',
        pattern: /career|resume|background|experience|worked\s+at|compan(y|ies)|my\s+role|education|certification|professional/i
    }
];

/**
 * Classify a user query into a domain signal.
 * Order matters: cross_domain patterns must be evaluated before career
 * so "how did my career influence..." routes to cross_domain, not career.
 *
 * @param {string} question
 * @returns {'podcast' | 'career' | 'cross_domain' | 'unknown'}
 */
function classifyDomain(question) {
    const q = question || '';
    for (const { domain_signal, pattern } of INTENT_PATTERNS) {
        if (pattern.test(q)) return domain_signal;
    }
    return 'unknown';
}

module.exports = { classifyDomain, INTENT_PATTERNS };
