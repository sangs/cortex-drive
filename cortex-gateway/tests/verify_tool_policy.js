'use strict';

/**
 * S2-20 / AP-26: the chat tool policy (utils/tool_policy.js). Run: `node tests/verify_tool_policy.js`
 * or `npm test`. Plain Node `assert`, like verify_intent_classification.js.
 *
 * The real tool list is read from index.js source (index.js starts the server when required), so
 * the guest allowlist can't drift from it: every allowed name must exist, run_cypher_query must not.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { GUEST_ALLOWED_TOOLS, CHAT_EXCLUDED_TOOLS, toolsOfferedFor, offeredToolNames, refusedToolMessage } =
    require('../utils/tool_policy.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf-8');
const start = src.indexOf('const mcpToolsDefinitions = [');
const end = src.indexOf('\n];', start);
assert(start > 0 && end > start, 'mcpToolsDefinitions block not found in index.js');
const realNames = [...src.slice(start, end).matchAll(/name: "([a-z_]+)"/g)].map(m => m[1]);
const defs = realNames.map(name => ({ type: 'function', function: { name } }));

let passed = 0;
const check = (cond, msg) => { assert(cond, msg); passed++; };

check(!realNames.includes('run_cypher_query'), 'run_cypher_query must not be in the chat tool list');
for (const name of GUEST_ALLOWED_TOOLS) {
    check(realNames.includes(name), `guest-allowed tool '${name}' does not exist in mcpToolsDefinitions (drift)`);
}

const owner = offeredToolNames(toolsOfferedFor({ isGuest: false }, [...defs, { function: { name: 'run_cypher_query' } }]));
check(!owner.has('run_cypher_query'), 'run_cypher_query is never offered, even if re-added to the list');
check(owner.has('explore_graph_schema'), 'signed-in users keep schema discovery');

const guest = offeredToolNames(toolsOfferedFor({ isGuest: true }, defs));
for (const banned of ['run_cypher_query', 'explore_graph_schema', 'get_tool_statistics']) {
    check(!guest.has(banned), `guests must not be offered ${banned}`);
}
check(guest.has('search_enterprise_graph') && guest.has('get_node_details'), 'guests keep read-only retrieval');
check([...guest].every(n => GUEST_ALLOWED_TOOLS.has(n)), 'guests get only allowlisted tools');
check(CHAT_EXCLUDED_TOOLS.has('run_cypher_query'), 'raw query tool is chat-excluded');

const refused = refusedToolMessage({ id: 'call_1', function: { name: 'run_cypher_query', arguments: '{}' } });
check(refused.role === 'tool' && refused.tool_call_id === 'call_1', 'refusal answers the same tool_call_id');
check(JSON.parse(refused.content).error.includes('not available'), 'refusal explains itself');

console.log(`tool policy: ${passed}/${passed} passed.`);
