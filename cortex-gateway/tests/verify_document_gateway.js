'use strict';

/**
 * Phase B M5 step 5 (gateway). Run: `node tests/verify_document_gateway.js` or `npm test`.
 *   1. Flag OFF (default): the classifier never returns `document`; the offered tool list has no
 *      search_document_blocks and no `document` domain_intent (production unchanged, M5-10).
 *   2. Flag ON: document questions route to `document` (Phase R, structural shapes); the tool and the
 *      domain_intent are offered; guests never get the tool (M5-9).
 *   3. Evidence helpers: compact numbered evidence (AP-4), cite_url collected for the URL audit (AP-15),
 *      evidence only with >= 1 block (AP-25).
 * No network (no OpenAI client is passed, so the paid embedding phase never runs).
 */

const assert = require('assert');

let passed = 0;
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); passed++; };
const ok = (c, msg) => { assert.ok(c, msg); passed++; };

const { classifyDomain } = require('../utils/intent_classifier.js');
const { toolsOfferedFor, GUEST_ALLOWED_TOOLS } = require('../utils/tool_policy.js');
const { buildDocumentEvidenceContent, documentEvidenceUrls, documentResultHasEvidence } = require('../utils/document_evidence.js');

const DOC_QUESTIONS = [
    'What does the report say about Kafka throughput?',
    'On page 12, what does the figure show?',
    'According to the deck, what is the 2027 roadmap?',
    'What is described in the whitepaper about retries? in the whitepaper',
];
const NON_DOC_QUESTIONS = [
    'What have experts discussed about graph-native AI architectures and knowledge graphs in the podcast episodes?',
    'Show career map of Sangeetha Ramadurai',
    'in the paper she published about AI governance',
];

const DEFS = [
    { type: 'function', function: { name: 'search_document_blocks', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'search_enterprise_graph', parameters: { type: 'object', properties: {
        domain_intent: { type: 'string', enum: ['all', 'professional', 'podcast', 'website', 'federated', 'document'] } } } } },
    { type: 'function', function: { name: 'query_relevant_chunks_hybrid_tool', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'run_cypher_query', parameters: { type: 'object', properties: {} } } },
];
const names = tools => tools.map(t => t.function.name);
const intentEnum = tools => tools.find(t => t.function.name === 'search_enterprise_graph').function.parameters.properties.domain_intent.enum;

