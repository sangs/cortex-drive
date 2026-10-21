'use strict';

/**
 * S2-33: fetchWithColdStartRetry (utils/upstream_fetch.js). Run: `node tests/verify_upstream_fetch.js` or
 * `npm test`. A fake fetch stands in for the network; plain Node `assert`.
 */

const assert = require('assert');
const { fetchWithColdStartRetry, UPSTREAM_COLD_START_TIMEOUT_MS } = require('../utils/upstream_fetch.js');

function fakeFetch(script) {   // script: array of 'timeout' | status numbers, one per call
    const calls = [];
    const impl = async (url, opts) => {
        calls.push(opts);
        const step = script[calls.length - 1];
        if (step === 'timeout') { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }
        return { status: step, ok: step >= 200 && step < 300 };
    };
    return { impl, calls };
}

const quiet = { retryDelayMs: 1, label: 'test' };
let passed = 0;
const origWarn = console.warn; console.warn = () => {};

(async () => {
    // Cold start: the first attempt times out, the retry succeeds.
    let f = fakeFetch(['timeout', 200]);
    let res = await fetchWithColdStartRetry('u', { method: 'POST' }, { ...quiet, fetchImpl: f.impl });
    assert.strictEqual(res.status, 200); assert.strictEqual(f.calls.length, 2); passed++;
    assert.ok(f.calls[0].signal, 'each attempt gets a timeout signal'); assert.strictEqual(f.calls[0].method, 'POST'); passed++;

    // Cloud Run 503 while an instance starts, then 200.
    f = fakeFetch([503, 200]);
    res = await fetchWithColdStartRetry('u', {}, { ...quiet, fetchImpl: f.impl });
    assert.strictEqual(res.status, 200); assert.strictEqual(f.calls.length, 2); passed++;

    // Gives up after one retry: a timeout twice rethrows; a 503 twice returns the 503.
    f = fakeFetch(['timeout', 'timeout']);
    await assert.rejects(fetchWithColdStartRetry('u', {}, { ...quiet, fetchImpl: f.impl }), /timeout/); assert.strictEqual(f.calls.length, 2); passed++;
    f = fakeFetch([503, 503]);
    res = await fetchWithColdStartRetry('u', {}, { ...quiet, fetchImpl: f.impl });
    assert.strictEqual(res.status, 503); assert.strictEqual(f.calls.length, 2); passed++;

    // Normal answers (incl. 4xx/500) are not retried.
    for (const s of [200, 404, 401, 500]) {
        f = fakeFetch([s]);
        res = await fetchWithColdStartRetry('u', {}, { ...quiet, fetchImpl: f.impl });
        assert.strictEqual(res.status, s); assert.strictEqual(f.calls.length, 1, `no retry on ${s}`); passed++;
    }

    // It waits longer than the old 8 s / 5 s limits.
    assert.ok(UPSTREAM_COLD_START_TIMEOUT_MS >= 15000); passed++;

    console.warn = origWarn;
    console.log(`upstream fetch: ${passed}/${passed} passed.`);
})().catch(e => { console.warn = origWarn; console.error(e); process.exit(1); });
