'use strict';
/**
 * Bridge plan (bridge-pipeline-without-model-design-2026-11-13.md §4.1, §4.3): sources and target chosen by code.
 * - each source rule (chosen, named, kind, subject, topic_words) and their order;
 * - target: named item, named domains, or every other domain; the target is never also a source;
 * - cap, ranking and the "not searched" note; clarifying question only when nothing usable, never a guess;
 * - visibility (AP-30): sources, options and accepted choices come only from what the asker can open;
 * - every bridge question of the labelled routing set yields a plan or a clarifying question within the limits.
 * No network, no LLM. Run: node tests/verify_bridge_plan.js (npm test).
 */
process.env.ENABLE_DOCUMENT_DOMAIN = 'true';
const assert = require('assert');
const { buildRoutingLookups } = require('../utils/intent_classifier.js');
const { planBridge, ownershipRequest, resolveBridgeSourceChoice, sides, BRIDGE_PLAN_MAX_SOURCES, BRIDGE_PLAN_CLARIFY_MAX_OPTIONS,
    CLARIFY_QUESTION, RULE } = require('../utils/bridge_plan.js');
const MANIFESTS = require('../config/domain_manifests.json');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };

const OWNER = 'user_owner';
const entry = (name, domain, type, node_id, extra = {}) => ({ name, domain, type, node_id, tier: 'org', owner_id: OWNER, ...extra });
const PROJECTS = ['Alpha Ledger', 'Beta Router', 'Gamma Cache', 'Delta Queue', 'Epsilon Index', 'Zeta Planner', 'Eta Governance Hub']
    .map((n, i) => entry(n, 'career', 'Project', `pr${i + 1}`));
const CATALOG = {
    entries: [
        entry('Sangeetha Ramadurai', 'person', null, 'p1', { tier: 'PUBLIC', work_domains: ['career'] }),
        entry('Ben Lorica', 'person', null, 'p2', { work_domains: ['podcast'] }),
        entry('Cortex-Drive', 'career', 'Project', 'c1', { tier: 'PUBLIC' }),
        entry('Platform Engineering in the Age of AI', 'career', 'ThoughtLeadership', 'tl1', { tier: 'PUBLIC' }),
        entry('Ignite Community @ JPMC', 'career', 'ThoughtLeadership', 'tl2', { tier: 'PUBLIC' }),
        entry('JPMorgan Chase', 'career', 'Company', 'co1', { tier: 'PUBLIC' }),
        ...PROJECTS,
        entry('Graph database', 'website', 'WebsiteSource', 'w1'),
        entry('Graphs With KuzuDB', 'podcast', 'Episode', 'e1'),
        entry('Lakehouse With DuckLake', 'podcast', 'Episode', 'e2'),
        entry('Data Engineering Podcast', 'podcast', 'Podcast', 'pod1'),
        entry('Hidden Strategy Memo', 'document', 'DocumentSource', 'd1', { owner_id: 'user_other' }),
        entry('Zero Trust', 'topic', null, 't1', { tier: 'SYSTEM' }),
    ],
};
const owner = buildRoutingLookups(CATALOG, { isOwner: true, userId: OWNER, allowedIds: [] });
const member = buildRoutingLookups(CATALOG, { isOwner: false, userId: 'user_m', allowedIds: ['w1', 'e1'] });
const ids = p => p.sources.map(s => s.node_id);
const names = p => p.sources.map(s => s.name);

// ── Direction ───────────────────────────────────────────────────────────────────────────────────────────
{
    const q = "How did Sangeetha's thought leadership influence Cortex-Drive?";
    const s = sides(q);
    eq([q.slice(...s.from), q.slice(...s.to)], ["Sangeetha's thought leadership", 'Cortex-Drive?'], 'influence sides');
    const r = 'What is the relation between Graph database and the podcasts?';
    eq(r.slice(...sides(r).from), 'Graph database', 'relation-between from-side');
    const t = "Trace the decision from Sangeetha's governance work to the security design of Cortex-Drive";
    eq(t.slice(...sides(t).from), "Sangeetha's governance work", 'trace from-side');
    eq(sides('Tell me about Cortex-Drive'), null, 'no direction stated');
}

// ── kind: the demo question (Invariant 10 bridge pattern) ───────────────────────────────────────────────
{
    const p = planBridge("How did Sangeetha's thought leadership influence Cortex-Drive?", owner);
    eq(p.kind, 'plan'); eq(p.rule, RULE.kind);
    eq(ids(p).sort(), ['tl1', 'tl2'], 'every visible thought-leadership item, nothing else');
    eq(p.target, { node_id: 'c1', name: 'Cortex-Drive' }, 'named target');
    eq(p.target_domains, [], 'a named target needs no target domains');
    eq(p.subjects, ['Sangeetha Ramadurai']);
    eq(p.notes, []);
    ok(p.sources.every(s => s.type === 'ThoughtLeadership' && s.domain === 'career'));
}

