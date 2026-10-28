'use strict';
/**
 * Per-tenant entity catalog cache for routing (S2-60).
 *
 * The classifier's name lookups (Phase E, Phase B, named persons) come from an entity catalog built
 * from Neo4j by src/mcp_server/entity_catalog.py. The image carries a static copy made at deploy;
 * this store keeps a fresh copy per tenant, refetched from Bento POST /entity_catalog when:
 *   - the tenant's version counter changed (writers INCR `entcat_version:{tenant}` after adding a
 *     source; PUBLIC sources bump `entcat_version:PUBLIC`, which every tenant's catalog includes), or
 *   - the copy is older than MAX_AGE_MS (D3: daily safety refresh).
 * A refetch is awaited at most REFRESH_TIMEOUT_MS (D2) so the first question after adding a source
 * routes by its title; after that the last good copy is used and the fetch finishes in the background.
 * Failures never break routing: last good copy → static catalog. Bento is not retried for
 * FAILURE_BACKOFF_MS after a failure.
 *
 * Design: documents/architecture/entity-catalog-freshness-design-2026-10-27.md
 */

const ENTITY_CATALOG_VERSION_KEY_PREFIX = 'entcat_version';   // mirrors schema_guard.py
const GLOBAL_CATALOG_TENANT = 'PUBLIC';
const REFRESH_TIMEOUT_MS = 1500;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 60 * 1000;

const versionKey = tenantId => `${ENTITY_CATALOG_VERSION_KEY_PREFIX}:${tenantId}`;

/**
 * @param {object} deps
 * @param {{mget: Function}} deps.redis
 * @param {(tenantId: string) => Promise<object>} deps.fetchCatalog  Bento /entity_catalog
 * @param {object} deps.staticCatalog
 * @param {() => number} [deps.now]
 * @param {object} [deps.limits]  test overrides: refreshTimeoutMs, maxAgeMs, failureBackoffMs
 */
function createEntityCatalogStore({ redis, fetchCatalog, staticCatalog, now = Date.now, limits = {} }) {
    const refreshTimeoutMs = limits.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS;
    const maxAgeMs = limits.maxAgeMs ?? MAX_AGE_MS;
    const failureBackoffMs = limits.failureBackoffMs ?? FAILURE_BACKOFF_MS;
    const cache = new Map();      // tenantId → { version, catalog, fetchedAt }
    const inflight = new Map();   // tenantId → Promise
    const lastFailure = new Map();

    async function readVersion(tenantId) {
        try {
            const [own, global] = await redis.mget(versionKey(tenantId), versionKey(GLOBAL_CATALOG_TENANT));
            return `${own || 0}:${global || 0}`;
        } catch (e) {
            console.warn(`[CATALOG] version check failed (${e.message}) — using cached catalog`);
            return null;
        }
    }

    function refresh(tenantId, version) {
        if (inflight.has(tenantId)) return inflight.get(tenantId);
        const p = (async () => {
            try {
                const catalog = await fetchCatalog(tenantId);
                cache.set(tenantId, { version, catalog, fetchedAt: now() });
                lastFailure.delete(tenantId);
                console.log(`[CATALOG] refreshed tenant=${tenantId} version=${version} entries=${(catalog.entries || []).length}`);
                return catalog;
            } catch (e) {
                lastFailure.set(tenantId, now());
                console.warn(`[CATALOG] refresh failed tenant=${tenantId}: ${e.message}`);
                return null;
            } finally {
                inflight.delete(tenantId);
            }
        })();
        inflight.set(tenantId, p);
        return p;
    }

    /** The catalog to route this tenant's question with. Never throws. */
    async function getCatalog(tenantId) {
        if (!tenantId) return staticCatalog;
        const entry = cache.get(tenantId);
        const version = await readVersion(tenantId);
        const stale = !entry
            || (version !== null && version !== entry.version)
            || now() - entry.fetchedAt > maxAgeMs;
        if (!stale) return entry.catalog;
        const failedAt = lastFailure.get(tenantId);
        if (failedAt !== undefined && now() - failedAt < failureBackoffMs) {
            return entry ? entry.catalog : staticCatalog;
        }
        let timer;
        const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), refreshTimeoutMs); });
        const fresh = await Promise.race([refresh(tenantId, version), timeout]);
        clearTimeout(timer);
        if (fresh) return fresh;
        if (entry) return entry.catalog;
        console.log(`[CATALOG] using static catalog for tenant=${tenantId}`);
        return staticCatalog;
    }

    return { getCatalog };
}

module.exports = { createEntityCatalogStore, versionKey, ENTITY_CATALOG_VERSION_KEY_PREFIX };
