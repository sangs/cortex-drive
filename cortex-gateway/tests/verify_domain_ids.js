'use strict';
/**
 * Domain ids and aliases (domain-id-aliases-design-2026-11-16.md §5; utils/domain_ids.js).
 * - the mirror is keyed by domain id; aliases and the external signal are data;
 * - canonicalDomain / externalSignal round-trip every id and alias; unknown → null (never a guess);
 * - a name used by two domains is refused at load;
 * - no hand-written id↔alias table remains in the gateway.
 * No network. Run: node tests/verify_domain_ids.js (npm test).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const MANIFESTS = require('../config/domain_manifests.json');
const { canonicalDomain, externalSignal, contentDomainIds, manifestFor, buildNames } = require('../utils/domain_ids');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };

eq(contentDomainIds().sort(), ['document', 'podcast', 'professional', 'website'], 'mirror keyed by domain id');
for (const [id, m] of Object.entries(MANIFESTS)) {
    eq(canonicalDomain(id), id, id);
    eq(canonicalDomain(id.toUpperCase()), id, `${id} any case`);
    for (const alias of m.aliases || []) eq(canonicalDomain(alias), id, alias);
    eq(externalSignal(id), m.external_signal || id, `${id} signal`);
}
eq([canonicalDomain('career'), externalSignal('career'), externalSignal('professional')], ['professional', 'career', 'career']);
eq([canonicalDomain('cross_domain'), canonicalDomain(''), canonicalDomain(undefined), externalSignal('nope')], [null, null, null, null],
   'not a domain → null');
eq(manifestFor('career').display_name, 'Career');
assert.throws(() => buildNames({ a: { aliases: ['x'] }, b: { aliases: ['x'] } }), /used by/); passed++;
assert.throws(() => buildNames({ a: { aliases: ['b'] }, b: {} }), /used by/); passed++;

// No hand-written id↔alias table anywhere in the gateway code.
const files = [path.join(__dirname, '..', 'index.js'),
    ...fs.readdirSync(path.join(__dirname, '..', 'utils')).filter(f => f.endsWith('.js')).map(f => path.join(__dirname, '..', 'utils', f))];
const TABLE = /['"]?professional['"]?\s*:\s*['"]career['"]|['"]?career['"]?\s*:\s*['"]professional['"]/;
eq(files.filter(f => TABLE.test(fs.readFileSync(f, 'utf8'))).map(f => path.basename(f)), [],
   'use canonicalDomain / externalSignal instead of a table');

console.log(`verify_domain_ids: ${passed} checks passed`);
