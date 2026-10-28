'use strict';

/**
 * S2-60: fresh, visibility-aware routing catalog. Run: `node tests/verify_entity_catalog.js` or `npm test`.
 *   1. Store: unchanged counter → no fetch; bumped counter (own or PUBLIC) → fetch; daily refresh;
 *      slow Bento → cached/static copy, fresh copy used once it lands; Redis or Bento down → fallback;
 *      failure backoff.
 *   2. Lookups: owner sees every name; others only SYSTEM/PUBLIC names and nodes in their allowlist;
 *      allowedIds null (Permify not configured) = tenant-wide; old-format catalogs still load.
 *   3. Classifier: a Private title routes the owner's question, not an invited user's; short names
 *      route only next to a document word; deferTo (S2-61) and named persons use the same lookups.
 * No network.
 */

const assert = require('assert');

let passed = 0;
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); passed++; };
const ok = (c, msg) => { assert.ok(c, msg); passed++; };

const { createEntityCatalogStore, versionKey } = require('../utils/entity_catalog.js');
const { classifyDomain, buildRoutingLookups, classifyNamedPerson } = require('../utils/intent_classifier.js');

const quiet = fn => async (...a) => {
    const log = console.log, warn = console.warn;
    console.log = () => {}; console.warn = () => {};
    try { return await fn(...a); } finally { console.log = log; console.warn = warn; }
};

const T = 'org_test';
const DOC_ID = 'doc-1';
const CATALOG = {
    entries: [
        { name: 'BERT: Pre-training of Deep Bidirectional Transformers', domain: 'document', node_id: DOC_ID, tier: 'org', short_name: 'BERT' },
        { name: 'Cortex-Drive', domain: 'career', node_id: 'c-1', tier: 'PUBLIC' },
        { name: 'Graph Talk Episode', domain: 'podcast', node_id: 'p-1', tier: 'org' },
        { name: 'Ada Guest', domain: 'person', node_id: 'u-1', tier: 'org' },
    ],
    bridge_entities: {},
};

function fakeRedis() {
    const store = {};
    return {
        store, down: false,
        async mget(...keys) { if (this.down) throw new Error('redis down'); return keys.map(k => store[k] ?? null); },
    };
}

async function storeTests() {
    let clock = 0;
    const redis = fakeRedis();
    let fetches = 0, delayMs = 0, fail = false;
    const fetchCatalog = async () => {
        fetches++;
        if (delayMs) await new Promise(r => setTimeout(r, delayMs));
        if (fail) throw new Error('bento down');
        return { entries: [], version_marker: fetches };
    };
    const STATIC = { static: true };
    const store = createEntityCatalogStore({ redis, fetchCatalog, staticCatalog: STATIC, now: () => clock,
        limits: { refreshTimeoutMs: 50, maxAgeMs: 1000, failureBackoffMs: 100 } });
    const get = quiet(store.getCatalog);

    eq((await get(T)).version_marker, 1, 'first question fetches');
    await get(T);
    eq(fetches, 1, 'unchanged counter → no fetch');
    redis.store[versionKey(T)] = 1;
    eq((await get(T)).version_marker, 2, 'own counter bumped → fresh catalog on that same question');
    redis.store[versionKey('PUBLIC')] = 1;
    eq((await get(T)).version_marker, 3, 'PUBLIC counter bumped → fresh catalog');
    clock += 1001;
    eq((await get(T)).version_marker, 4, 'older than max age → daily refresh');

    redis.store[versionKey(T)] = 2; delayMs = 120;
    eq((await get(T)).version_marker, 4, 'slow Bento → cached catalog after the timeout');
    await new Promise(r => setTimeout(r, 150));
    delayMs = 0;
    eq((await get(T)).version_marker, 5, 'the slow fetch lands and is used next time, without refetching');
    eq(fetches, 5, 'no duplicate fetch');

    redis.down = true;
    eq((await get(T)).version_marker, 5, 'Redis down → cached catalog');
    redis.down = false;

    fail = true; redis.store[versionKey(T)] = 3;
    eq((await get(T)).version_marker, 5, 'Bento down → last good catalog');
    const before = fetches;
    await get(T);
    eq(fetches, before, 'no retry within the failure backoff');
    eq(await get('org_never_seen'), STATIC, 'Bento down and nothing cached → static catalog');
    clock += 101; fail = false;
    eq((await get(T)).entries !== undefined, true, 'retried after the backoff');
    eq(await get(''), STATIC, 'no tenant → static catalog');
}

async function lookupTests() {
    const owner = buildRoutingLookups(CATALOG, { isOwner: true, allowedIds: [] });
    const invited = buildRoutingLookups(CATALOG, { isOwner: false, allowedIds: [] });
    const shared = buildRoutingLookups(CATALOG, { isOwner: false, allowedIds: [DOC_ID] });
    const legacy = buildRoutingLookups(CATALOG, { isOwner: false, allowedIds: null });
    eq(owner.entity.size, 3, 'owner: every routing name');
    eq([...invited.entity.keys()], ['cortex-drive'], 'invited, nothing shared: PUBLIC names only');
    eq(invited.withheld, 3, 'withheld count reported');
    ok(shared.entity.has(CATALOG.entries[0].name.toLowerCase()) && shared.short.length === 1, 'shared document: its title and short name route');
    eq(legacy.entity.size, 3, 'allowedIds null (Permify not configured) = tenant-wide, as for answers');
    eq(classifyNamedPerson('What did Ada Guest say?', owner), 'Ada Guest', 'owner: named person found');
    eq(classifyNamedPerson('What did Ada Guest say?', invited), null, 'invited: org person not visible');
    const old = buildRoutingLookups({ domains: { career: ['Cortex-Drive'] }, persons: ['Ada Guest'] }, { isOwner: false, allowedIds: [] });
    ok(old.entity.has('cortex-drive') && old.person.has('ada guest'), 'pre-S2-60 catalog format still loads');
}

async function classifierTests() {
    process.env.ENABLE_DOCUMENT_DOMAIN = 'true';
    const classify = quiet(classifyDomain);
    const owner = buildRoutingLookups(CATALOG, { isOwner: true, allowedIds: [] });
    const invited = buildRoutingLookups(CATALOG, { isOwner: false, allowedIds: [] });
    const title = 'What does BERT: Pre-training of Deep Bidirectional Transformers cover?';
    eq((await classify(title, null, owner)).domain, 'document', 'owner: full title → document');
    eq((await classify(title, null, invited)).domain, 'career', 'invited: Private title does not route (safe default)');
    eq((await classify("What does the BERT paper's figure show about pre-training?", null, owner)).domain, 'document', 'short name + document word → document');
    eq((await classify('What does the BERT report conclude?', null, owner)).domain, 'document', 'short name + "report"');
    eq((await classify('Has Sangeetha worked with BERT models?', null, owner)).domain, 'career', 'short name alone does not route');
    eq((await classify("What does the BERT paper's figure show?", null, invited)).domain, 'career', 'invited: short name of a Private document does not route');
    eq((await classify('According to the paper about Cortex-Drive, what was built?', null, owner)).domain, 'career', 'deferTo still uses the lookups');
    delete process.env.ENABLE_DOCUMENT_DOMAIN;
    eq((await classify("What does the BERT paper's figure show?", null, owner)).domain, 'career', 'flag off: document names never route');
}

(async () => {
    await storeTests();
    await lookupTests();
    await classifierTests();
    console.log(`verify_entity_catalog: ${passed} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
