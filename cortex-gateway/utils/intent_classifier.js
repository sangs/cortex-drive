'use strict';

/**
 * Multi-phase intent classifier for Cortex-Drive gateway.
 *
 * Execution order — cheapest phase runs first, paid phases only fire on miss:
 *
 *   Phase B — Bridge entity  free  <1ms   runs BEFORE Phase R (added 2026-08-24) — a
 *                                         catalogued entity empirically connecting two
 *                                         domains (e.g. "Apache Iceberg" in both website
 *                                         and podcast content) is a higher-precision signal
 *                                         than a generic regex keyword, and must not be
 *                                         masked by Phase R's short-circuit. See
 *                                         documents/architecture/website-domain-cross-domain-routing-design-2026-08-24.md
 *                                         §2.3 — additive only, every other phase below is
 *                                         byte-for-byte unchanged by this addition.
 *   Phase R — Regex         free  <1ms   deterministic keyword/pattern matching
 *   Phase E — Entity catalog free  <1ms   in-memory name lookup (Neo4j snapshot at deploy time)
 *   Phase S — Embedding      paid  ~50ms  cosine similarity against domain prototype centroids;
 *                                         fires only when R+E both miss; logs cost
 *   Phase L — LLM fallback   paid  ~300ms gated by ENABLE_LLM_CLASSIFICATION=true (disabled by default);
 *                                         logs when threshold is missed even while disabled
 *   Safe default: 'career'
 *
 * AP-21: classifyDomain() must never return 'unknown'. 'career' is the safe default because
 * this graph is about one person and unmatched queries are almost always career-intent.
 * 'unknown' bypasses the domain guard and causes graph explosion.
 *
 * See: documents/architecture/intent-classification-architecture.md
 * Research: documents/architecture/intent-classification-research-2026-04-25.md
 */

const fs   = require('fs');
const path = require('path');

// ─── Phase R: Regex patterns ──────────────────────────────────────────────────
// Order matters: cross_domain is checked before career so "how did my career influence..."
// routes to cross_domain, not career. Pattern DATA lives in ../config/intent_keywords.js — that
// is the only file a developer edits to add a new Phase R shortcut; this file only builds the
// actual RegExp objects from it. See that file's doc comment for the patternSource/keywords
// distinction and the keyword-selection discipline for new entries.

const INTENT_KEYWORDS_CONFIG = require('../config/intent_keywords.js');
const { documentDomainEnabled } = require('./feature_flags');
// Phase B M5: `document` matches (Phase R and Phase E) are ignored unless ENABLE_DOCUMENT_DOMAIN.
const DOCUMENT_DOMAIN = 'document';

// Evidence-backed single-word `keywords` entries — data lives in intent_keywords.js's
// singleWordAllowlist (the file a developer actually edits), not hardcoded here. Populated by
// the Phase R keyword-precision audit, 2026-09-21 — see that file's doc comment for the
// evidence rule every entry must satisfy.
const SINGLE_WORD_KEYWORD_ALLOWLIST = new Set(INTENT_KEYWORDS_CONFIG.singleWordAllowlist || []);

function _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Wraps an escaped literal keyword/phrase with word boundaries so e.g. "map" doesn't match
// inside "sitemap" — \b anchors correctly around interior spaces too, so this is safe for
// multi-word phrases as a single unit, not just single words.
function _wrapPhrase(escapedLiteral) {
    return `\\b${escapedLiteral}\\b`;
}

// Builds the real RegExp per domain from config: `patternSource` is used as raw regex source
// (preserves pre-externalization behavior exactly, unaudited — see the config file's doc
// comment), `keywords` entries are escaped + boundary-wrapped literals. Rejects bare
// single-word `keywords` entries (loud, not silent) unless explicitly allow-listed — this is
// where the "no ambiguous single-word Phase R triggers" discipline is actually enforced, not
// just documented.
function _buildIntentPatterns(config) {
    return config.domains.map(({ domain_signal, patternSource, keywords, deferTo }) => {
        const parts = [];
        if (patternSource) parts.push(patternSource);
        for (const kw of (keywords || [])) {
            if (!kw.includes(' ') && !SINGLE_WORD_KEYWORD_ALLOWLIST.has(kw)) {
                console.warn(`[CLASSIFY] intent_keywords.js: rejecting bare single-word keyword "${kw}" for domain=${domain_signal} — keywords must be multi-word phrases (or an allow-listed proper noun). Skipped, not applied.`);
                continue;
            }
            parts.push(_wrapPhrase(_escapeRegex(kw)));
        }
        try {
            return { domain_signal, pattern: new RegExp(parts.join('|'), 'i'), deferTo: deferTo || [] };
        } catch (e) {
            console.error(`[CLASSIFY] intent_keywords.js: malformed pattern for domain=${domain_signal}, this domain's Phase R entry is disabled:`, e.message);
            return null;
        }
    }).filter(Boolean);
}

