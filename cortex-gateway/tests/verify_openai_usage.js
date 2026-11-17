'use strict';
/**
 * OpenAI usage recording (FinOps release 1, 2026-11-16): costs, event shape, never-throw, request user type,
 * every gateway OpenAI call wrapped, Python mirror up to date.
 *
 *     node cortex-gateway/tests/verify_openai_usage.js
 */
process.env.LOG_EVENT_STRICT = '1';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const usage = require('../utils/openai_usage');
const { buildMirror, MIRROR } = require('../scripts/sync_openai_usage_config');

let passed = 0;
function test(name, fn) {
    return Promise.resolve().then(fn).then(() => { passed++; }, (err) => {
        console.error(`FAIL ${name}\n  ${err && err.stack}`);
        process.exitCode = 1;
    });
}

const CASES = require('./fixtures/openai_usage_cases.json').cases;
const capture = () => { const lines = []; return { lines, sink: l => lines.push(JSON.parse(l)) }; };

(async () => {
    for (const c of CASES) {
        await test(`cost: ${c.name}`, () => {
            const f = usage.usageFields({ feature: 'chat', model: c.model, usage: c.usage, service: 'svc' });
            for (const [k, v] of Object.entries(c.expect)) assert.strictEqual(f[k], v, `${k}`);
        });
    }

    await test('event carries only allow-listed fields, no content', () => {
        const { lines, sink } = capture();
        const response = { model: 'gpt-4o', usage: { prompt_tokens: 10, completion_tokens: 2 },
                           choices: [{ message: { content: 'SECRET ANSWER' } }] };
        const out = usage.recordOpenAIUsage(usage.OPENAI_FEATURES.CHAT, response, { userType: 'owner', sink });
        assert.strictEqual(out, response, 'response returned unchanged');
        assert.strictEqual(lines.length, 1);
        const e = lines[0];
        assert.strictEqual(e.tag, 'OPENAI_USAGE');
        assert.strictEqual(e.event, 'openai.usage');
        assert.strictEqual(e.user_type, 'owner');
        assert.strictEqual(e.prices_effective, usage.PRICES.effective_date);
        assert.ok(!JSON.stringify(e).includes('SECRET'), 'no content in the log');
    });

    await test('unknown model: cost 0 plus a price_missing warning', () => {
        const { lines, sink } = capture();
        usage.recordOpenAIUsage('chat', { model: 'gpt-9', usage: { prompt_tokens: 5 } }, { sink });
        assert.strictEqual(lines.length, 2);
        assert.strictEqual(lines[1].event, 'openai.price_missing');
        assert.strictEqual(lines[1].severity, 'WARNING');
    });

    await test('never throws, even on a broken sink or response', () => {
        const r = usage.recordOpenAIUsage('chat', undefined, { sink: () => { throw new Error('boom'); } });
        assert.strictEqual(r, undefined);
    });

    await test('withUsage returns the call result and reads user type from the request', async () => {
        const { lines, sink } = capture();
        const req = { headers: { 'x-user-type': 'guest' } };
        const response = { model: 'text-embedding-3-small', usage: { prompt_tokens: 3 } };
        let got;
        await new Promise(resolve => usage.usageContextMiddleware(req, {}, async () => {
            got = await usage.withUsage('classify_embed', Promise.resolve(response), { sink });
            resolve();
        }));
        assert.strictEqual(got, response);
        assert.strictEqual(lines[0].user_type, 'guest');
    });

    await test('service name from Cloud Run, local otherwise', () => {
        assert.strictEqual(usage.serviceName({ K_SERVICE: 'cortex-gateway' }), 'cortex-gateway');
        assert.strictEqual(usage.serviceName({ CLOUD_RUN_JOB: 'job' }), 'job');
        assert.strictEqual(usage.serviceName({}), 'local');
    });

    await test('every gateway OpenAI call is recorded', () => {
        const root = path.join(__dirname, '..');
        for (const file of ['index.js', path.join('utils', 'intent_classifier.js')]) {
            const src = fs.readFileSync(path.join(root, file), 'utf8');
            const calls = src.match(/\.(chat\.completions|embeddings)\.create\(/g) || [];
            const wrapped = src.match(/withUsage\(\s*OPENAI_FEATURES\.\w+,\s*\w+\.(chat\.completions|embeddings)\.create\(/g) || [];
            assert.ok(calls.length > 0, `${file}: calls found`);
            assert.strictEqual(wrapped.length, calls.length, `${file}: ${calls.length} calls, ${wrapped.length} recorded`);
        }
    });

    await test('every price has input/output numbers and a source', () => {
        assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(usage.PRICES.effective_date));
        assert.ok(usage.PRICES.source_url.startsWith('https://'));
        for (const [m, p] of Object.entries(usage.PRICES.models)) {
            assert.strictEqual(typeof p.input_per_1m, 'number', m);
            assert.strictEqual(typeof p.output_per_1m, 'number', m);
        }
    });

    await test('Python mirror is up to date', () => {
        assert.strictEqual(fs.readFileSync(MIRROR, 'utf8'), buildMirror(),
            'run: node cortex-gateway/scripts/sync_openai_usage_config.js');
    });

    console.log(`verify_openai_usage: ${passed} passed${process.exitCode ? ', FAILURES above' : ''}`);
})();
