'use strict';
/**
 * Offline routing evaluation (cross-domain discovery design 2026-11-09 §4.1, evaluation gate). No network:
 * the static entity catalog stands in for the live one and coverage_snapshot.json for the live coverage check.
 *
 *   node tests/routing_eval/evaluate.js            # current classifier
 *   node tests/routing_eval/evaluate.js --fails    # also list every wrong case
 *
 * Reports, per content domain, precision and recall of "this domain is searched", the share of cases with exactly
 * the right domains and mode, and a mode confusion matrix. With --gate it exits non-zero below the thresholds in
 * GATE (used by npm test once routing v2 lands).
 */
process.env.ENABLE_DOCUMENT_DOMAIN = process.env.ENABLE_DOCUMENT_DOMAIN || 'true';   // as in production
const { classifyDomain } = require('../../utils/intent_classifier.js');
const { cases } = require('./routing_eval_set.json');

const DOMAINS = ['career', 'podcast', 'website', 'document'];
const MODES = ['single', 'cross', 'bridge', 'clarify', 'discovery'];
const GATE = { exact: 0.85, recall: 0.9, precision: 0.85 };

/** Today's classifier (one label): cross_domain = the bridge path searching everything; unconfident = Flow 4. */
async function predictV1(q) {
    const { domain, confident } = await classifyDomain(q, null);
    if (!confident) return { domains: [], mode: 'discovery' };
    if (domain === 'cross_domain') return { domains: [...DOMAINS], mode: 'bridge' };
    return { domains: [domain], mode: 'single' };
}

async function evaluate(predict) {
    const quiet = console.log;
    const stats = Object.fromEntries(DOMAINS.map(d => [d, { tp: 0, fp: 0, fn: 0 }]));
    const confusion = Object.fromEntries(MODES.map(m => [m, Object.fromEntries(MODES.map(n => [n, 0]))]));
    const fails = [];
    let exact = 0;
    for (const c of cases) {
        console.log = () => {};
        let p;
        try { p = await predict(c.q); } finally { console.log = quiet; }
        const got = new Set(p.domains), want = new Set(c.domains);
        // Discovery searches everything by design; domain scoring applies only when a domain set is expected.
        if (c.mode !== 'discovery') {
            for (const d of DOMAINS) {
                if (got.has(d) && want.has(d)) stats[d].tp++;
                else if (got.has(d)) stats[d].fp++;
                else if (want.has(d)) stats[d].fn++;
            }
        }
        confusion[c.mode][p.mode] = (confusion[c.mode][p.mode] || 0) + 1;
        const same = c.mode === p.mode && (c.mode === 'discovery' || [...want].sort().join() === [...got].sort().join());
        if (same) exact++; else fails.push({ ...c, got: p });
    }
    const per = Object.fromEntries(DOMAINS.map(d => {
        const s = stats[d];
        return [d, { precision: s.tp / Math.max(1, s.tp + s.fp), recall: s.tp / Math.max(1, s.tp + s.fn), ...s }];
    }));
    const tot = Object.values(stats).reduce((a, s) => ({ tp: a.tp + s.tp, fp: a.fp + s.fp, fn: a.fn + s.fn }), { tp: 0, fp: 0, fn: 0 });
    return { n: cases.length, exact: exact / cases.length, precision: tot.tp / (tot.tp + tot.fp), recall: tot.tp / (tot.tp + tot.fn), per, confusion, fails };
}

function report(name, r, showFails) {
    const pct = x => `${(100 * x).toFixed(1)}%`;
    console.log(`\n=== ${name}: ${r.n} cases ===`);
    console.log(`exact (domains + mode): ${pct(r.exact)}   micro precision ${pct(r.precision)}   micro recall ${pct(r.recall)}`);
    for (const [d, s] of Object.entries(r.per)) console.log(`  ${d.padEnd(9)} precision ${pct(s.precision).padStart(6)}  recall ${pct(s.recall).padStart(6)}  (tp ${s.tp}, fp ${s.fp}, fn ${s.fn})`);
    console.log(`mode confusion (rows = expected, columns = predicted): ${MODES.join(' / ')}`);
    for (const m of MODES) console.log(`  ${m.padEnd(9)} ${MODES.map(n => String(r.confusion[m][n]).padStart(4)).join(' ')}`);
    if (showFails) for (const f of r.fails) console.log(`  ✗ ${f.id} [${f.origin}] ${JSON.stringify(f.q)} want ${f.mode} ${f.domains} got ${f.got.mode} ${f.got.domains}`);
}

module.exports = { evaluate, report, predictV1, GATE, DOMAINS };

if (require.main === module) {
    (async () => {
        const r = await evaluate(predictV1);
        report('routing v1 (today)', r, process.argv.includes('--fails'));
        if (process.argv.includes('--gate')) {
            const ok = r.exact >= GATE.exact && r.recall >= GATE.recall && r.precision >= GATE.precision;
            console.log(ok ? 'GATE passed' : `GATE failed (needs exact ≥ ${GATE.exact}, recall ≥ ${GATE.recall}, precision ≥ ${GATE.precision})`);
            process.exitCode = ok ? 0 : 1;
        }
    })();
}