const INTENT_PATTERNS = _buildIntentPatterns(INTENT_KEYWORDS_CONFIG);

// Returns { domain_signal, deferTo } for the first matching entry, or null. `deferTo` (config) marks an
// ambiguous phrasing: the caller lets named-entity evidence for one of those domains win (S2-61).
function _regexClassify(q) {
    for (const { domain_signal, pattern, deferTo } of INTENT_PATTERNS) {
        if (domain_signal === DOCUMENT_DOMAIN && !documentDomainEnabled()) continue;
        if (pattern.test(q)) return { domain_signal, deferTo };
    }
    return null;
}

// ─── Routing lookups: Phase E (entities), Phase B (bridges), named persons ────
// Built from an entity catalog (scripts/generate_entity_catalog.py → src/mcp_server/entity_catalog.py).
// Two sources (S2-60, documents/architecture/entity-catalog-freshness-design-2026-10-27.md):
//   - the static file baked into the image (cold-start fallback; the default below);
//   - a fresh per-tenant catalog the gateway fetches when a source is added (utils/entity_catalog.js),
//     compiled once per question by buildRoutingLookups() with the asker's visibility.
// Visibility (design §8, AP-30): a name routes a question only if the asker can open that node —
// owner: every entry; anyone else: SYSTEM/PUBLIC entries plus node ids in their Permify allowlist.
// allowedIds === null (Permify not configured, local dev) means tenant-wide, as for answers.

const STATIC_CATALOG_PATH = path.join(__dirname, '../config/entity_catalog.json');
const GLOBAL_TIERS = new Set(['SYSTEM', 'PUBLIC']);
const PERSON_ENTRY_DOMAIN = 'person';
const MIN_ROUTING_NAME_CHARS = 3;
// Short names (design §9) route only next to one of these words: "the BERT paper" → the BERT document.
const DOCUMENT_REFERENCE_WORDS = INTENT_KEYWORDS_CONFIG.documentReferenceWords || [];

function _loadStaticCatalog() {
    try {
        const raw = JSON.parse(fs.readFileSync(STATIC_CATALOG_PATH, 'utf-8'));
        console.log(`[CLASSIFY] Static entity catalog loaded (${raw.generated_at || 'unknown date'})`);
        return raw;
    } catch (e) {
        console.warn('[CLASSIFY] Entity catalog unavailable — Phases E/B skipped until a catalog is fetched:', e.message);
        return {};
    }
}

// Pre-S2-60 files have no `entries`: rebuild them from `domains`/`persons` (no ids, so visible to all —
// exactly the old behaviour).
function _catalogEntries(catalog) {
    if (Array.isArray(catalog.entries)) return catalog.entries;
    const entries = [];
    for (const [domain, names] of Object.entries(catalog.domains || {})) {
        for (const name of names) entries.push({ name, domain, tier: 'PUBLIC' });
    }
    for (const name of catalog.persons || []) entries.push({ name, domain: PERSON_ENTRY_DOMAIN, tier: 'PUBLIC' });
    return entries;
}

function _shortNamePattern(shortName) {
    if (!DOCUMENT_REFERENCE_WORDS.length) return null;
    const words = DOCUMENT_REFERENCE_WORDS.map(_escapeRegex).join('|');
    return new RegExp(`\\b${_escapeRegex(shortName)}(?:'s)?\\s+(?:${words})\\b`, 'i');
}

/**
 * Compile the routing lookups for one asker.
 * @param {object} catalog  entity catalog JSON (static file or Bento /entity_catalog)
 * @param {{isOwner?: boolean, allowedIds?: string[]|null}} [viewer]  omitted → every entry (static default)
 */
