'use strict';
/**
 * Routing v2 coverage check, gateway side (cross-domain design 2026-11-09 §4.1 rule 3). Calls Bento
 * POST /domain_coverage (direct fetch + Cloud Run token, AP-18) as the asking user (x-user-id, guest anchor), and
 * maps content domains to the classifier's names. Returns null when the check is unavailable or slow, so routing
 * never mistakes an outage for "no data".
 */
const TO_GATEWAY = { professional: 'career', podcast: 'podcast', website: 'website', document: 'document' };
const COVERAGE_TIMEOUT_MS = Number(process.env.ROUTING_COVERAGE_TIMEOUT_MS || 1500);

function createDomainCoverage({ post, timeoutMs = COVERAGE_TIMEOUT_MS, log = console }) {
    return async function coverage({ tenantId, userId, guestAnchor }, terms) {
        if (!terms || !terms.length || !tenantId || !userId) return null;
        let timer;
        try {
            const body = await Promise.race([
                post({ tenantId, userId, guestAnchor, terms }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
            ]);
            const out = {};
            for (const [d, hit] of Object.entries((body && body.coverage) || {})) {
                if (TO_GATEWAY[d]) out[TO_GATEWAY[d]] = !!hit;
            }
            return out;
        } catch (e) {
            log.warn(`[ROUTING_V2] coverage unavailable (${e.message}) — falling back`);
            return null;
        } finally {
            clearTimeout(timer);
        }
    };
}

/** A clarifying-question choice from the browser, kept only if every name is a person this asker can see. */
function resolveClarifyChoice(choice, lookups) {
    if (!choice || choice.kind !== 'person') return [];
    const visible = new Set((lookups.person && [...lookups.person.values()]) || []);
    const names = Array.isArray(choice.names) ? choice.names : [choice.name];
    const ok = names.filter(n => typeof n === 'string' && visible.has(n));
    return ok.length === names.length ? ok : [];
}

module.exports = { createDomainCoverage, resolveClarifyChoice, TO_GATEWAY };
