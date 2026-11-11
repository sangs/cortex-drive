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
const { routeQuestion } = require('../utils/routing_v2.js');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };

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
    r = await route('Hello');
    eq([r.mode, r.domains, r.confident], ['discovery', [], false], 'nothing recognised → discovery');

    console.log(`verify_routing_v2: ${passed} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