function buildRoutingLookups(catalog, viewer) {
    const allowed = viewer && !viewer.isOwner && Array.isArray(viewer.allowedIds) ? new Set(viewer.allowedIds) : null;
    const canOpen = e => !allowed || GLOBAL_TIERS.has(e.tier) || (e.node_id && allowed.has(e.node_id));
    const entity = new Map();   // lowerCaseName → domain
    const person = new Map();   // lowerCaseName → original-case name
    const short = [];           // [{ pattern, domain, matched }]
    let withheld = 0;
    for (const e of _catalogEntries(catalog || {})) {
        if (!e.name || e.name.length < MIN_ROUTING_NAME_CHARS) continue;
        if (!canOpen(e)) { withheld++; continue; }
        if (e.domain === PERSON_ENTRY_DOMAIN) {
            person.set(e.name.toLowerCase(), e.name);
            continue;
        }
        entity.set(e.name.toLowerCase(), e.domain);
        const pattern = e.short_name ? _shortNamePattern(e.short_name) : null;
        if (pattern) short.push({ pattern, domain: e.domain, matched: e.short_name.toLowerCase() });
    }
    const bridge = new Map();   // lowerCaseName → candidate domains (concept names, no per-node tier)
    for (const [name, domains] of Object.entries((catalog || {}).bridge_entities || {})) {
        if (name && name.length >= MIN_ROUTING_NAME_CHARS && Array.isArray(domains) && domains.length > 1) {
            bridge.set(name.toLowerCase(), domains);
        }
    }
    return { entity, person, short, bridge, withheld };
}

const STATIC_LOOKUPS = buildRoutingLookups(_loadStaticCatalog());

// "Does any key of this map appear in the question; if several, which is longest" (longest match wins,
// so a short name like "AI" can't beat a longer entity it sits inside).
function _longestMatchLookup(query, lookupMap) {
    if (!lookupMap || lookupMap.size === 0) return null;
    const lower = query.toLowerCase();
    let bestValue = null;
    let bestLen   = 0;
    let bestName  = null;
    for (const [name, value] of lookupMap) {
        if (name.length > bestLen && lower.includes(name)) {
            bestValue = value;
            bestLen   = name.length;
            bestName  = name;
        }
    }
    return bestValue !== null ? { value: bestValue, matched: bestName } : null;
}

// Document entries never route while the document flag is off.
function _routable(domain) {
    return domain !== DOCUMENT_DOMAIN || documentDomainEnabled();
}

function _entityClassify(q, lookups = STATIC_LOOKUPS) {
    const entity = documentDomainEnabled() ? lookups.entity
        : new Map([...lookups.entity].filter(([, domain]) => _routable(domain)));
    const match = _longestMatchLookup(q, entity);
    if (match) return { domain: match.value, matched: match.matched };
    for (const { pattern, domain, matched } of lookups.short) {
        if (_routable(domain) && pattern.test(q)) return { domain, matched, short: true };
    }
    return null;
}

function _bridgeClassify(q, lookups = STATIC_LOOKUPS) {
    const match = _longestMatchLookup(q, lookups.bridge);
    return match ? { domains: match.value, matched: match.matched } : null;
}

/**
 * Bridge-entity detail for a question already classified 'cross_domain' via Phase B (kept apart from
 * classifyDomain()'s return value; website-domain-cross-domain-routing-design-2026-08-24.md §2.3).
 * @returns {{bridge_entity: string, candidate_domains: string[]} | null}
 */
function getBridgeContext(question, lookups = STATIC_LOOKUPS) {
    const match = _bridgeClassify(question || '', lookups);
    if (!match) return null;
    return { bridge_entity: match.matched, candidate_domains: match.domains };
}

/**
 * Whether a question names a known person (career auto-inject, Tier 7 bridge source), independent of
 * domain classification. Returns the name in its catalog casing, or null.
 */
function classifyNamedPerson(question, lookups = STATIC_LOOKUPS) {
    const match = _longestMatchLookup(question || '', lookups.person);
    return match ? match.value : null;
}

// ─── Phase S: Embedding similarity ───────────────────────────────────────────
// Uses text-embedding-3-small — same model as Neo4j chunk embeddings.
// Prototype centroids are pre-computed once at gateway startup via initClassifier().
// Cost: ~$0.02 per 1M tokens ≈ $0.0000004 per typical query.

const EMBEDDING_MODEL               = 'text-embedding-3-small';
const EMBEDDING_COST_PER_TOKEN      = 0.02 / 1_000_000;
const EMBEDDING_CONFIDENCE_THRESHOLD = 0.75;

let _centroids        = null;   // Map<domainSignal, number[]>
let _embeddingsReady  = false;
let _embeddingInitErr = null;

function _cosineSimilarity(a, b) {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot  += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
}

