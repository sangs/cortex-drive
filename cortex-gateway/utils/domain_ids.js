'use strict';
/**
 * Domain ids and aliases (domain-id-aliases-design-2026-11-16.md). Mirrors domain_registry.canonical_domain /
 * external_signal; data from config/domain_manifests.json (keyed by domain id, e.g. "professional", with
 * `aliases: ["career"]` and `external_signal: "career"`).
 *
 *   canonicalDomain(name)   id or alias → domain id; null when unknown (never a guess)
 *   externalSignal(name)    id or alias → the name the gateway routes with and sends to the browser
 *   contentDomainIds()      every domain id in the mirror (content domains)
 *   manifestFor(name)       the mirror entry for an id or alias, or null
 *
 * No hand-written id↔alias tables anywhere else (tests/verify_domain_ids.js checks).
 */
const MANIFESTS = require('../config/domain_manifests.json');

function buildNames(manifests) {
    const names = new Map();
    for (const [id, m] of Object.entries(manifests)) {
        for (const name of [id, ...(m.aliases || [])]) {
            const key = String(name).trim().toLowerCase();
            if (names.has(key) && names.get(key) !== id) {
                throw new Error(`domain name "${name}" used by "${names.get(key)}" and "${id}"`);
            }
            names.set(key, id);
        }
    }
    return names;
}

const NAMES = buildNames(MANIFESTS);

const canonicalDomain = name => NAMES.get(String(name == null ? '' : name).trim().toLowerCase()) || null;

function externalSignal(name) {
    const id = canonicalDomain(name);
    return id ? (MANIFESTS[id].external_signal || id) : null;
}

const contentDomainIds = () => Object.keys(MANIFESTS);
const manifestFor = name => { const id = canonicalDomain(name); return id ? MANIFESTS[id] : null; };

module.exports = { canonicalDomain, externalSignal, contentDomainIds, manifestFor, buildNames };
