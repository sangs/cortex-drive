'use strict';
/**
 * Wording grounding (2026-10-29): the answer must not coin terms absent from the tool results
 * ("stable cortical memory" for "stable, traceable source of truth"). Guards the two levers:
 * temperature 0 on the chat loop and the Q2 writer, and the prompt rules. The live check is the
 * regression question W-1 in documents/user_queries.md. Run: node tests/verify_wording_grounding.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const root = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const system = fs.readFileSync(path.join(root, 'prompts', 'gateway_system_assistant.md'), 'utf8');
const q2 = fs.readFileSync(path.join(root, 'prompts', 'gateway_q2_writer.md'), 'utf8');

ok(/const ANSWER_TEMPERATURE = 0;/.test(src), 'answer temperature is 0');
// Any tool_choice (the /query loop uses the grounding guard's toolChoiceFor since 2026-11-10); the temperature is the point.
const loops = src.match(/tool_choice: [^\n]+,\s*temperature: ANSWER_TEMPERATURE,/g) || [];
ok(loops.length === 1, 'the /query tool loop uses ANSWER_TEMPERATURE');
// One question-answering route (2026-11-13): GET /sse was a second tool loop without classification, "No data found"
// enforcement or code-written answers. A second loop, or the route coming back, fails here.
ok((src.match(/\btool_choice:/g) || []).length === 1, 'exactly one model tool loop in the gateway');
ok(!/app\.(get|post|all|use)\(\s*['"`]\/sse['"`]/.test(src), 'no /sse question route');
const queryStart = src.indexOf("app.post('/query'");
ok(queryStart > 0 && src.indexOf('tool_choice:') > queryStart, 'the tool loop lives in /query');
ok(!/tool_choice: [^\n]+,\s*\}\)/.test(src), 'no tool loop left on the default temperature');
ok(/max_tokens: 200,\s*temperature: ANSWER_TEMPERATURE/.test(src), 'Q2 writer uses ANSWER_TEMPERATURE');
ok(/WORDING GROUNDING:/.test(system) && /Do NOT coin new terms/.test(system), 'system prompt forbids coined terms');
ok(/never coin new terms/.test(q2), 'Q2 writer prompt forbids coined terms');

console.log(`verify_wording_grounding: ${passed} checks passed`);
