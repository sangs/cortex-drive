'use strict';
/**
 * Unified shares phase 2 (2026-10-29): "Shared with me" + suggested questions.
 * - every suggested-question template routes to the shared item's domain for a recipient who can
 *   open that item (classifyDomain with the recipient's routing lookups, AP-30);
 * - the list keeps only items the user can still open, de-duplicates direct + group, names the sharer.
 * Run: node tests/verify_received_shares.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createReceivedShares, suggestedQuestions, RECEIVED_SQL } = require('../utils/received_shares');
const { classifyDomain, buildRoutingLookups } = require('../utils/intent_classifier');
const SUGGESTED = require('../config/suggested_questions.json');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const quiet = fn => async (...a) => {
    const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {};
    try { return await fn(...a); } finally { console.log = l; console.warn = w; }
};

// Node type → the domain its catalog entry has (entity_catalog.py) and a realistic title.
const ITEMS = {
    DocumentSource: ['document', 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding'],
    WebsiteSource: ['website', 'Graph database - Wikipedia'],
    Project: ['career', 'Cortex-Drive'],
    Company: ['career', 'JPMorgan Chase'],
    ThoughtLeadership: ['career', 'InfoQ: Architectural Shifts for Platform Engineers in the Age of AI'],
    Hackathon: ['career', 'Open-Source AI Agents Contribution @ JPMC'],
    Episode: ['podcast', 'Anthropic And Model Context Protocol (MCP) With David Soria Parra'],
    Podcast: ['podcast', 'The Data Exchange'],
};

(async () => {
    // ── templates ─────────────────────────────────────────────────────────────────────────────
    eq(Object.keys(SUGGESTED.by_type).sort(), Object.keys(ITEMS).sort(), 'every configured type is covered by this test');
    eq(suggestedQuestions('Project', 'Cortex-Drive'), ['What was built in Cortex-Drive?', 'Which technologies were used in Cortex-Drive?'],
       'templates filled with the exact title');
    eq(suggestedQuestions('Unknown', 'X'), ['What does Cortex-Drive know about X?'], 'unknown type: the default template');
    eq(suggestedQuestions('Project', ''), [], 'no title: no questions');
    ok(suggestedQuestions('DocumentSource', 'D').length <= SUGGESTED.max_per_item, 'at most max_per_item');

    process.env.ENABLE_DOCUMENT_DOMAIN = 'true';
    const classify = quiet(classifyDomain);
    for (const [type, [domain, title]] of Object.entries(ITEMS)) {
        const catalog = { entries: [{ name: title, domain, node_id: `n-${type}`, tier: 'org' }], bridge_entities: {} };
        const recipient = buildRoutingLookups(catalog, { isOwner: false, allowedIds: [`n-${type}`] });
        for (const q of suggestedQuestions(type, title)) {
            eq((await classify(q, null, recipient)).domain, domain, `${type}: "${q}" → ${domain}`);
        }
    }
    delete process.env.ENABLE_DOCUMENT_DOMAIN;

    // ── list ──────────────────────────────────────────────────────────────────────────────────
    const rows = [
        { grant_id: 'g1', root_node_id: 'doc', grant_type: 'node', node_count: 300, issued_by: 'owner', issued_at: 't2', assignee_type: 'user' },
        { grant_id: 'g1', root_node_id: 'doc', grant_type: 'node', node_count: 300, issued_by: 'owner', issued_at: 't2', assignee_type: 'group', group_name: 'Core' },
        { grant_id: 'g2', root_node_id: 'gone', grant_type: 'node', node_count: 1, issued_by: 'owner', issued_at: 't1', assignee_type: 'user' },
        { grant_id: 'g3', root_node_id: 'proj', grant_type: 'graph_island', node_count: 4, issued_by: 'admin', issued_at: 't0', assignee_type: 'group', group_name: 'Core' },
    ];
    let asked = null;
    const shares = createReceivedShares({
        db: { async query(sql, params) { assert.strictEqual(params[0], 'me'); return { rows }; } },
        bento: { async nodesByIds(ids, tenant, principal) { asked = { ids, tenant, principal };
            return { nodes: [{ node_id: 'doc', name: 'BERT', type: 'DocumentSource' }, { node_id: 'proj', name: 'Cortex-Drive', type: 'Project' }] }; } },
        userName: async sub => ({ owner: 'Sangeetha R', admin: '' }[sub]),
        log: { log() {} },
    });
    const items = await shares.list({ userId: 'me', tenantId: 'personal:me' });
    eq(asked, { ids: ['doc', 'gone', 'proj'], tenant: 'personal:me', principal: 'me' }, "roots are checked under the user's OWN permissions");
    eq(items.map(i => i.grantId), ['g1', 'g3'], 'a root the user can no longer open is not listed; a grant reaching them twice is listed once');
    eq(items[0].via, { direct: true }, 'direct share wins over the same grant through a group');
    eq(items[1].via, { group: 'Core' }, 'group share names the group');
    eq([items[0].sharedBy, items[1].sharedBy], ['Sangeetha R', 'Someone'], 'sharer named; unknown name → "Someone"');
    eq(items[0].questions[0], 'Summarise BERT.', 'suggested questions attached');
    eq(items[0].nodeCount, 300, 'node count from the grant');
    eq(await createReceivedShares({ db: { async query() { return { rows: [] }; } }, bento: {}, log: { log() {} } }).list({ userId: 'me' }), [],
       'nothing shared: empty list, no Bento call');

    ok(/sg\.issued_by <> \$1/.test(RECEIVED_SQL), 'never lists your own shares');
    ok(/group_members WHERE user_sub = \$1/.test(RECEIVED_SQL), 'includes shares to groups the user belongs to');
    ok(/sg\.expires_at IS NULL OR sg\.expires_at > now\(\)/.test(RECEIVED_SQL) && /ra\.status = 'active' AND sg\.status = 'active'/.test(RECEIVED_SQL),
       'only active, unexpired grants and assignments');

    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    ok(/app\.get\('\/api\/share\/received', authMiddleware,/.test(src), 'endpoint is behind authMiddleware');
    ok(/receivedShares\.list\(\{ userId: req\.headers\['x-user-id'\]/.test(src), 'lists for the gateway-assigned user only (AP-23)');

    console.log(`verify_received_shares: ${passed} checks passed`);
})().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
