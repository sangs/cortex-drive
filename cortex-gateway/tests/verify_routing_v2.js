'use strict';
/**
 * Routing v2 behaviours the labelled set does not isolate (design 2026-11-09 §4.1, §4.5):
 * - clarify options and counts come only from people the asker can see (AP-30); one visible match → no question;
 * - coverage decides topic domains, and an asker whose coverage is empty gets discovery with no_data (never a guess);
 * - the safe default domain is kept for discovery/clarify (AP-21) with confident=false;
 * - scope beats a person; a person with own-work words plus another scope → cross; bridge phrasing → bridge.
 * Run: node tests/verify_routing_v2.js (npm test).
 */
process.env.ENABLE_DOCUMENT_DOMAIN = 'true';
const assert = require('assert');
const { buildRoutingLookups } = require('../utils/intent_classifier.js');
const { routeQuestion, routingV2EarlyResponse, overviewAnswer } = require('../utils/routing_v2.js');
const { createDomainCoverage, resolveClarifyChoice } = require('../utils/domain_coverage.js');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };

const CATALOG = {
    entries: [
        { name: 'David Hughes', domain: 'person', node_id: 'p1', tier: 'org', work_domains: ['podcast'] },
        { name: 'David Soria Parra', domain: 'person', node_id: 'p2', tier: 'org', work_domains: ['podcast'] },
        { name: 'Sangeetha Ramadurai', domain: 'person', node_id: 'p3', tier: 'PUBLIC', work_domains: ['career'] },
        { name: 'Graph database', domain: 'website', node_id: 'w1', tier: 'org' },
        { name: 'Cortex-Drive', domain: 'career', node_id: 'c1', tier: 'PUBLIC' },
        { name: 'Graph Databases', domain: 'topic', node_id: 't1', tier: 'SYSTEM' },
        { name: 'Kafka', domain: 'topic', node_id: 't2', tier: 'SYSTEM' },
    ],
};
const owner = buildRoutingLookups(CATALOG, { isOwner: true, allowedIds: [] });
const sharedOne = buildRoutingLookups(CATALOG, { isOwner: false, allowedIds: ['p2'] });   // sees only David Soria Parra
const coverage = map => async terms => Object.fromEntries(['career', 'podcast', 'website', 'document']
    .map(d => [d, terms.some(t => (map[t.toLowerCase()] || []).includes(d))]));
const full = coverage({ 'graph databases': ['career', 'podcast', 'website'], kafka: ['career', 'podcast'] });
const none = coverage({});
const route = (q, lk = owner, cov = full) => routeQuestion(q, lk, { coverage: cov });

