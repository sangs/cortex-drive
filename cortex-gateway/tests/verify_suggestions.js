'use strict';
/**
 * Starter questions (S2-102, architecture/question-suggestions-design-2026-11-23.md):
 * - 4 slots in order (overview, newest source, another domain, across sources); stable within a day, other pages differ;
 * - only titles and bridge entities the asker can open (AP-30); slot 4 needs a visible source on every side;
 * - every starter routes where it should; different wordings of the across-sources question route the same
 *   (owner, 2026-11-23: "What does Apache Iceberg cover?" and "How is … discussed across sources?" must agree);
 * - the overview question routes to the overview even though "Cortex-Drive" is also a career title;
 * - the simple answers are exactly greeting, overview, out of scope.
 * Run: node tests/verify_suggestions.js (npm test).
 */
process.env.ENABLE_DOCUMENT_DOMAIN = 'true';
const assert = require('assert');
const { buildRoutingLookups } = require('../utils/intent_classifier.js');
const { routeQuestion, EARLY_ANSWER_MODES } = require('../utils/routing_v2.js');
const { starterQuestions, suggestedQuestions, SUGGESTIONS_MAX } = require('../utils/suggestions.js');
const SUGGESTED = require('../config/suggested_questions.json');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };

const OWNER = 'user_owner';
const CATALOG = {
    entries: [
        { name: 'BERT: Pre-training of Deep Bidirectional Transformers', domain: 'document', type: 'DocumentSource', node_id: 'd1', tier: 'org', added: '2026-10-27' },
        { name: 'Apache Iceberg', domain: 'website', type: 'WebsiteSource', node_id: 'w1', tier: 'org', added: '2026-09-24' },
        { name: 'Simplifying Lakehouse Ecosystem With DuckDB', domain: 'podcast', type: 'Episode', node_id: 'e1', tier: 'org', added: '2025-09-10' },
        { name: 'Prompts as Functions', domain: 'podcast', type: 'Episode', node_id: 'e2', tier: 'org', added: '2025-04-03' },
        { name: 'Cortex-Drive', domain: 'career', type: 'Project', node_id: 'c1', tier: 'PUBLIC' },
        { name: 'Global Hackathons', domain: 'career', type: 'Hackathon', node_id: 'c2', tier: 'PUBLIC' },
        { name: 'Owner Private Notes', domain: 'website', type: 'WebsiteSource', node_id: 'w9', tier: 'org', owner_id: OWNER, added: '2026-11-20' },
        { name: 'Apache Iceberg', domain: 'topic', node_id: 't1', tier: 'SYSTEM' },
        { name: 'Trino', domain: 'topic', node_id: 't2', tier: 'SYSTEM' },
    ],
    bridge_entities: { 'apache iceberg': ['website', 'podcast'], trino: ['website', 'podcast'] },
    bridge_anchors: {
        'apache iceberg': { website: [{ node_id: 'w1', tier: 'org' }], podcast: [{ node_id: 'e1', tier: 'org' }] },
        trino: { website: [{ node_id: 'w9', tier: 'org', owner_id: OWNER }], podcast: [{ node_id: 'e2', tier: 'org' }] },
    },
};
const owner = buildRoutingLookups(CATALOG, { isOwner: true, allowedIds: [], userId: OWNER });
// A member: Organization content through the allowlist, not the owner's Private notes.
const member = buildRoutingLookups(CATALOG, { isOwner: false, allowedIds: ['d1', 'w1', 'e1', 'e2'], userId: 'user_member' });
// A collaborator: Public plus one shared episode; sees no website at all.
const collaborator = buildRoutingLookups(CATALOG, { isOwner: false, allowedIds: ['e2'], userId: 'user_collab' });
const coverage = async terms => Object.fromEntries(['career', 'podcast', 'website', 'document']
    .map(d => [d, terms.some(t => /iceberg|trino/i.test(t)) && ['podcast', 'website'].includes(d)]));
const route = (q, lk = owner) => routeQuestion(q, lk, { coverage });
const DAY = '2026-11-23';

