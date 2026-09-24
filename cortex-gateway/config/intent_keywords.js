'use strict';

/**
 * Phase R (regex) classification data for cortex-gateway/utils/intent_classifier.js.
 *
 * Governing principle (Phase R keyword-precision audit, 2026-09-21): an entry may only exist
 * here if there is genuine, verifiable evidence it corresponds to a real, recurring pattern in
 * Cortex-Drive's actual data or actual historical usage — documents/user_queries.md canonical
 * text, real live-graph node content, or real historical gateway query logs. Never add a word
 * speculatively because it "might" be asked that way; that's what Phase S (embedding
 * similarity) exists for. Phase R is a fast deterministic cache for known patterns, not a
 * general-purpose classifier — it does not need to, and must not try to, anticipate every
 * phrasing.
 *
 * Three fields, deliberately different in how they're populated:
 *
 * - `keywords` — plain literal strings (words or multi-word phrases), escaped and
 *   boundary-wrapped (`\bword\b`) automatically by intent_classifier.js's loader. THIS IS THE
 *   FIELD TO EDIT for a new evidence-backed phrase. A bare single word is rejected here unless
 *   it's also listed in `singleWordAllowlist` below (see that array's own rule).
 *
 * - `singleWordAllowlist` — evidence-backed single words that are exempt from the "phrases only"
 *   rule. Every entry's comment must cite its specific evidence (which canonical query, which
 *   live node, which historical log count) — this array is a permission list, not a bypass; the
 *   word must ALSO appear in the relevant domain's `keywords` array to take effect.
 *
 * - `patternSource` — a raw regex-source fragment, used exactly as-is (no escaping, no
 *   boundary-wrapping). Reserved for two categories only: (a) genuinely structural sentence-shape
 *   regex that detects a grammatical pattern, not a topic word (e.g. `how\s+did.*affect`) — these
 *   were never candidates for the `keywords` model; (b) evidence-backed words whose real usage
 *   spans multiple inflected forms that boundary-wrapping would silently break (e.g. "discuss"
 *   needs to match discuss/discussed/discussing/discussion; Q1's own evidence quote is "experts
 *   **discussed**", not the bare form) — documented per-entry below with the evidence and why it
 *   couldn't safely become a `keywords` phrase. Do not add anything here without both: real
 *   evidence, AND a documented reason it can't be a boundary-safe `keywords` entry instead.
 *
 * Order is semantically load-bearing: domains are checked top-to-bottom and the first match
 * wins (see intent_classifier.js's _regexClassify). `cross_domain` is checked before `career` on
 * purpose, so "how did my career influence the security architecture..." routes to
 * `cross_domain`, not `career`. Preserve this order — do not alphabetize or "clean up" it.
 *
 * THIS IS THE ONLY FILE A DEVELOPER EDITS to add a new Phase R shortcut — never add patterns
 * inline in intent_classifier.js.
 */
