'use strict';

/**
 * OpenFGA decommission (S2-37): the Share dialog's "whole organization" toggle now writes ONE Permify
 * tenant_viewer tuple, the same shape as permify_utils.make_tenant_wide (Python) and the Permify schema
 * (`relation tenant_viewer @org#member`). Run: `node tests/verify_permify_share.js` or `npm test`.
 * fetch is stubbed; no Permify or network needed.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const http = require('http');

process.env.PERMIFY_TENANT_ID = 'cortex-drive';
delete process.env.PERMIFY_API_TOKEN;
process.env.NODE_ENV = 'test';

// A local stand-in for Permify that records each request (permify_gateway uses node-fetch).
const sent = [];
const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => { sent.push({ url: req.url, method: req.method, body: JSON.parse(raw || '{}') });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
});
let passed = 0;

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    process.env.PERMIFY_API_URL = `http://127.0.0.1:${server.address().port}`;
    const permify = require('../utils/permify_gateway.js');
    await permify.makeNodeTenantWide('node-123', 'org_abc');
    server.close();
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].method, 'POST');
    assert.strictEqual(sent[0].url, '/v1/tenants/cortex-drive/relationships/write'); passed++;
    assert.deepStrictEqual(sent[0].body.tuples, [{
        entity: { type: 'node', id: 'node-123' },
        relation: 'tenant_viewer',
        subject: { type: 'org', id: 'org_abc', relation: 'member' },
    }]); passed++;

    // The schema really defines this relation with this subject type.
    const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'permify', 'authorization_schema.perm'), 'utf-8');
    assert.match(schema, /relation\s+tenant_viewer\s+@org#member/); passed++;

    // No OpenFGA left in the gateway.
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf-8');
    assert.ok(!/getFgaClient|OpenFgaClient|@openfga\/sdk|openfga_gateway|OPENFGA_/.test(index), 'index.js must not use OpenFGA'); passed++;
    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'utils', 'openfga_gateway.js'))); passed++;
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    assert.ok(!('@openfga/sdk' in (pkg.dependencies || {}))); passed++;

    console.log(`permify share: ${passed}/${passed} passed.`);
})().catch(e => { console.error(e); process.exit(1); });
