'use strict';
/**
 * Grounding guard (Invariant 11, AP-25; 2026-11-10): a new, non-small-talk question must call a data tool before it is
 * answered. Run: node tests/verify_grounding_guard.js (npm test).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isSmallTalk, mustGround, toolChoiceFor, clearGraph } = require('../utils/grounding_guard.js');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };

for (const q of ['Hello', 'hi there!', 'Thanks so much', 'good morning', 'ok']) eq(isSmallTalk(q), true, `small talk: ${q}`);
for (const q of ['What is self-attention?', 'hello, what is Neo4j?', 'Thanks — and what about Kafka?', 'graph databases']) {
    eq(isSmallTalk(q), false, `not small talk: ${q}`);
}
eq(mustGround('What is self-attention?', []), true, 'new question → must call a data tool');
eq(mustGround('What is self-attention?', undefined), true, 'no history field → new question');
eq(mustGround('What is self-attention?', [{ role: 'user', content: 'x' }]), false, 'follow-up may use the earlier evidence');
eq(mustGround('Hello', []), false, 'small talk is not forced');
eq([toolChoiceFor(1, true), toolChoiceFor(2, true), toolChoiceFor(1, false)], ['required', 'auto', 'auto'], 'required on the first call only');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
ok(/tool_choice: toolChoiceFor\(loopCount, groundThisTurn\)/.test(src), '/query loop uses the guard');
ok(/if \(groundThisTurn && dataToolCalls === 0\) \{[\s\S]{0,200}NO_DATA_FOUND_ANSWER\(question\)/.test(src), 'no data tool → "No data found"');
ok(src.indexOf('groundThisTurn && dataToolCalls === 0') < src.indexOf('auditResponseUrls(finalAnswer'), 'guard runs before the URL audit');

// "No data found" answers carry an empty graph (validation 5.7, 2026-11-12).
const g = { nodes: [{ id: 1 }], links: [{ source: 1, target: 1 }], virtual_links: [{ source: 1, target: 1 }] };
eq(clearGraph(g), { nodes: [], links: [], virtual_links: [] }, 'clearGraph empties nodes, links, virtual links');
ok(/if \(finalAnswer === NO_DATA_FOUND_ANSWER\(question\)\) \{[\s\S]{0,120}clearGraph\(accumulatedGraph\)/.test(src), 'no-data answer clears the graph');
ok(src.indexOf('clearGraph(accumulatedGraph)') < src.indexOf('const hasGraph = accumulatedGraph.nodes.length > 0'), 'cleared before raw_data is built');

console.log(`verify_grounding_guard: ${passed} checks passed`);
