'use strict';
/**
 * Held-out bridge questions — a REPORT, not a gate (bridge-pipeline-without-model-design-2026-11-13.md §12).
 * Offline: the code planner and routing v2 against bridge_heldout_set.json with the catalog file, for the platform owner.
 * The kind/subject rules for a named person need the live ownership lookup (MCP person_work_items); those cases are
 * counted separately. Never tune code to this set: record a miss's cause, fix the mechanism or data, then draft a
 * new held-out set.
 * Run: node tests/routing_eval/bridge_heldout_eval.js [--set heldout_round2_set.json]
 * A set with a `routing` list (round 2+) also reports its non-bridge questions (mode + domains, evaluate.js predictV2).
 */
process.env.ENABLE_DOCUMENT_DOMAIN = 'true';
const { buildRoutingLookups } = require('../../utils/intent_classifier.js');
const { routeQuestion } = require('../../utils/routing_v2.js');
const { planBridge } = require('../../utils/bridge_plan.js');
const { canonicalDomain } = require('../../utils/domain_ids');
const catalog = require('../../config/entity_catalog.json');
const setArg = process.argv.indexOf('--set');
const set = require(`./${setArg > 0 ? process.argv[setArg + 1] : 'bridge_heldout_set.json'}`);
const { predictV2 } = require('./evaluate.js');
const snapshot = require('./coverage_snapshot.json').coverage;

const LIVE_ONLY = /^her |owner to confirm/;   // labels that only the live ownership lookup can check
const coverage = async terms => {
    const out = {};
    for (const t of terms) (snapshot[t.toLowerCase()] || []).forEach(d => { out[d] = true; });
    return out;
};

(async () => {
    const ownerId = catalog.entries.find(e => e.owner_id && e.tier !== 'PUBLIC' && e.tier !== 'SYSTEM').owner_id;
    const lookups = buildRoutingLookups(catalog, { isOwner: true, userId: ownerId, allowedIds: [] });
    const tally = { routed: 0, sources: 0, target: 0, liveOnly: 0 };
    const misses = [];
    for (const c of set.cases) {
        const x = c.expected;
        const r = await routeQuestion(c.q, lookups, { coverage });
        const p = planBridge(c.q, lookups);
        const routed = r.mode === 'bridge' || (x.rule === 'clarify' && r.mode === 'clarify');
        let sourcesOk;
        let targetOk = true;
        if (x.rule === 'clarify') {
            sourcesOk = p.kind === 'clarify';
        } else if (p.kind !== 'plan') {
            sourcesOk = false; targetOk = false;
        } else {
            const got = p.sources.map(s => s.name);
            const liveOnly = x.sources.some(s => LIVE_ONLY.test(s));
            if (liveOnly) tally.liveOnly++;
            sourcesOk = liveOnly || (got.length === x.sources.length && x.sources.every(s => got.includes(s)));
            // Domain names compare through the alias (career = professional; domain-id-aliases design).
            const doms = ds => `domains:${ds.map(d => canonicalDomain(d) || d).sort().join('+')}`;
            const gotT = p.target ? p.target.name : doms(p.target_domains);
            const wantT = x.target || doms(x.target_domains || []);
            targetOk = gotT === wantT;
            if (!sourcesOk || !targetOk) misses.push(`${c.id} sources ${JSON.stringify(got)} target ${gotT} (want ${wantT})`);
        }
        if (!routed) misses.push(`${c.id} routed as ${r.mode}`);
        tally.routed += routed; tally.sources += sourcesOk; tally.target += targetOk;
    }
    const n = set.cases.length;
    console.log(`bridge held-out (${set.status}, ${n} questions): routed as bridge ${tally.routed}/${n}, sources ${tally.sources}/${n} ` +
        `(${tally.liveOnly} checkable only live), target ${tally.target}/${n}`);
    misses.forEach(m => console.log(`  ✗ ${m}`));
    if (Array.isArray(set.routing) && set.routing.length) {
        const quiet = console.log;
        const bad = [];
        for (const c of set.routing) {
            console.log = () => {};
            let p;
            try { p = await predictV2(c.q, c.history); } finally { console.log = quiet; }
            const want = [...c.domains].map(d => canonicalDomain(d) || d).sort().join('+');
            const got = [...p.domains].map(d => canonicalDomain(d) || d).sort().join('+');
            const noDomains = ['discovery', 'small_talk', 'out_of_scope', 'overview', 'clarify'].includes(c.mode);
            if (p.mode !== c.mode || (!noDomains && want !== got)) bad.push(`${c.id} ${JSON.stringify(c.q)} want ${c.mode} ${want} got ${p.mode} ${got}`);
        }
        console.log(`non-bridge held-out (${set.routing.length} questions): exact ${set.routing.length - bad.length}/${set.routing.length}`);
        bad.forEach(m => console.log(`  ✗ ${m}`));
    }
})();