(async () => {
    // Clarify only over visible people
    let r = await route('What has David said about MCP?');
    eq([r.mode, r.clarify.options.map(o => o.label)], ['clarify', ['David Hughes', 'David Soria Parra', 'Both']], 'two visible Davids → ask');
    eq([r.domain, r.confident], ['career', false], 'clarify keeps the safe default domain, not confident (AP-21)');
    r = await route('What has David said about MCP?', sharedOne);
    eq([r.mode, r.domains, r.clarify], ['single', ['podcast'], undefined], 'one visible David → no question, his domain');

    // Coverage decides topics; nothing visible → discovery with no_data
    r = await route('Tell me about Kafka');
    eq([r.mode, r.domains, r.domain], ['cross', ['career', 'podcast'], 'cross_domain'], 'topic → covered domains');
    r = await route('Tell me about Kafka', owner, none);
    eq([r.mode, r.no_data, r.confident], ['discovery', true, false], 'topic nobody can see → no_data, not a guess');
    r = await route('graph databases');
    eq([r.mode, r.domains], ['cross', ['career', 'podcast', 'website']], 'a title that is also a topic → topic');
    r = await route('What does the Graph database page say?');
    eq([r.mode, r.domains], ['single', ['website']], 'container word → the source');

    // Scope, subject, bridge
    r = await route('Which podcasts does Sangeetha listen to?');
    eq([r.mode, r.domains], ['single', ['podcast']], 'scope beats the person');
    r = await route("Find podcasts and Sangeetha's work on graph databases");
    eq([r.mode, r.domains], ['cross', ['career', 'podcast']], 'scope + own work → cross');
    r = await route("How did Sangeetha's thought leadership influence Cortex-Drive?");
    eq([r.mode, r.domains, r.domain], ['bridge', ['career'], 'cross_domain'], 'influence → bridge over named domains');
    r = await route('What is quantum computing?');
    eq([r.mode, r.domains, r.confident], ['discovery', [], false], 'nothing recognised → discovery');

    // §4.5: small talk, out of scope, open discovery, pronoun, ambiguous source — no search, safe default domain
    r = await route('Hello');
    eq([r.mode, r.domain, r.confident], ['small_talk', 'career', false], 'small talk');
    r = await route("What's the weather today?");
    eq([r.mode, r.out_of_scope], ['out_of_scope', 'check the weather'], 'out of scope');
    r = await route('What is the weather like for Kafka meetups?');
    eq(r.mode, 'cross', 'a graph topic wins over an out-of-scope word');
    r = await route("What's new?");
    eq(r.mode, 'overview', 'open discovery → overview');
    r = await route('Can you show me her resume');
    eq([r.mode, r.clarify.kind, r.clarify.options], ['clarify', 'pronoun', []], 'pronoun with nothing to point to → ask');
    r = await routeQuestion('What has she written?', owner, { coverage: full, history: [{ role: 'user', content: 'Tell me about Sangeetha Ramadurai' }] });
    eq([r.mode, r.roles.subject], ['single', ['Sangeetha Ramadurai']], 'pronoun resolved from the conversation');
    r = await routeQuestion('What has she written?', sharedOne, { coverage: full, history: [{ role: 'user', content: 'Tell me about David Hughes' }] });
    eq(r.mode, 'clarify', 'a person the asker cannot see is never taken from history');
    const twoPapers = buildRoutingLookups({ entries: [
        { name: 'BERT: Pre-training', domain: 'document', node_id: 'd1', tier: 'org', short_name: 'BERT' },
        { name: 'BERT: Revisited', domain: 'document', node_id: 'd2', tier: 'org', short_name: 'BERT' }] }, { isOwner: true });
    r = await routeQuestion('What does the BERT paper say about pre-training?', twoPapers, { coverage: full });
    eq([r.mode, r.clarify.kind, r.clarify.options.map(o => o.label)], ['clarify', 'source', ['BERT: Pre-training', 'BERT: Revisited']], 'ambiguous source → ask');

    // Early answers: written by code, with suggestions
    const sg = ['What is Cortex-Drive?'];
    const st = routingV2EarlyResponse(await route('Hello'), 'career', { suggestions: sg });
    ok(st.answer.includes('What is Cortex-Drive?') && st.raw_data === null, 'small talk answer with suggestions');
    ok(routingV2EarlyResponse(await route("What's the weather today?"), 'career', { suggestions: sg }).answer.includes("it can't check the weather"), 'out-of-scope answer');
    eq(routingV2EarlyResponse(await route("What's new?"), 'career', { suggestions: sg }), null, 'overview needs the Bento call');
    const ov = overviewAnswer({ domains: [{ domain: 'podcast', items: 10, top_topics: ['DuckDB'] }],
                                recent_sources: [{ title: 'Apache Iceberg', date: '2026-09-24T18:11:24' }], recent_episodes: [] }, sg);
    ok(ov.includes('**Podcasts**: 10 items — top topics: DuckDB') && ov.includes('Apache Iceberg (2026-09-24)'), 'overview written by code');
    ok(overviewAnswer({ domains: [], recent_sources: [], recent_episodes: [] }, []).includes('Nothing is visible to you yet'), 'empty overview');

    // A failed coverage check is never "no data"
    r = await route('Tell me about Kafka', owner, async () => null);
    eq([r.mode, r.no_data, r.coverage_unavailable], ['discovery', undefined, true], 'coverage unavailable → fall back, not no_data');
    eq(routingV2EarlyResponse(r, 'career'), null, 'no early answer when coverage is unavailable');
    r = await route('Tell me about Kafka', owner, none);
    eq(routingV2EarlyResponse(r, 'career').answer, 'No data found in Cortex-Drive for "Kafka".', 'no_data → deterministic answer');
    r = await route('What has David said about MCP?');
    const early = routingV2EarlyResponse(r, 'career');
    eq([early.answer, early.raw_data, early.clarify.options.length], ['Which David?', null, 3], 'clarify → question + options, no graph (never cached)');

    // Clarify choice: only visible people; then the question routes to that person
    eq(resolveClarifyChoice({ kind: 'person', name: 'David Soria Parra' }, owner), ['David Soria Parra'], 'visible choice kept');
    eq(resolveClarifyChoice({ kind: 'person', name: 'David Hughes' }, sharedOne), [], 'choice of a hidden person dropped');
    eq(resolveClarifyChoice({ kind: 'person', names: ['David Hughes', 'Nobody'] }, owner), [], 'any unknown name → whole choice dropped');
    r = await routeQuestion('What has David said about MCP?', owner, { coverage: full, resolvedPersons: ['David Soria Parra'] });
    eq([r.mode, r.domains, r.roles.subject], ['single', ['podcast'], ['David Soria Parra']], 'chosen person → no second question');

    // A domain the check did not report is unknown, not empty (production Bento without the document domain)
    r = await route('Tell me about Kafka', owner, async () => ({ career: false, podcast: false, website: false }));
    eq([r.no_data, r.coverage_unavailable], [undefined, true], 'document not reported → no "no data"');
    // The owner sees SYSTEM/PUBLIC entries even when someone else is their owner_id
    const sys = buildRoutingLookups({ entries: [{ name: 'Graph Databases', domain: 'topic', node_id: 't', tier: 'SYSTEM', owner_id: 'user_SYSTEM_ADMIN' }] },
                                    { isOwner: true, allowedIds: [], userId: 'owner' });
    eq(sys.topics.has('graph databases'), true, 'owner keeps built-in topics');

    // Coverage client: maps domains, null on failure / timeout / no requester
    const okCov = createDomainCoverage({ post: async () => ({ coverage: { professional: true, podcast: false, extra: true } }), log: { warn() {} } });
    eq(await okCov({ tenantId: 't', userId: 'u' }, ['kafka']), { career: true, podcast: false }, 'professional → career; unknown keys dropped');
    eq(await okCov({ tenantId: 't', userId: '' }, ['kafka']), null, 'no requester → null (never a whole-tenant call)');
    const slow = createDomainCoverage({ post: () => new Promise(r2 => setTimeout(r2, 200)), timeoutMs: 20, log: { warn() {} } });
    eq(await slow({ tenantId: 't', userId: 'u' }, ['kafka']), null, 'slow → null');
    const bad = createDomainCoverage({ post: async () => { throw new Error('500'); }, log: { warn() {} } });
    eq(await bad({ tenantId: 't', userId: 'u' }, ['kafka']), null, 'error → null');

    console.log(`verify_routing_v2: ${passed} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