// ── kind words are manifest data for every domain, not a career list ────────────────────────────────────
{
    const p = planBridge("How did the episodes influence Sangeetha's projects?", owner);
    eq(p.rule, RULE.kind); eq(ids(p).sort(), ['e1', 'e2'], 'episodes are the sources');
    eq(p.target, null); eq(p.target_domains, ['professional'], 'to-side kind word names the target domain');
    const w = planBridge('How do the pages connect to the podcasts?', owner);
    eq(ids(w), ['w1']); eq(w.target_domains, ['podcast']);
    for (const [domain, m] of Object.entries(MANIFESTS)) ok(Object.keys(m.bridge_source_kinds || {}).length > 0, `${domain} has kind words`);
}

// ── named: items on the from-side, the target is never a source ─────────────────────────────────────────
{
    const p = planBridge('How does the Graph database page connect to Cortex-Drive?', owner);
    eq(p.rule, RULE.named); eq(ids(p), ['w1']); eq(p.target.node_id, 'c1');
    const d = planBridge('How does Cortex-Drive connect across career and podcast content?', owner);
    eq(ids(d), ['c1']); eq(d.target, null); eq(d.target_domains, ['professional', 'podcast'], 'to-side scope words');
    const a = planBridge('What is the relation between Graph database and JPMorgan Chase?', owner);
    eq(ids(a), ['w1']); eq(a.target.node_id, 'co1');
    // named beats kind: a named item on the from-side wins over a kind word there
    const n = planBridge('How did the Alpha Ledger project influence Cortex-Drive?', owner);
    eq(n.rule, RULE.named); eq(ids(n), ['pr1']);
    // no direction: first named item is the source, the second the target
    const nd = planBridge('Alpha Ledger and Cortex-Drive decision trace', owner);
    eq(ids(nd), ['pr1']); eq(nd.target.node_id, 'c1');
    // nothing on the to-side → every other domain
    const auto = planBridge('How did Alpha Ledger influence things?', owner);
    eq(auto.target, null); eq(auto.target_domains, ['auto']);
}

// ── subject: a person alone → every bridge-source kind of their work domains; cap, ranking, note ────────
{
    const p = planBridge("Trace the decision from Sangeetha's governance work to the security design of Cortex-Drive", owner);
    eq(p.rule, RULE.subject);
    eq(p.sources.length, BRIDGE_PLAN_MAX_SOURCES, 'capped');
    eq(names(p)[0], 'Eta Governance Hub', 'an item named with a from-side word ranks first');
    ok(!ids(p).includes('c1'), 'the target is not a source');
    ok(!ids(p).includes('co1'), 'a Company is not a bridge-source kind');
    eq(p.notes.length, 1); ok(/^6 of 9 matching items were searched\. Not searched: /.test(p.notes[0]), p.notes[0]);
    const again = planBridge("Trace the decision from Sangeetha's governance work to the security design of Cortex-Drive", owner);
    eq(names(again), names(p), 'same question → same sources in the same order');
    // a podcast person's work domain has its own kinds
    const b = planBridge("How did Ben Lorica's work influence Cortex-Drive?", owner);
    eq(b.rule, RULE.subject); eq(ids(b).sort(), ['e1', 'e2', 'pod1']);
}

// ── topic_words: a paraphrase resolves silently when 1..cap items match, otherwise one question ─────────
{
    const p = planBridge('How did her platform engineering talk influence Cortex-Drive?', owner);
    eq(p.kind, 'plan'); eq(p.rule, RULE.topicWords);
    eq(ids(p), ['tl1'], 'the item matching the most words; "Data Engineering Podcast" matches fewer');
    const none = planBridge('How did it influence that?', owner);
    eq(none.kind, 'clarify'); eq(none.clarify.question, CLARIFY_QUESTION); eq(none.clarify.kind, 'bridge_source');
    ok(none.clarify.options.length > 0 && none.clarify.options.length <= BRIDGE_PLAN_CLARIFY_MAX_OPTIONS);
    ok(none.clarify.options.every(o => o.entity.kind === 'source' && o.entity.node_id && o.label === o.entity.name));
    ok(!('sources' in none), 'a clarifying question carries no guessed sources');
}

// ── chosen: the answer to the clarifying question ──────────────────────────────────────────────────────
{
    const choice = { kind: 'source', node_id: 'tl2' };
    const resolved = resolveBridgeSourceChoice(choice, owner);
    eq(resolved, ['tl2']);
    const p = planBridge('How did it influence Cortex-Drive?', owner, { resolvedSources: resolved });
    eq(p.rule, RULE.chosen); eq(ids(p), ['tl2']); eq(p.target.node_id, 'c1');
    eq(resolveBridgeSourceChoice({ kind: 'person', name: 'Ben Lorica' }, owner), [], 'a person choice is not a source choice');
    eq(resolveBridgeSourceChoice(null, owner), []);
    eq(resolveBridgeSourceChoice({ kind: 'source', node_ids: ['tl2', 'nope'] }, owner), [], 'all ids must be visible');
}

