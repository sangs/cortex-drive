'use strict';
/**
 * Bridge mode "How these connect" written by code (validation 1.3, 2026-11-12). Fixture: the real
 * connect_knowledge_on_demand result for "How did Sangeetha's thought leadership influence Cortex-Drive?".
 * Run: node tests/verify_bridge_section.js (npm test).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bridgesFromConnectResult, notesFromConnectResult, bridgeModeAnswer, dropGroupingBridges, groupingIdsFromConnectResult, NO_BRIDGE_ANSWER, BRIDGE_SEARCH_FAILED_ANSWER,
        BRIDGE_ITEM_DESCRIPTION_MAX } = require('../utils/bridge_section.js');
const { withConnectionsSection, CONNECTIONS_HEADING, SESSION_ONLY_NOTE, REQUESTED_TARGET_SUFFIX } = require('../utils/cross_mode.js');
const fixture = require('./fixtures/bridge_result_1_3.json');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };

const b = bridgesFromConnectResult(fixture);
const chain = x => x && { from: x.from, to: x.to, via: x.via, rels: x.rels };
eq(chain(b.find(x => x.to === 'Cortex-Drive')), { from: 'Ignite Social Learning Community @ JPMC', to: 'Cortex-Drive', via: ['Sangeetha Ramadurai'], rels: ['LED', 'HELD_ROLE'] }, 'two-hop chain traced from the source, in path order');
eq(chain(b.find(x => x.to === 'AWS')), { from: 'Ignite Social Learning Community @ JPMC', to: 'AWS', via: [], rels: ['USES_TOOL'] }, 'one-hop chain');
eq(b.some(x => x.to === 'Thought Leadership & Community'), false, 'grouping category left out of the section');
eq(bridgesFromConnectResult({ nodes: [], virtual_links: [] }), [], 'empty result → no bridges');
eq(bridgesFromConnectResult({ error: 'x' }), [], 'error result → no bridges');
const loop = { nodes: [{ id: 'a', name: 'A', bridge_reason: 'x' }, { id: 'b', name: 'B' }], virtual_links: [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }] };
ok(Array.isArray(bridgesFromConnectResult(loop)), 'a link cycle never loops forever');

const llm = 'Ignite is a learning community.\n\n## How these connect\nThe community directly led to the Cortex-Drive project.';
const out = withConnectionsSection(llm, b);
ok(!/directly led to/.test(out), "the model's own connection claims are removed");
ok(out.includes(`\n${CONNECTIONS_HEADING}\n`) && out.includes('- **Ignite Social Learning Community @ JPMC** ↔ **Cortex-Drive** via Sangeetha Ramadurai (LED → HELD_ROLE)'), 'chain stated as found');
ok(out.includes(`(LED → HELD_ROLE)${REQUESTED_TARGET_SUFFIX}`) && !out.includes(`(USES_TOOL)${REQUESTED_TARGET_SUFFIX}`), 'only the target named in the question is labelled');
ok(out.endsWith(SESSION_ONLY_NOTE), 'session-only note always present');

// Bridge mode: the whole answer is written by code (2026-11-13) — no model prose survives.
const cd = b.find(x => x.to === 'Cortex-Drive');
eq([cd.fromType, cd.toType], ['ThoughtLeadership', 'Project'], 'item types come from the result nodes');
ok(cd.toDescription.startsWith('Cortex-Drive is the living memory'), "item description is the node's own field");
eq(notesFromConnectResult({ ...fixture, bridge_notes: undefined }), [], 'a result without bridge_notes that found bridges adds no notes');
eq(notesFromConnectResult(fixture), ['Paths through its own author or owner (Sangeetha Ramadurai) are not counted as bridges.'], "the real result's note");
eq(notesFromConnectResult({ ...fixture, bridge_notes: ["Note: requested target 'X' was not found in domain 'professional'."] }),
   ["Note: requested target 'X' was not found in domain 'professional'."], "the tool's notes are passed on verbatim");
eq(notesFromConnectResult({ nodes: [], virtual_links: [], bridge_summary: "No source node found matching 'x'." }),
   ["No source node found matching 'x'."], 'an empty result gives its reason');
eq(notesFromConnectResult({ error: 'x' }), [], 'an error result gives no notes');
const full = bridgeModeAnswer({ bridges: [...b, ...b], notes: ['N1', 'N1'], failed: false });
ok(full.startsWith('Cortex-Drive found 3 connections starting from **Ignite Social Learning Community @ JPMC**.'), 'intro counts unique chains and names the source');
ok(full.includes('- **Ignite Social Learning Community @ JPMC** (ThoughtLeadership)\n- **AWS** (Technology)'), 'items listed once each, source first');
ok(full.includes('- **Cortex-Drive** (Project): Cortex-Drive is the living memory') && full.includes('…'), 'long description cut');
ok(!full.split('\n').some(l => l.startsWith('- **Cortex-Drive** (Project)') && l.length > BRIDGE_ITEM_DESCRIPTION_MAX + 40), 'description capped');
ok(full.includes(`\n${CONNECTIONS_HEADING}\n`) && full.includes(SESSION_ONLY_NOTE), 'chains and the session-only note');
eq(full.split('- N1').length - 1, 1, 'notes shown once');
ok(!/influenced|led to|drove|shaped|integral/i.test(full.replace(/\(LED[^)]*\)/g, '').replace(cd.toDescription, '')), 'no causal wording outside the data');
// Text and graph agree (2026-11-13): grouping sections are flagged by the tool and are in neither.
const groupingIds = new Set(groupingIdsFromConnectResult(fixture));
eq(groupingIds.size, 1, 'the tool flags the grouping section (no type list in the gateway)');
const graph = dropGroupingBridges({ nodes: fixture.nodes.map(n => ({ ...n, is_grouping: undefined })), virtual_links: [...fixture.virtual_links] }, groupingIds);
eq(graph.virtual_links.length, fixture.virtual_links.length - 1, 'the link to the grouping section leaves the graph');
const drawn = new Set(graph.virtual_links.flatMap(l => [l.source, l.target]));
const drawnNames = fixture.nodes.filter(n => drawn.has(n.id)).map(n => n.name).sort();
const answerNames = [...new Set(b.flatMap(x => [x.from, x.to, ...x.via]))].sort();
eq(drawnNames, answerNames, 'the graph draws exactly the items the answer names');
const onlyGrouping = { nodes: fixture.nodes.slice(0, 2), virtual_links: fixture.virtual_links.slice(0, 1) };
eq(bridgesFromConnectResult(onlyGrouping), [], 'only a grouping path → no chain in the answer');
eq(dropGroupingBridges({ ...onlyGrouping, virtual_links: [...onlyGrouping.virtual_links] }, new Set(groupingIdsFromConnectResult(onlyGrouping))).virtual_links, [], '… and no link on the graph');
eq(dropGroupingBridges({ nodes: [], virtual_links: [{ source: 'a', target: 'b' }] }, new Set()).virtual_links.length, 1, 'nothing flagged → graph untouched');
eq(bridgeModeAnswer({ bridges: [], notes: [], failed: false }), NO_BRIDGE_ANSWER, 'no chain → the fixed no-bridge answer');
ok(bridgeModeAnswer({ bridges: [], notes: ['why'], failed: false }).endsWith('- why'), 'no-bridge answer carries the reason');
ok(bridgeModeAnswer({ bridges: [], notes: [], failed: true }).startsWith(BRIDGE_SEARCH_FAILED_ANSWER), 'a failed search is not reported as "no bridge"');
ok(bridgeModeAnswer({ bridges: b, notes: [], failed: true }).includes(CONNECTIONS_HEADING), 'chains found by other searches are still shown');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
ok(/toolName === 'connect_knowledge_on_demand'\) \{\s*bridgeSearches\+\+;\s*turnBridges\.push\(\.\.\.bridgesFromConnectResult\(parsed\)\);\s*turnBridgeNotes\.push\(\.\.\.notesFromConnectResult\(parsed\)\)/.test(src), 'bridge results and notes collected per turn');
ok(/if \(toolName === 'connect_knowledge_on_demand'\) bridgeSearchFailed = true;/.test(src), 'a failed bridge search is recorded');
ok(/finalAnswer = withConnectionsSection\(finalAnswer, unique\)/.test(src), '/query writes the section');
ok(/domainSignal === 'cross_domain' && !bridgeContext && bridgeSearchRan && finalAnswer !== NO_DATA_FOUND_ANSWER\(question\)\) \{\s*finalAnswer = bridgeModeAnswer\(/.test(src), 'bridge mode: the answer is replaced by the code-written one; "No data found" keeps precedence');
ok(src.indexOf('finalAnswer = bridgeModeAnswer(') < src.indexOf('auditResponseUrls(finalAnswer'), 'bridge answer written before the URL audit');
ok(/finalAnswer = bridgeModeAnswer\([^\n]*\n[^\n]*\n\s*dropGroupingBridges\(accumulatedGraph, turnGroupingIds\);/.test(src), 'bridge mode drops grouping links from the graph');
ok(src.indexOf('dropGroupingBridges(accumulatedGraph, turnGroupingIds)') < src.indexOf("if (domainSignal === 'cross_domain' && !bridgeContext) {\n                    if (accumulatedGraph.virtual_links.length > 0)"), '… before the graph is pruned to bridge endpoints');
ok(src.indexOf('withConnectionsSection(finalAnswer, unique)') < src.indexOf('auditResponseUrls(finalAnswer'), 'before the URL audit');
const prompt = fs.readFileSync(path.join(__dirname, '..', '..', 'prompts', 'gateway_system_assistant.md'), 'utf8');
ok(/Do NOT describe, list or interpret the connections yourself/.test(prompt), 'prompt: the model does not describe connections');
ok(!/indicating direct intellectual influence/.test(prompt), 'prompt: no causal example left');

console.log(`verify_bridge_section: ${passed} checks passed`);
