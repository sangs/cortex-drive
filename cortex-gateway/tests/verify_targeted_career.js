'use strict';
/**
 * Targeted career answer node (validation 2.5, 2026-11-12): the node the question searched for is the centre of the
 * curated graph, not the first node by type order. Run: node tests/verify_targeted_career.js (npm test).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pickTargetedAnswerNode } = require('../utils/targeted_career.js');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };

const nodes = [
    { name: 'Thought Leadership & Community', type: 'Category' },
    { name: 'InfoQ: Architectural Shifts for Platform Engineers in the Age of AI', type: 'ThoughtLeadership' },
    { name: 'Global Hackathons @ JPMorgan Chase', type: 'Hackathon' },
    { name: 'Cortex-Drive', type: 'Startup' },
];
eq(pickTargetedAnswerNode(nodes, ['Cortex-Drive']).name, 'Cortex-Drive', 'searched name wins over type order (2.5)');
eq(pickTargetedAnswerNode(nodes, ['cortex drive']).name, 'Cortex-Drive', 'case and punctuation ignored');
eq(pickTargetedAnswerNode(nodes, ['InfoQ']).name.startsWith('InfoQ'), true, 'keyword contained in the name');
eq(pickTargetedAnswerNode(nodes, ['Global Hackathons @ JPMorgan Chase role']).type, 'Hackathon', 'name contained in the keyword');
eq(pickTargetedAnswerNode(nodes, ['explainability']).type, 'ThoughtLeadership', 'no name match → type order, as before');
eq(pickTargetedAnswerNode(nodes, []).type, 'ThoughtLeadership', 'no keyword → type order');
eq(pickTargetedAnswerNode([{ name: 'Cortex-Drive', type: 'Category' }], ['Cortex-Drive']), null, 'only answer types qualify');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
ok(/pickTargetedAnswerNode\(accumulatedGraph\.nodes, targetedCareerKeywords\)/.test(src), '/query uses the searched keywords');
ok(/targetedCareerKeywords\.push\(toolArgs\.keyword\)/.test(src), 'keywords recorded from the targeted search');

console.log(`verify_targeted_career: ${passed} checks passed`);