function _computeCentroid(embeddings) {
    const dim      = embeddings[0].length;
    const centroid = new Array(dim).fill(0);
    for (const emb of embeddings) {
        for (let i = 0; i < dim; i++) centroid[i] += emb[i];
    }
    return centroid.map(v => v / embeddings.length);
}

/**
 * Pre-compute domain centroid embeddings from intent registry prototypes.
 * Call once at gateway startup — fires in the background, does not block request handling.
 * @param {import('openai').OpenAI} openaiClient
 */
async function initClassifier(openaiClient) {
    try {
        const registryPath = path.join(__dirname, '../config/intent_registry.json');
        const registry     = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));

        // Pool prototypes by domain_signal (multiple intents may share a domain)
        const domainPrototypes = {};
        for (const intent of registry.intents) {
            const ds = intent.domain_signal;
            if (!ds || !intent.prototypes?.length) continue;
            if (!domainPrototypes[ds]) domainPrototypes[ds] = [];
            domainPrototypes[ds].push(...intent.prototypes);
        }

        const allDomains    = Object.keys(domainPrototypes);
        const allPrototypes = allDomains.flatMap(ds => domainPrototypes[ds]);
        if (allPrototypes.length === 0) {
            console.warn('[CLASSIFY] No prototypes found in intent registry — Phase S skipped');
            return;
        }

        // Single batched API call for all prototypes
        const response = await openaiClient.embeddings.create({
            model: EMBEDDING_MODEL,
            input: allPrototypes
        });

        // Slice embeddings back per domain and compute centroid
        const centroids = new Map();
        let offset = 0;
        for (const ds of allDomains) {
            const count      = domainPrototypes[ds].length;
            const embeddings = response.data.slice(offset, offset + count).map(e => e.embedding);
            centroids.set(ds, _computeCentroid(embeddings));
            offset += count;
        }

        _centroids       = centroids;
        _embeddingsReady = true;

        const tokenEstimate = allPrototypes.reduce((s, p) => s + Math.ceil(p.split(/\s+/).length * 1.3), 0);
        const initCost      = (tokenEstimate * EMBEDDING_COST_PER_TOKEN).toFixed(8);
        console.log(`[CLASSIFY] Phase S ready: ${allDomains.length} domain centroids from ${allPrototypes.length} prototypes. Init cost: ~$${initCost}`);
    } catch (e) {
        _embeddingInitErr = e.message;
        console.warn('[CLASSIFY] Phase S init failed — embedding classification disabled:', e.message);
    }
}

async function _embeddingClassify(q, openaiClient) {
    const tokenEstimate = Math.ceil(q.split(/\s+/).length * 1.3);
    const costEstimate  = (tokenEstimate * EMBEDDING_COST_PER_TOKEN).toFixed(8);

    const response       = await openaiClient.embeddings.create({ model: EMBEDDING_MODEL, input: [q] });
    const queryEmbedding = response.data[0].embedding;

    let best = { domain: null, score: 0 };
    for (const [domain, centroid] of _centroids) {
        const score = _cosineSimilarity(queryEmbedding, centroid);
        if (score > best.score) best = { domain, score };
    }
    return { domain: best.domain, confidence: best.score, costEstimate };
}

// ─── Phase L: LLM fallback (disabled by default) ─────────────────────────────
// Enable with env var: ENABLE_LLM_CLASSIFICATION=true
// When disabled: logs the fact that threshold was missed and what it would have cost.
// Implementation stub — the actual LLM call goes here when enabled in a future sprint.

const LLM_ENABLED = process.env.ENABLE_LLM_CLASSIFICATION === 'true';

// ─── Safe default ─────────────────────────────────────────────────────────────

const SAFE_DEFAULT = 'career';

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Classify the user query into a domain signal.
 * Phases run cheapest-first; each phase only fires if the previous phase missed.
 *
 * @param {string} question
 * @param {import('openai').OpenAI} [openaiClient]  required for Phase S
 * @returns {Promise<{domain: 'podcast' | 'career' | 'website' | 'cross_domain', confident: boolean}>}
 *   confident=true for any genuine Phase B/R/E hit, or Phase S at/above threshold.
 *   confident=false only for the safe-default fallback (2026-09-18) — nothing actually
 *   matched, `domain` is just AP-21's safe default, not a real classification. Callers that
 *   only need the domain string (graph-rendering domain guard, etc.) can keep using
 *   `.domain`; the LLM's tool-calling instruction is the one consumer that needs to tell
 *   these apart — see resolveDomainInstruction() in index.js and
 *   documents/architecture/universal-discovery-fallback-design-2026-09-18.md.
 */