(async () => {
    // Slots, order, newest first
    const s = starterQuestions(owner, { userId: OWNER, date: DAY });
    eq(s.length, SUGGESTIONS_MAX, '4 starters');
    eq(s.map(x => x.kind), ['overview', 'single_newest', 'single_other', 'across_sources'], 'slot order');
    eq(s[0].question, "What's in Cortex-Drive for me?", 'overview wording (owner, 2026-11-23)');
    ok(s[1].question.includes('Owner Private Notes'), 'owner: newest visible source is their own newest');
    const domainOf = q => CATALOG.entries.find(e => e.domain !== 'topic' && q.includes(e.name)).domain;
    ok(domainOf(s[2].question) !== domainOf(s[1].question), 'slot 3 is another domain');
    ok(/Apache Iceberg|Trino/.test(s[3].question), 'slot 4: a bridge entity');

    // Rotation
    eq(starterQuestions(owner, { userId: OWNER, date: DAY }), s, 'stable within a day');
    const days = new Set(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27']
        .map(date => starterQuestions(owner, { userId: OWNER, date }).map(x => x.question).join('|')));
    ok(days.size > 1, 'changes across days');
    const p1 = starterQuestions(owner, { userId: OWNER, date: DAY, page: 1 });
    ok(p1[1].question !== s[1].question, 'More ideas: page 1 has another newest source');

    // Visibility (AP-30)
    const m = starterQuestions(member, { userId: 'user_member', date: DAY });
    ok(!m.some(x => x.question.includes('Owner Private Notes')), 'member never sees the owner\'s Private title');
    ok(m[1].question.includes('BERT'), 'member: newest they can open');
    eq(m[3], { question: 'What does Apache Iceberg cover?', kind: 'across_sources' },
       'member: Iceberg (both sides visible); never Trino (its website side is the owner\'s Private source)');
    eq(member.bridgeVisible, ['Apache Iceberg'], 'member bridge entities');
    const c = starterQuestions(collaborator, { userId: 'user_collab', date: DAY });
    eq(collaborator.bridgeVisible, [], 'collaborator: no website side visible → no bridge entity');
    ok(c.every(x => x.kind !== 'across_sources'), 'collaborator: slot 4 falls back to a single source');
    ok(c.every(x => !/Apache Iceberg|BERT|DuckDB|Owner Private/.test(x.question)), 'collaborator: only Public + shared');
    eq(starterQuestions(buildRoutingLookups({ ...CATALOG, bridge_anchors: undefined }, { isOwner: false, allowedIds: ['w1', 'e1'] }),
                        { date: DAY }).some(x => x.kind === 'across_sources'), false, 'older catalog without anchors → no slot 4');

    // In answers: the overview answer leaves out its own question
    ok(!suggestedQuestions(owner, { userId: OWNER, date: DAY, excludeKinds: ['overview'] }).includes(SUGGESTED.starter_overview),
       'overview answer does not suggest itself');

    // Routing of every starter
    let r = await route("What's in Cortex-Drive for me?");
    eq(r.mode, 'overview', 'overview question → overview, not the Cortex-Drive project');
    r = await route('what is in cortex drive for me', member);
    eq(r.mode, 'overview', 'typed variant → overview');
    r = await route('Tell me about Cortex-Drive');
    eq([r.mode, r.domains], ['single', ['career']], 'the project itself still routes to career');
    for (const t of CATALOG.entries.filter(e => !['topic', 'person'].includes(e.domain))) {
        const templates = SUGGESTED.by_type[t.type] || SUGGESTED.default;
        for (const tpl of templates) {
            r = await route(tpl.split('{title}').join(t.name));
            ok(r.domains.includes(t.domain), `"${tpl}" with ${t.type} routes to ${t.domain} (got ${r.mode} ${r.domains})`);
        }
    }
    for (const tpl of SUGGESTED.default) {
        r = await route(tpl.split('{title}').join('Global Hackathons'));
        eq(r.domains, ['career'], 'default template keeps the item\'s domain');
    }
    // One meaning, several wordings: same routing
    const wordings = [...SUGGESTED.starter_across_sources.map(t => t.split('{entity}').join('Apache Iceberg')),
                      'How is Apache Iceberg discussed across sources?', 'Which sources mention Apache Iceberg?', 'Tell me about Apache Iceberg'];
    const routed = await Promise.all(wordings.map(q => route(q, member)));
    for (const [i, x] of routed.entries()) eq([x.mode, x.domains], ['cross', ['podcast', 'website']], `same routing: "${wordings[i]}"`);

    // The simple answers (S2-102 §3.4)
    eq([...EARLY_ANSWER_MODES].sort(), ['out_of_scope', 'overview', 'small_talk'], 'simple answers only');

    console.log(`verify_suggestions: ${passed} checks passed`);
})().catch(err => { console.error('verify_suggestions FAILED:', err.message); process.exit(1); });
