'use strict';
/**
 * Kind words shared by several domains (bridge-pipeline-without-model-design-2026-11-13.md §13; utils/kind_vocabulary.js).
 * - many-to-many vocabulary from the manifests; no hand-kept list of ambiguous words;
 * - steps a–e on a made-up catalog; meanings with no visible item are dropped first (AP-30);
 * - through planBridge: source side asks (step e) and the kind choice is re-checked; target side never asks.
 * No network, no LLM. Run: node tests/verify_kind_vocabulary.js (npm test).
 */
process.env.ENABLE_DOCUMENT_DOMAIN = 'true';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildKindVocabulary, kindMentions, resolveKind, KIND_STEP, VOCAB } = require('../utils/kind_vocabulary');
const { buildRoutingLookups } = require('../utils/intent_classifier.js');
const { planBridge, resolveBridgeKindChoice, KIND_CLARIFY_KIND, BRIDGE_PLAN_MAX_SOURCES } = require('../utils/bridge_plan');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };

// ── vocabulary: many-to-many, from data ─────────────────────────────────────────────────────────────────
{
    const v = buildKindVocabulary({
        professional: { external_signal: 'career', bridge_source_kinds: { article: ['ThoughtLeadership'], talk: ['ThoughtLeadership'] } },
        website: { bridge_source_kinds: { article: ['WebsiteSource'] } },
    });
    eq(v.get('article').map(m => m.domain).sort(), ['career', 'website'], 'a shared word keeps every meaning');
    eq(v.get('talk').map(m => m.domain), ['career'], 'routing name from external_signal');
    eq(VOCAB.get('article').map(m => m.domain).sort(), ['career', 'document', 'website'], 'live manifests: "article" in three domains');
    const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'kind_vocabulary.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');   // comments may name examples
    ok(!/['"`]article['"`]/.test(code), 'no kind word written in the module code');
    eq(kindMentions('How did the Iceberg articles shape it?').map(m => m.word), ['article'], 'plural tolerant');
}

// ── steps a–e on a made-up catalog ─────────────────────────────────────────────────────────────────────
const it = (name, domain, type, node_id) => ({ name, domain, type, node_id });
const ITEMS = [
    it('InfoQ: Platform Shifts', 'career', 'ThoughtLeadership', 'tl1'),
    it('Apache Iceberg', 'website', 'WebsiteSource', 'w1'),
    it('BERT paper', 'document', 'DocumentSource', 'd1'),
];
const article = kindMentions('the article')[0];
const ctx = extra => ({ items: ITEMS, maxAll: BRIDGE_PLAN_MAX_SOURCES, ...extra });
{
    const page = kindMentions('the Iceberg article page');
    const a = resolveKind(page.find(m => m.word === 'article'), ctx({ text: 'the Iceberg article page', others: page }));
    eq([a.step, a.meanings.map(m => m.domain)], [KIND_STEP.a, ['website']], 'a: "page" has one meaning');
    const b = resolveKind(article, ctx({ text: 'the Iceberg article' }));
    eq([b.step, b.meanings.map(m => m.domain)], [KIND_STEP.b, ['website']], 'b: the other words match one meaning');
    const b2 = resolveKind(article, ctx({ text: 'the InfoQ article' }));
    eq(b2.meanings.map(m => m.domain), ['career'], 'b: "InfoQ" picks thought leadership');
    const c = resolveKind(article, ctx({ text: "Sangeetha's articles", subjects: ['Sangeetha Ramadurai'], work: () => ['career'] }));
    eq([c.step, c.meanings.map(m => m.domain)], [KIND_STEP.c, ['career']], 'c: the person\'s work domains');
    const d = resolveKind(article, ctx({ text: 'the articles' }));
    eq([d.step, d.meanings.length], [KIND_STEP.d, 3], 'd: 3 items ≤ the cap → search all');
    const many = Array.from({ length: BRIDGE_PLAN_MAX_SOURCES }, (_, i) => it(`Page ${i}`, 'website', 'WebsiteSource', `wp${i}`));
    const e = resolveKind(article, { text: 'the articles', items: [...ITEMS, ...many], maxAll: BRIDGE_PLAN_MAX_SOURCES });
    eq([e.ask, e.step], [true, KIND_STEP.e], 'e: too many → ask');
    const noAsk = resolveKind(article, { text: 'the articles', items: [...ITEMS, ...many], maxAll: BRIDGE_PLAN_MAX_SOURCES, mayAsk: false });
    eq([noAsk.ask, noAsk.meanings.length], [undefined, 3], 'target side: never asks, every meaning');
    // visibility: a meaning with nothing the asker can open is dropped before any step (AP-30)
    const vis = resolveKind(article, { text: 'the articles', items: ITEMS.filter(t => t.domain !== 'document'), maxAll: 6 });
    eq(vis.meanings.map(m => m.domain).sort(), ['career', 'website'], 'hidden domain dropped');
    const one = resolveKind(article, { text: 'the articles', items: [ITEMS[1]], maxAll: 6 });
    eq([one.step, one.meanings.map(m => m.domain)], [null, ['website']], 'one visible meaning: not ambiguous for this asker');
}

// ── through planBridge ─────────────────────────────────────────────────────────────────────────────────
{
    const OWNER = 'user_owner';
    const e = (name, domain, type, node_id, extra = {}) => ({ name, domain, type, node_id, tier: 'org', owner_id: OWNER, ...extra });
    const pages = Array.from({ length: BRIDGE_PLAN_MAX_SOURCES }, (_, i) => e(`Guide ${i}`, 'website', 'WebsiteSource', `g${i}`));
    const catalog = { entries: [
        e('Cortex-Drive', 'career', 'Project', 'c1'),
        e('InfoQ: Platform Shifts', 'career', 'ThoughtLeadership', 'tl1'),
        e('Apache Iceberg', 'website', 'WebsiteSource', 'w1'),
        e('BERT paper', 'document', 'DocumentSource', 'd1'),
        ...pages,
    ] };
    const lk = buildRoutingLookups(catalog, { isOwner: true, userId: OWNER, allowedIds: [] });
    const b = planBridge('How did the Iceberg article influence Cortex-Drive?', lk);
    eq([b.kind, b.sources.map(s => s.node_id), b.kind_step], ['plan', ['w1'], KIND_STEP.b], 'source side, step b');
    const ask = planBridge('How did the articles influence Cortex-Drive?', lk);
    eq([ask.kind, ask.clarify.kind, ask.kind_step], ['clarify', KIND_CLARIFY_KIND, KIND_STEP.e], 'source side asks which kind');
    eq(ask.clarify.options.map(o => o.entity).sort((x, y) => x.domain.localeCompare(y.domain)),
       [{ kind: 'source_kind', domain: 'career' }, { kind: 'source_kind', domain: 'document' }, { kind: 'source_kind', domain: 'website' }]);
    eq(ask.clarify.options.find(o => o.entity.domain === 'career').label, 'Career', 'display name from the manifest');
    const picked = planBridge('How did the articles influence Cortex-Drive?', lk,
                              { kindChoice: resolveBridgeKindChoice({ kind: 'source_kind', domain: 'document' }) });
    eq([picked.kind, picked.sources.map(s => s.node_id), picked.kind_step], ['plan', ['d1'], 'chosen'], 'the kind choice is used');
    eq(resolveBridgeKindChoice({ kind: 'source_kind', domain: 'professional' }), 'career', 'an id is accepted as the routing name');
    const forged = planBridge('How did the articles influence Cortex-Drive?', lk,
                              { kindChoice: resolveBridgeKindChoice({ kind: 'source_kind', domain: 'podcast' }) });
    eq(forged.kind, 'clarify', 'a domain that is not a meaning of the word → ask again');
    eq(resolveBridgeKindChoice({ kind: 'source_kind', domain: 'nope' }), null);
    const target = planBridge('How does Cortex-Drive connect to the articles?', lk);
    eq([target.kind, target.target, target.target_domains.sort()], ['plan', null, ['document', 'professional', 'website']],
       'target side never asks: every meaning\'s domain');
    const targetItem = planBridge('How does Cortex-Drive connect to the Iceberg article?', lk);
    eq(targetItem.target && targetItem.target.node_id, 'w1', 'target side: the words pick the item');
}

console.log(`verify_kind_vocabulary: ${passed} checks passed`);
