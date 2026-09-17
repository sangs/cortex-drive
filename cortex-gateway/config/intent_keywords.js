'use strict';

/**
 * Phase R (regex) classification data for cortex-gateway/utils/intent_classifier.js.
 *
 * Two fields per domain, deliberately different in how safe they are to extend:
 *
 * - `patternSource` — a raw regex-source fragment, used exactly as-is (no escaping, no
 *   boundary-wrapping). This is today's pre-2026-09-16 pattern content, migrated verbatim
 *   during the externalization — NOT audited for keyword-ambiguity precision (e.g. the bare
 *   word "career" here can misroute a question about a podcast guest's career, discussed in an
 *   episode, into this domain instead of `podcast`). That audit is a separate, deliberate task
 *   ("Phase R keyword precision audit", tracked in the design doc) — do not add new bare
 *   single-word entries to `patternSource`; use `keywords` instead.
 *
 * - `keywords` — plain literal strings (words or multi-word phrases), escaped and
 *   boundary-wrapped automatically by intent_classifier.js's loader. This is the ONLY field
 *   future additions should use. Rule: every entry must be a multi-word phrase or an
 *   unambiguous proper noun — never a bare common word that could plausibly appear in another
 *   domain's natural phrasing (see the loader's single-word rejection check). Keep each domain's
 *   `keywords` list short (roughly 10-12 entries) — Phase R exists as a fast, deterministic
 *   shortcut for the handful of unambiguous phrasings a domain has, not as the general-purpose
 *   classifier. Anything beyond that is what Phase S (embedding similarity) is for.
 *
 * THIS IS THE ONLY FILE A DEVELOPER EDITS to add a new Phase R shortcut — never add patterns
 * inline in intent_classifier.js.
 *
 * Order is semantically load-bearing: domains are checked top-to-bottom and the first match
 * wins (see intent_classifier.js's _regexClassify). `cross_domain` is checked before `career` on
 * purpose, so "how did my career influence the security architecture..." routes to
 * `cross_domain`, not `career`. Preserve this order — do not alphabetize or "clean up" it.
 */
module.exports = {
    domains: [
        {
            domain_signal: 'podcast',
            // Migrated verbatim from intent_classifier.js (pre-2026-09-16) — unaudited, see the
            // module doc comment above.
            patternSource: '\\bepisode|podcast|guest|interview|transcript|talks?\\s+about|discuss'
        },
        {
            domain_signal: 'cross_domain',
            // Migrated verbatim — unaudited, see the module doc comment above.
            patternSource: 'influenc|how\\s+did.*affect|how\\s+did.*shape|bridge|connects?\\s+.*to|relation.*between|impact.*on.*design|decision\\s+trace|trace.*from|from.*to.*(?:architecture|security|design|system|platform)|led\\s+to|drove.*(?:architecture|design|security)|shaped.*(?:architecture|design|security)'
        },
        {
            domain_signal: 'career',
            // Migrated verbatim — unaudited, see the module doc comment above. Covers core
            // career vocabulary + thought leadership + project/startup/hackathon vocabulary +
            // person-centric action queries.
            patternSource: 'career|resume|background|experience|worked\\s+at|compan(y|ies)|my\\s+role|education|certification|professional|publish|wrote|written|article|infoq|conference|hackathon|startup|project|thought\\s+leader|blog|speaking\\s+at|presentation|authored|what.*\\bdid.*\\bdo\\b|what.*\\bhas.*\\bbuilt\\b|founded|built\\b|created\\b',
            // New 2026-09-16 — fixes a confirmed regression against documents/user_queries.md's
            // Q3 spec: short paraphrases of the identity-map query ("institutional memory map of
            // <person>") had no deterministic Phase R match and fell through to wording-sensitive
            // Phase S embedding similarity, which could classify differently than the canonical
            // phrasing (which contains "career" and matched patternSource directly). These are
            // multi-word phrases, not bare words, per the keyword-selection discipline above.
            keywords: ['institutional memory map', 'career map']
        }
    ]
};
