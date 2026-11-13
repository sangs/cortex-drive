'use strict';
/**
 * Bridge mode "How these connect" written by code (validation 1.3, 2026-11-12). Fixture: the real
 * connect_knowledge_on_demand result for "How did Sangeetha's thought leadership influence Cortex-Drive?".
 * Run: node tests/verify_bridge_section.js (npm test).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bridgesFromConnectResult } = require('../utils/bridge_section.js');
const { withConnectionsSection, CONNECTIONS_HEADING } = require('../utils/cross_mode.js');
const fixture = require('./fixtures/bridge_result_1_3.json');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };

const b = bridgesFromConnectResult(fixture);
eq(b.find(x => x.to === 'Cortex-Drive'), { from: 'Ignite Social Learning Community @ JPMC', to: 'Cortex-Drive', via: ['Sangeetha Ramadurai'], rels: ['LED', 'HELD_ROLE'] }, 'two-hop chain traced from the source, in path order');
eq(b.find(x => x.to === 'AWS'), { from: 'Ignite Social Learning Community @ JPMC', to: 'AWS', via: [], rels: ['USES_TOOL'] }, 'one-hop chain');
eq(b.some(x => x.to === 'Thought Leadership & Community'), false, 'grouping category left out of the section');
eq(bridgesFromConnectResult({ nodes: [], virtual_links: [] }), [], 'empty result → no bridges');
eq(bridgesFromConnectResult({ error: 'x' }), [], 'error result → no bridges');
const loop = { nodes: [{ id: 'a', name: 'A', bridge_reason: 'x' }, { id: 'b', name: 'B' }], virtual_links: [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }] };
ok(Array.isArray(bridgesFromConnectResult(loop)), 'a link cycle never loops forever');

const llm = 'Ignite is a learning community.\n\n## How these connect\nThe community directly led to the Cortex-Drive project.';
const out = withConnectionsSection(llm, b);
ok(!/directly led to/.test(out), "the model's own connection claims are removed");
ok(out.includes(`\n${CONNECTIONS_HEADING}\n`) && out.includes('- **Ignite Social Learning Community @ JPMC** ↔ **Cortex-Drive** via Sangeetha Ramadurai (LED → HELD_ROLE)'), 'chain stated as found');
ok(/session-only/.test(out), 'session-only note always present');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
ok(/toolName === 'connect_knowledge_on_demand'\) \{\s*turnBridges\.push\(\.\.\.bridgesFromConnectResult\(parsed\)\)/.test(src), 'bridge results collected per turn');
ok(/finalAnswer = withConnectionsSection\(finalAnswer, unique\)/.test(src), '/query writes the section');
ok(src.indexOf('withConnectionsSection(finalAnswer, unique)') < src.indexOf('auditResponseUrls(finalAnswer'), 'before the URL audit');
const prompt = fs.readFileSync(path.join(__dirname, '..', '..', 'prompts', 'gateway_system_assistant.md'), 'utf8');
ok(/Do NOT describe, list or interpret the connections yourself/.test(prompt), 'prompt: the model does not describe connections');
ok(!/indicating direct intellectual influence/.test(prompt), 'prompt: no causal example left');

console.log(`verify_bridge_section: ${passed} checks passed`);
