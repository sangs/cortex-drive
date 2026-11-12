'use strict';
/**
 * Content-gaps log (§4.5, design 2026-11-09). Run: node tests/verify_content_gaps.js (npm test).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createContentGaps, normaliseQuestion, gapKindFor } = require('../utils/content_gaps.js');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };

(async () => {
    eq(normaliseQuestion('  What is Kafka 3.6? See https://x.io/a and mail a.b@c.com  '),
       'what is kafka #.#? see <url> and mail <email>', 'normalised: numbers masked, URL and email removed');
    eq(normaliseQuestion('x'.repeat(500)).length, 200, 'capped at 200 characters');
    eq([gapKindFor({ no_data: true, mode: 'discovery' }), gapKindFor({ mode: 'out_of_scope' }), gapKindFor({ mode: 'clarify' }),
        gapKindFor({ mode: 'single' }), gapKindFor(null)], ['no_data', 'out_of_scope', 'clarify', null, null], 'gap kinds');

    const queries = [];
    const db = { query: async (sql, params) => { queries.push([sql, params]); return { rows: [{ kind: 'no_data', times: 2 }] }; } };
    const gaps = createContentGaps({ db });
    await gaps.record({ orgId: 'org_1', userType: 'org_member', kind: 'no_data', question: 'What about Kotlin 2?', topics: ['Kotlin'] });
    eq(queries[0][1], ['org_1', 'org_member', 'no_data', 'what about kotlin #?', ['Kotlin']], 'row written');
    await gaps.record({ orgId: 'org_1', kind: 'single', question: 'x' });
    await gaps.record({ orgId: '', kind: 'no_data', question: 'x' });
    eq(queries.length, 1, 'unknown kind or no org → nothing written');
    const failing = createContentGaps({ db: { query: async () => { throw new Error('db down'); } }, log: { warn() {} } });
    await failing.record({ orgId: 'org_1', kind: 'clarify', question: 'x' });
    ok(true, 'a database failure never throws');
    await gaps.orgReport('org_1', 7);
    ok(/WHERE org_id = \$1/.test(queries[1][0]) && queries[1][1][0] === 'org_1', 'org report filtered to the asker\'s organization');
    await gaps.platformCounts(7);
    ok(!/question_pattern/.test(queries[2][0]), 'platform view has no question text');

    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    ok(/app\.get\('\/api\/admin\/content-gaps', authMiddleware, requireCapability\('admin'/.test(src), 'report behind the admin capability');
    ok(/scope === 'platform'[\s\S]{0,120}isOwner\(req\.headers\['x-user-id'\]\)/.test(src), 'platform view for the platform owner only');
    ok(/const gapKind = gapKindFor\(routingV2\)/.test(src), 'clarify / no data / out of scope recorded');

    console.log(`verify_content_gaps: ${passed} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