async function classifyDomain(question, openaiClient, lookups = STATIC_LOOKUPS) {
    const q = question || '';

    // Phase B: Bridge entity — free, <1ms. Runs BEFORE Phase R's short-circuit (added
    // 2026-08-24) — see the module doc comment at the top of this file. Root-caused a
    // real failure this fix addresses: "What does the Apache Iceberg Wikipedia page
    // discuss?" matched Phase R's podcast regex (the word "discuss") before Phase E's
    // entity lookup ever ran, so a genuine website<->podcast bridge was missed entirely.
    const bridgeMatch = _bridgeClassify(q, lookups);
    if (bridgeMatch) {
        console.log(`[CLASSIFY] phase=B(bridge) domain=cross_domain matched="${bridgeMatch.matched}" candidate_domains=${bridgeMatch.domains}`);
        return { domain: 'cross_domain', confident: true };
    }

    // Phase R: Regex — free, <1ms
    const rx = _regexClassify(q);
    if (rx) {
        if (rx.deferTo.length) {
            const entity = _entityClassify(q, lookups);
            if (entity && rx.deferTo.includes(entity.domain)) {
                console.log(`[CLASSIFY] phase=R(regex) ambiguous=${rx.domain_signal} deferred to phase=E domain=${entity.domain} matched="${entity.matched}"`);
                return { domain: entity.domain, confident: true };
            }
        }
        console.log(`[CLASSIFY] phase=R(regex) domain=${rx.domain_signal}`);
        return { domain: rx.domain_signal, confident: true };
    }

    // Phase E: Entity catalog — free, <1ms
    const entityMatch = _entityClassify(q, lookups);
    if (entityMatch) {
        console.log(`[CLASSIFY] phase=E(entity) domain=${entityMatch.domain} matched="${entityMatch.matched}"${entityMatch.short ? ' (short name)' : ''}`);
        return { domain: entityMatch.domain, confident: true };
    }

    // Phase S: Embedding similarity — paid, ~50ms
    if (openaiClient && _embeddingsReady) {
        console.log(`[CLASSIFY] phase=R miss, phase=E miss → phase=S(embedding) model=${EMBEDDING_MODEL}`);
        try {
            const result = await _embeddingClassify(q, openaiClient);
            if (result.confidence >= EMBEDDING_CONFIDENCE_THRESHOLD) {
                console.log(`[CLASSIFY] phase=S(embedding) domain=${result.domain} confidence=${result.confidence.toFixed(3)} cost=~$${result.costEstimate}`);
                return { domain: result.domain, confident: true };
            }
            // Embedding confidence too low — log Phase L status
            const conf = result.confidence.toFixed(3);
            if (LLM_ENABLED) {
                console.log(`[CLASSIFY] phase=S confidence=${conf} below ${EMBEDDING_CONFIDENCE_THRESHOLD} → phase=L(LLM) est_cost=~$0.001`);
                // Phase L implementation goes here when enabled
                // For now falls through to safe default
            } else {
                console.log(`[CLASSIFY] phase=S confidence=${conf} below ${EMBEDDING_CONFIDENCE_THRESHOLD}. phase=L(LLM) DISABLED (ENABLE_LLM_CLASSIFICATION=true to activate). safe_default=${SAFE_DEFAULT}`);
            }
        } catch (e) {
            console.warn('[CLASSIFY] phase=S failed:', e.message, '→ safe_default');
        }
    } else if (!_embeddingsReady && openaiClient) {
        if (_embeddingInitErr) {
            console.log(`[CLASSIFY] phase=R miss, phase=E miss. phase=S unavailable (init error: ${_embeddingInitErr}) → safe_default`);
        } else {
            console.log(`[CLASSIFY] phase=R miss, phase=E miss. phase=S still initializing → safe_default`);
        }
    }

    // Safe default — AP-21: never return 'unknown'. confident=false: no phase actually
    // matched, so the LLM's tool-calling instruction should treat this as universal
    // discovery (domain_intent="all"), not a real career-domain classification.
    console.log(`[CLASSIFY] safe_default=${SAFE_DEFAULT} applied`);
    return { domain: SAFE_DEFAULT, confident: false };
}

// ─── Module init ──────────────────────────────────────────────────────────────

module.exports = { classifyDomain, initClassifier, INTENT_PATTERNS, getBridgeContext, classifyNamedPerson,
                   buildRoutingLookups };
