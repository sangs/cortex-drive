'use strict';

/**
 * fetch() for READ calls to internal Cloud Run services that scale to zero (cortex-mcp, cortex-bento).
 * S2-33 (2026-10-21): the first request after an idle period timed out at the gateway (8 s / 5 s) while the
 * service was still starting, and the user saw an error that a retry seconds later didn't have.
 *
 * Waits longer (UPSTREAM_COLD_START_TIMEOUT_MS) and retries once on a timeout, a network error, or a
 * 502/503/504 (Cloud Run's responses while an instance starts). Only for idempotent reads: never for
 * calls that write.
 */

const UPSTREAM_COLD_START_TIMEOUT_MS = 20000;
const UPSTREAM_COLD_START_RETRIES = 1;
const UPSTREAM_RETRY_DELAY_MS = 1000;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

async function fetchWithColdStartRetry(url, options = {}, {
    timeoutMs = UPSTREAM_COLD_START_TIMEOUT_MS,
    retries = UPSTREAM_COLD_START_RETRIES,
    retryDelayMs = UPSTREAM_RETRY_DELAY_MS,
    label = 'upstream',
    fetchImpl = fetch,
} = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
            if (!RETRYABLE_STATUSES.has(res.status) || attempt === retries) return res;
            console.warn(`[${label}] HTTP ${res.status} (attempt ${attempt + 1}); retrying once (cold start?)`);
        } catch (err) {
            lastError = err;
            if (attempt === retries) throw err;
            console.warn(`[${label}] ${err.name || 'Error'}: ${err.message} (attempt ${attempt + 1}); retrying once (cold start?)`);
        }
        await new Promise(r => setTimeout(r, retryDelayMs));
    }
    throw lastError;
}

module.exports = { fetchWithColdStartRetry, UPSTREAM_COLD_START_TIMEOUT_MS, UPSTREAM_COLD_START_RETRIES, RETRYABLE_STATUSES };
