'use strict';

/**
 * Regression check for cortex-gateway/utils/intent_classifier.js's Phase R (regex) matching,
 * and the confident/safe-default distinction added 2026-09-18.
 *
 * No test framework — plain Node `assert`, matching this repo's existing lightweight,
 * framework-free testing style (see tdd/). Run: `node tests/verify_intent_classification.js`
 * or `npm test` from cortex-gateway/.
 *
 * Only exercises Phase B/R/E (no OpenAI client is passed to classifyDomain, so Phase S never
 * fires — every case here is either a confident free-phase hit, or falls all the way through
 * to the safe default with confident=false) — this suite is specifically about the
 * deterministic, free phases, not the embedding fallback itself.
 */

const assert = require('assert');
const { classifyDomain } = require('../utils/intent_classifier.js');

// Each case documents WHY it's here, not just what it asserts — see individual comments.
const CASES = [
    // Canonical Q1/Q2/Q3 phrasings, verbatim from documents/user_queries.md — must keep working
    // exactly as before the 2026-09-16 externalization (zero behavior change for existing
    // patternSource content).
    {
        query: 'What have experts discussed about graph-native AI architectures and knowledge graphs in the podcast episodes?',
        expected: 'podcast',
        expectedConfident: true,
        why: 'Q1 canonical phrasing (user_queries.md)'
    },
    {
        query: "Show the institutional memory map of Sangeetha Ramadurai—her career, what she built, and what she published.",
        expected: 'career',
        expectedConfident: true,
        why: 'Q3 canonical phrasing (user_queries.md) — contains "career" literally, must keep matching patternSource directly'
    },

    // The actual bug this pass fixes: short paraphrases of Q3 with no "career" keyword had no
    // deterministic Phase R match before the 2026-09-16 `keywords` addition, and fell through to
    // wording-sensitive Phase S — this is what caused the Category-grouping regression.
    {
        query: 'institutional memory map of Sangeetha Ramadurai',
        expected: 'career',
        expectedConfident: true,
        why: 'New keyword: short Q3 paraphrase with no career-vocabulary word — must now hit Phase R deterministically'
    },
    {
        query: 'Show career map of Sangeetha',
        expected: 'career',
        expectedConfident: true,
        why: 'New keyword: "career map" phrase — also present as a Phase S prototype in intent_registry.json, now additionally deterministic via Phase R'
    },

    // Order-dependence non-regression: cross_domain must still be checked before career, so a
    // query containing the word "career" that is actually asking about cross-domain influence
    // does not get misrouted by the career patternSource. Not a new fix — locks in existing
    // behavior that the new `keywords` additions must not disturb.
    {
        query: 'How did my career influence the zero-trust security architecture of Cortex-Drive?',
        expected: 'cross_domain',
        expectedConfident: true,
        why: 'Pre-existing Phase R order guarantee (podcast, cross_domain, career) — must survive the externalization unchanged'
    },

    // Podcast-domain sanity check with no ambiguity — must not be affected by the career
    // additions at all.
    {
        query: 'Featuring a guest interview about the episode transcript',
        expected: 'podcast',
        expectedConfident: true,
        why: 'Unrelated domain sanity check — confirms the career `keywords` addition has zero effect on podcast matching'
    },

    // 2026-09-18 fix: a broad topic query with no named entity and no domain-specific vocabulary
    // must fall through to the safe default with confident=false, NOT be treated as a genuine
    // career match. This is the actual live bug — "AI ethics and governance work from known
    // sources" returned a clarifying question instead of an answer, because domain_signal=career
    // (safe-default) triggered the strict career-only tool-calling instruction, contradicting the
    // system prompt's own Tier 3 (UNIVERSAL DISCOVERY) guidance. Phase S is skipped in this suite
    // (no OpenAI client), so this exercises the B/R/E-all-miss -> confident:false path directly;
    // the live query additionally misses Phase S's 0.75 threshold (scored 0.378), covered by the
    // live-verification step in the design doc, not by this offline suite.
    {
        query: 'AI ethics and governance work from known sources',
        expected: 'career',
        expectedConfident: false,
        why: 'The actual live bug (2026-09-17) — nothing matches B/R/E, must resolve to safe-default career with confident=false, not a real career match'
    }
];

// Known, pre-existing gap — NOT fixed by this pass, deliberately out of scope (see the "Phase R
// keyword precision audit" task referenced in cortex-gateway/config/intent_keywords.js). Printed
// for visibility, not asserted — a failing assertion here would incorrectly imply this pass was
// supposed to fix it.
const KNOWN_GAPS = [
    {
        query: 'Tell me what was said about the speaker background in that segment',
        currentlyClassifiesAs: 'career',
        arguablyShouldBe: 'podcast',
        why: 'No podcast-signal word (guest/interview/podcast/episode/discuss) present, so the bare "background" keyword in patternSource wins — exactly the ambiguity discussed 2026-09-16. Tracked for the future keyword-precision-audit task, not fixed here.'
    }
];

async function main() {
    let failures = 0;

    console.log(`Running ${CASES.length} intent classification regression cases...\n`);
    for (const { query, expected, expectedConfident, why } of CASES) {
        const { domain, confident } = await classifyDomain(query);
        try {
            assert.strictEqual(domain, expected, `expected domain "${expected}", got "${domain}"`);
            assert.strictEqual(confident, expectedConfident, `expected confident=${expectedConfident}, got ${confident}`);
            console.log(`  OK   ${JSON.stringify(query).slice(0, 70)}`);
        } catch (e) {
            failures++;
            console.error(`  FAIL ${JSON.stringify(query).slice(0, 70)}`);
            console.error(`       ${e.message}`);
            console.error(`       why this case exists: ${why}`);
        }
    }

    console.log(`\nKnown gaps (documented, not asserted — ${KNOWN_GAPS.length}):`);
    for (const gap of KNOWN_GAPS) {
        const { domain } = await classifyDomain(gap.query);
        const stillPresent = domain === gap.currentlyClassifiesAs;
        console.log(`  ${stillPresent ? '(unchanged)' : '(!! changed, update this note)'} ${JSON.stringify(gap.query).slice(0, 60)} -> ${domain}`);
        console.log(`       ${gap.why}`);
    }

    console.log(`\n${CASES.length - failures}/${CASES.length} passed.`);
    if (failures > 0) {
        process.exitCode = 1;
    }
}

main().catch(e => {
    console.error('Test run crashed:', e);
    process.exitCode = 1;
});