(async () => {
    // ── 1. flag OFF ────────────────────────────────────────────────────────────────────────────
    delete process.env.ENABLE_DOCUMENT_DOMAIN;
    for (const q of DOC_QUESTIONS) {
        const r = await classifyDomain(q, null);
        ok(r.domain !== 'document', `flag off: never 'document' (${q})`);
    }
    const offOwner = toolsOfferedFor({ isGuest: false }, DEFS);
    eq(names(offOwner), ['search_enterprise_graph', 'query_relevant_chunks_hybrid_tool'], 'flag off: no document tool, no raw cypher');
    eq(intentEnum(offOwner), ['all', 'professional', 'podcast', 'website', 'federated'], 'flag off: domain_intent enum exactly as before M5');
    eq(DEFS[1].function.parameters.properties.domain_intent.enum.includes('document'), true, 'the source definitions are not mutated');

    // ── 2. flag ON ─────────────────────────────────────────────────────────────────────────────
    process.env.ENABLE_DOCUMENT_DOMAIN = 'true';
    for (const q of DOC_QUESTIONS) {
        const r = await classifyDomain(q, null);
        eq([r.domain, r.confident], ['document', true], `flag on: routes to document (${q})`);
    }
    for (const q of NON_DOC_QUESTIONS) {
        const r = await classifyDomain(q, null);
        ok(r.domain !== 'document', `flag on: non-document question not captured (${q})`);
    }
    const onOwner = toolsOfferedFor({ isGuest: false }, DEFS);
    ok(names(onOwner).includes('search_document_blocks'), 'flag on: owner/collaborator gets the document tool');
    ok(intentEnum(onOwner).includes('document'), 'flag on: domain_intent "document" offered');
    const onGuest = toolsOfferedFor({ isGuest: true }, DEFS);
    ok(!names(onGuest).includes('search_document_blocks'), 'guests never get the document tool (M5-9)');
    ok(!GUEST_ALLOWED_TOOLS.has('search_document_blocks'), 'not in the guest allowlist');
    delete process.env.ENABLE_DOCUMENT_DOMAIN;

    // ── 3. evidence helpers ────────────────────────────────────────────────────────────────────
    const block = (page, text, extra = {}) => ({ text, page, label: extra.label || null, citation: {
        source_id: 'd1', source_name: 'Kafka Report', revision_date: '2026-10-20T00:00:00', page, section: 'Results',
        uri: 'https://example.com/k.pdf', cite_url: `https://example.com/k.pdf#page=${page}` } });
    const payload = JSON.stringify({ blocks: [block(3, 'Throughput is 2M msg/s.'), block(3, 'Throughput is 2M msg/s.'),
        block(7, 'A chart of latency.', { label: 'AI-generated figure description (from the figure on p. 7)' })], cited_sources: [] });
    const content = buildDocumentEvidenceContent(payload);
    ok(content.startsWith('Document search returned 2 evidence block(s).'), 'deduplicated per source::page::text');
    ok(content.includes('- Cite as: [Kafka Report, version 2026-10-20, p. 3, section "Results"](https://example.com/k.pdf#page=3)'), 'citation line');
    ok(!/\[\d+\]/.test(content), 'no [n] numbering for the LLM to copy');
    ok(content.includes('(AI-generated figure description (from the figure on p. 7))'), 'vlm label carried to the LLM');
    ok(!content.includes('"cited_sources"'), 'never the raw payload (AP-4)');
    eq(buildDocumentEvidenceContent(JSON.stringify({ blocks: [] })), 'Document search returned 0 evidence blocks.', 'empty');
    eq(buildDocumentEvidenceContent(JSON.stringify({ error: 'boom' })), 'Document search failed: boom', 'error');
    eq(documentEvidenceUrls(JSON.parse(payload)).filter((u, i, a) => a.indexOf(u) === i).sort(),
        ['https://example.com/k.pdf', 'https://example.com/k.pdf#page=3', 'https://example.com/k.pdf#page=7'], 'cite_url + uri collected (AP-15)');
    eq([documentResultHasEvidence(JSON.parse(payload)), documentResultHasEvidence({ blocks: [] }), documentResultHasEvidence({ error: 'x', blocks: [1] })],
        [true, false, false], 'evidence only with >= 1 block and no error (AP-25)');

    // ── 4. visibility chosen when adding a source (S2-44 / M5-11) ──────────────────────────────
    const { createVisibilityGuard } = require('../utils/source_visibility.js');
    const guard = createVisibilityGuard({ isOwner: u => u === 'owner' });
    const runGuard = (body, headers) => new Promise(resolve => {
        const req = { body, headers };
        const res = { status(c) { this.c = c; return this; }, json(b) { resolve({ status: this.c, body: b }); } };
        guard(req, res, () => resolve({ status: 200, visibility: req.body.visibility }));
    });
    eq(await runGuard({ url: 'u' }, { 'x-user-id': 'owner' }), { status: 200, visibility: 'private' }, 'default private');
    eq((await runGuard({ url: 'u', visibility: 'PUBLIC' }, { 'x-user-id': 'owner' })).visibility, 'public', 'owner may choose public (case-insensitive)');
    eq((await runGuard({ visibility: 'public' }, { 'x-user-id': 'member', 'x-schema-readable': 'true' })).status, 403, 'org admin may not choose public');
    eq((await runGuard({ visibility: 'organization' }, { 'x-user-id': 'member', 'x-schema-readable': 'true' })).status, 200, 'org admin may choose organization');
    eq((await runGuard({ visibility: 'organization' }, { 'x-user-id': 'member' })).status, 403, 'member may not choose organization');
    eq((await runGuard({ visibility: 'everyone' }, { 'x-user-id': 'owner' })).status, 400, 'unknown value → 400');
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
    ok(/register_website_source', authMiddleware, requireSourceWriter, requireVisibilityChoice/.test(src), 'website route checks visibility');
    ok(/register_document_source', authMiddleware, requireSourceWriter, requireVisibilityChoice/.test(src), 'document route checks visibility');

    const { countsAsEvidenceOnTurn } = require('../utils/document_evidence.js');
    eq([countsAsEvidenceOnTurn('document', 'search_document_blocks'), countsAsEvidenceOnTurn('document', 'search_enterprise_graph'),
        countsAsEvidenceOnTurn('podcast', 'search_enterprise_graph')], [true, false, true], 'document turns: only passages count as evidence (AP-25)');
    ok(/countsAsEvidenceOnTurn\(domainSignal, toolName\) && toolResultHasEvidence/.test(src), 'index.js applies it to the backstop');

    console.log(`verify_document_gateway: ${passed} checks passed`);
})().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