module.exports = {
    // Evidence-backed single words allowed in `keywords` despite being one word. Each entry's
    // evidence was verified live during the 2026-09-21 audit — against documents/user_queries.md,
    // the live Neo4j graph, and 116 real historical gateway queries (30-day window). Do not add a
    // word here without equivalent verification; if evidence doesn't exist yet, the word belongs
    // in Phase S's territory, not Phase R's.
    singleWordAllowlist: [
        'podcast',      // user_queries.md Q1; live Episode content references "Data Engineering Podcast"; 13 real historical queries
        'career',       // user_queries.md Q3 canonical text + domain_signal; 23 real historical queries. KNOWN RISK (documented, not mitigated): could theoretically misroute a podcast-guest-career-content question into this domain (see verify_intent_classification.js's KNOWN_GAPS) — zero real occurrences found across 30 days of historical logs as of this audit. Revisit only if actually observed live, not preemptively — see the Phase R keyword-precision audit discussion for why speculative mitigation was rejected.
        'experience',   // live Category node named "Professional Experience"; Person bio content
        'education',    // live ProfessionalEducation/Institution ("MIT Professional Education"), Category "Education & Continuous Learning"
        'professional', // user_queries.md Q3 domain_signal; live ProfessionalEducation/Institution content
        'infoq',        // user_queries.md Q4 result + Phase 1 semantic-calibration section; live Publication/Certification/PreparatoryNote content
        'authored',     // live "Co-authored expert article" (Certification node) — \b still matches correctly after the "Co-" prefix (hyphen is a non-word boundary)
        'built',        // user_queries.md Q3 canonical text ("what she built"); 21 real historical queries
        'conference',
        'conferences',  // live "demonstrated at RSNA conferences" (Project node) — plural form genuinely used, both forms needed
        'hackathon',
        'hackathons',   // live "Global Hackathons @ JPMorgan Chase" — plural form genuinely used, both forms needed
        'article',
        'articles',     // live Publication/Certification description content
    ],
    domains: [
        {
            domain_signal: 'podcast',
            // "episode" (matches episode/episodes as a prefix) and "discuss" (matches
            // discuss/discussed/discussing/discussion as a substring) are evidence-backed but
            // genuinely multi-form — Q1's own canonical text uses "podcast episodes" and "experts
            // discussed", the inflected forms, not the bare stems. Boundary-wrapping either as a
            // `keywords` entry would silently drop the exact forms the evidence relies on, so
            // they stay here, unanchored, as documented exceptions. episode: Q1 canonical +
            // 15 real historical queries. discuss: Q1 canonical + 34 real historical queries.
            // Removed (2026-09-21 audit, zero evidence found anywhere): interview, transcript,
            // guest (its only live match was a career-side ThoughtLeadership node — backwards as
            // a podcast trigger).
            patternSource: '\\bepisode|discuss',
            keywords: ['podcast', 'talks about']
        },
        {
            domain_signal: 'cross_domain',
            // "influenc" matches influence/influencing/influenced/influencer as one unanchored
            // stem — evidence: 2 real historical queries (incl. a typo variant). Boundary-wrapping
            // a single inflected form would drop the others, so it stays here as a documented
            // exception, same reasoning as podcast's episode/discuss above. The remaining
            // fragments are genuinely structural (sentence-shape, not topic words) — not
            // candidates for the keywords model at all. Two of them
            // (`connects?\s+.*to`, `what.*\bdid.*\bdo\b` in the career domain below) were flagged
            // during the 2026-09-21 audit for a separate precision issue (regex shape, not
            // evidence) and are explicitly deferred to a future pass, not fixed here.
            // Removed (2026-09-21 audit, zero evidence found): "led to". Removed bare "bridge"
            // (real false-positive source — matches unrelated "AWS EventBridge" content in the
            // live graph); canonical Q2 stays fully covered by "decision trace" below plus the
            // `from.*to.*(?:architecture|...)` structural fragment, so no functional loss.
            patternSource: 'influenc|how\\s+did.*affect|how\\s+did.*shape|connects?\\s+.*to|relation.*between|impact.*on.*design|trace.*from|from.*to.*(?:architecture|security|design|system|platform)|drove.*(?:architecture|design|security)|shaped.*(?:architecture|design|security)',
            // decision trace: user_queries.md Q2 canonical text + title; 27 real historical queries.
            keywords: ['decision trace']
        },
        {
            domain_signal: 'career',
            // "publish" matches publish/published/publishing as one unanchored stem — evidence:
            // Q3's own canonical text uses "what she published" (the inflected form), not the
            // bare form; also live "STAR: DataMesh Publishing" content. Same reasoning as the
            // podcast/cross_domain exceptions above — stays here rather than a boundary-wrapped
            // `keywords` entry that would drop "published"/"publishing".
            // Removed (2026-09-21 audit, zero evidence found anywhere): resume, background,
            // worked at, company/companies, my role, certification, wrote, written, startup,
            // blog, speaking at, presentation, founded, created, project (extremely generic word,
            // only weak/unclear-source live matches).
            patternSource: 'publish',
            // institutional memory map / career map: 2026-09-16, fixes the Category-grouping
            // regression against Q3 — see that date's history in this file. thought leadership:
            // 2026-09-21 audit — replaces the old unanchored "thought leader" fragment, which
            // relied on "leadership" containing "leader" as a substring prefix; real evidence
            // (live Category "Thought Leadership & Community", historical log hits) uses
            // "leadership", not the agent noun "leader", so the literal phrase is both safer and
            // more accurate. career/experience/education/professional/infoq/authored/built/
            // conference(s)/hackathon(s)/article(s): see singleWordAllowlist above for evidence.
            keywords: [
                'institutional memory map', 'career map', 'thought leadership',
                'career', 'experience', 'education', 'professional', 'infoq', 'authored', 'built',
                'conference', 'conferences', 'hackathon', 'hackathons', 'article', 'articles'
            ]
        }
    ]
};