// ── visibility (AP-30): only what the asker can open ───────────────────────────────────────────────────
{
    eq(resolveBridgeSourceChoice({ kind: 'source', node_id: 'd1' }, owner), [], "another user's document is not the owner's to pick");
    eq(resolveBridgeSourceChoice({ kind: 'source', node_id: 'pr1' }, member), [], 'a member cannot pick an item not shared with them');
    const visible = new Set(member.titles.map(t => t.node_id));
    // The member sees PUBLIC items and the two shared ones; org-private projects are not offered or searched.
    const p = planBridge("Trace the decision from Sangeetha's governance work to the security design of Cortex-Drive", member);
    eq(p.kind, 'plan'); ok(ids(p).every(id => visible.has(id)), 'sources only from visible items');
    eq(ids(p).sort(), ['tl1', 'tl2'], 'private projects are absent');
    const e = planBridge("How did the episodes influence Sangeetha's projects?", member);
    eq(ids(e), ['e1'], 'only the shared episode');
    const c = planBridge('How did it influence that?', member);
    ok(c.clarify.options.every(o => visible.has(o.entity.node_id)), 'options only from visible items');
    const hidden = planBridge('How did the Hidden Strategy Memo influence Cortex-Drive?', member);
    ok(hidden.kind !== 'plan' || !ids(hidden).includes('d1'), 'a hidden title is never a source');
    ok(JSON.stringify(hidden).indexOf('Hidden Strategy Memo') === -1, 'a hidden title never appears in the result');
    const nobody = buildRoutingLookups({ entries: [] }, { isOwner: false, userId: 'user_x', allowedIds: [] });
    eq(planBridge("How did Sangeetha's thought leadership influence Cortex-Drive?", nobody), { kind: 'no_source' }, 'nothing visible → no source, no guess');
}

// ── ownership (design §10 gap 1): a named person's kind means their own items ─────────────────────────────
{
    const demo = "How did Sangeetha's thought leadership influence Cortex-Drive?";
    eq(ownershipRequest(demo, owner), { person_ids: ['p1'], labels: ['ThoughtLeadership'], subjects: ['Sangeetha Ramadurai'] });
    const person = ownershipRequest("Trace the decision from Sangeetha's governance work to the security design of Cortex-Drive", owner);
    eq(person.labels, ['Certification', 'OpenSource', 'Project', 'ThoughtLeadership'], 'no kind word → every kind of her work domains');
    eq(ownershipRequest('How does the Graph database page connect to Cortex-Drive?', owner), null, 'no person → no lookup');
    eq(ownershipRequest("How did Alpha Ledger influence Sangeetha's projects?", owner), null, 'an item named on the from-side → no lookup');
    const mine = planBridge(demo, owner, { ownedIds: new Set(['tl2']) });
    eq(ids(mine), ['tl2'], 'only her items');
    const none = planBridge(demo, owner, { ownedIds: new Set() });
    ok(none.kind !== 'plan' || none.rule === RULE.topicWords, 'none of hers → never everyone else\'s items of the kind');
    const failed = planBridge(demo, owner, { ownershipFailed: true });
    eq(ids(failed).sort(), ['tl1', 'tl2']); ok(/^Could not check which items belong to Sangeetha Ramadurai/.test(failed.notes[0]));
    const subj = planBridge("Trace the decision from Sangeetha's governance work to the security design of Cortex-Drive", owner,
                            { ownedIds: new Set(['pr7', 'tl1', 'c1']) });
    eq(ids(subj), ['pr7', 'tl1'], 'subject rule: her items, ranked, target excluded');
}

// ── the labelled routing set: every bridge question yields a plan or one question, within the limits ───
{
    const catalog = require('../config/entity_catalog.json');
    const set = require('./routing_eval/routing_eval_set.json');
    const ownerId = (catalog.entries.find(e => e.owner_id && e.tier !== 'PUBLIC' && e.tier !== 'SYSTEM') || {}).owner_id;
    const lk = buildRoutingLookups(catalog, { isOwner: true, userId: ownerId, allowedIds: [] });
    const visible = new Set(lk.titles.map(t => t.node_id));
    const cases = set.cases.filter(c => c.mode === 'bridge');
    ok(cases.length >= 8, `labelled bridge questions (${cases.length})`);
    let plans = 0;
    for (const c of cases) {
        const p = planBridge(c.q, lk);
        ok(['plan', 'clarify'].includes(p.kind), `${c.id}: ${p.kind}`);
        if (p.kind !== 'plan') { ok(p.clarify.options.length <= BRIDGE_PLAN_CLARIFY_MAX_OPTIONS, c.id); continue; }
        plans++;
        ok(p.sources.length >= 1 && p.sources.length <= BRIDGE_PLAN_MAX_SOURCES, `${c.id}: source count`);
        ok(p.sources.every(s => visible.has(s.node_id)), `${c.id}: visible sources`);
        ok(!p.target || !ids(p).includes(p.target.node_id), `${c.id}: target is not a source`);
        ok(Boolean(p.target) !== (p.target_domains.length > 0), `${c.id}: a target item or target domains, not both`);
    }
    ok(plans >= 1, 'at least one labelled bridge question plans without asking');
    console.log(`  labelled bridge questions: ${plans} planned, ${cases.length - plans} ask`);
}

console.log(`verify_bridge_plan: ${passed} checks passed`);
