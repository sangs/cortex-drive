'use strict';
/**
 * Per-turn grounding from the routing v2 decision (utils/turn_grounding.js; validation run 2026-11-12, failures 4.1 and
 * 5.7). Fixture: real search_enterprise_graph output (tests/fixtures/discovery_search_results.json).
 * Run: node tests/verify_turn_grounding.js (npm test).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { toolsForRoute, discoveryEvidence, meaningfulTerms } = require('../utils/turn_grounding.js');
const { DOCUMENT_SEARCH_TOOL } = require('../utils/document_evidence.js');
const fixture = require('./fixtures/discovery_search_results.json');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };

const tools = ['search_enterprise_graph', DOCUMENT_SEARCH_TOOL, 'connect_knowledge_on_demand'].map(name => ({ type: 'function', function: { name } }));
const names = ts => ts.map(t => t.function.name);

// 1. Tools for the route (4.1)
eq(names(toolsForRoute(tools, { mode: 'single', domains: ['website'] })), ['search_enterprise_graph', 'connect_knowledge_on_demand'], 'website question: no document tool');
eq(names(toolsForRoute(tools, { mode: 'single', domains: ['document'] })), names(tools), 'document question keeps it');
eq(names(toolsForRoute(tools, { mode: 'discovery', domains: [] })), names(tools), 'discovery keeps every tool');
eq(names(toolsForRoute(tools, null)), names(tools), 'routing v2 off: unchanged');

// 2. Evidence in discovery mode (5.7)
eq(meaningfulTerms('What is quantum computing?'), ['quantum', 'computing'], 'question words dropped');
eq(meaningfulTerms("What's DuckLake?"), ['ducklake'], 'apostrophe-s dropped');
const disc = { mode: 'discovery', domains: [] };
const ev = (kw, routing = disc) => discoveryEvidence({ routing, toolArgs: { keyword: kw }, question: kw, toolContent: JSON.stringify(fixture[kw]) });
ok(fixture['quantum computing'].nodes.length > 0, 'fixture: the search does return loose matches for quantum computing');
eq(ev('quantum computing'), false, 'quantum computing: loose matches are not evidence');
eq(ev('blockchain'), false, 'blockchain: semantic neighbour (LangChain) is not evidence');
eq(ev('DuckLake'), true, 'DuckLake: a real match is evidence');
eq(ev('Apache Iceberg'), true, 'Apache Iceberg: real match');
eq(ev('graph databases'), true, '"databases" matches "database"');
eq(ev('quantum computing', { mode: 'single', domains: ['career'] }), true, 'recognised questions keep the existing rule');
eq(ev('quantum computing', null), true, 'routing v2 off: existing rule');
eq(discoveryEvidence({ routing: disc, toolArgs: {}, question: 'What is it?', toolContent: '{"nodes":[{"name":"x"}]}' }), false, 'nothing left to match → no evidence');

// 2b. Routing v2 off (every user but the owner): the v1 classifier recognised nothing → same strict rule (2026-11-12)
const v1 = (kw, unrecognised) => discoveryEvidence({ routing: null, unrecognised, toolArgs: { keyword: kw }, question: kw, toolContent: JSON.stringify(fixture[kw]) });
eq(v1('quantum computing', true), false, 'v1 unrecognised: loose matches are not evidence (5.7 for members/guests)');
eq(v1('blockchain', true), false, 'v1 unrecognised: semantic neighbour is not evidence');
eq(v1('DuckLake', true), true, 'v1 unrecognised: a real match is evidence');
eq(v1('quantum computing', false), true, 'v1 recognised question: existing rule');
eq(discoveryEvidence({ routing: null, unrecognised: true, toolArgs: { source_node_name: 'Ignite' }, question: 'How did X influence Y?', toolContent: '{"nodes":[{"name":"Y"}]}' }), true, 'v1 bridge call (no keyword): existing rule');

// 3. Wiring
const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
ok(/toolsForRoute\(toolsOfferedFor\(\{ isGuest: req\.guestAuth === true \}, mcpToolsDefinitions\), routingV2\)/.test(src), 'tool loop offers toolsForRoute');
ok(/discoveryEvidence\(\{ routing: routingV2, unrecognised: !domainConfident, toolArgs, question, toolContent \}\)/.test(src), 'evidence count applies discoveryEvidence, v1 included');

console.log(`verify_turn_grounding: ${passed} checks passed`);
