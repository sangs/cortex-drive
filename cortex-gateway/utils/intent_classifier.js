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

// Allowlist for a genuinely unambiguous single-word `keywords` entry, should one ever be
// needed — empty today; every current entry is a multi-word phrase (see _buildIntentPatterns).
const SINGLE_WORD_KEYWORD_ALLOWLIST = new Set();

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
    return config.domains.map(({ domain_signal, patternSource, keywords }) => {
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
            return { domain_signal, pattern: new RegExp(parts.join('|'), 'i') };
        } catch (e) {
            console.error(`[CLASSIFY] intent_keywords.js: malformed pattern for domain=${domain_signal}, this domain's Phase R entry is disabled:`, e.message);
            return null;
        }
    }).filter(Boolean);
}

const INTENT_PATTERNS = _buildIntentPatterns(INTENT_KEYWORDS_CONFIG);

function _regexClassify(q) {
    for (const { domain_signal, pattern } of INTENT_PATTERNS) {
        if (pattern.test(q)) return domain_signal;
    }
    return null;
}

// ─── Phase E: Entity catalog lookup ──────────────────────────────────────────
// Populated at deploy time by scripts/generate_entity_catalog.py.
// Loaded once at module init — zero per-query overhead.

let _entityLookup = null;  // Map<lowerCaseName, domainSignal>

function _loadEntityCatalog() {
    try {
        const catalogPath = path.join(__dirname, '../config/entity_catalog.json');
        const raw = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
        const lookup = new Map();
        for (const [domain, names] of Object.entries(raw.domains || {})) {
            for (const name of names) {
                if (name && name.length > 2) lookup.set(name.toLowerCase(), domain);
            }
        }
        if (lookup.size > 0) {
            console.log(`[CLASSIFY] Entity catalog loaded: ${lookup.size} entities (${raw.generated_at || 'unknown date'})`);
        } else {
            console.log('[CLASSIFY] Entity catalog is empty — Phase E will pass through. Run scripts/generate_entity_catalog.py.');
        }
        return lookup;
    } catch (e) {
        console.warn('[CLASSIFY] Entity catalog unavailable — Phase E skipped:', e.message);
        return new Map();
    }
}

// Shared by _entityClassify and _bridgeClassify below — both need "does any key in this
// lookup map appear as a substring of the question, and if multiple do, which one is
// longest" (longest-match wins to avoid false positives on short names, e.g. "AI" matching
// inside an unrelated longer entity name). Extracted 2026-08-29 — the two call sites had
// duplicated this loop almost verbatim, differing only in what value each map stores.
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

function _entityClassify(q) {
    const match = _longestMatchLookup(q, _entityLookup);
    return match ? { domain: match.value, matched: match.matched } : null;
}

// ─── Phase B: Bridge-entity lookup (added 2026-08-24) ────────────────────────
// Separate from _entityLookup above by design — a distinct, deliberately narrow
// structure (only entities empirically verified to connect 2+ domains, see
// generate_entity_catalog.py's bridge_entities section), not a change to the existing
// single-domain lookup's behavior or contract. See
// website-domain-cross-domain-routing-design-2026-08-24.md §2.2/§2.3.

let _bridgeEntityLookup = null;  // Map<lowerCaseName, string[]> (candidate domains)

function _loadBridgeEntities() {
    try {
        const catalogPath = path.join(__dirname, '../config/entity_catalog.json');
        const raw = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
        const lookup = new Map();
        for (const [name, domains] of Object.entries(raw.bridge_entities || {})) {
            if (name && name.length > 2 && Array.isArray(domains) && domains.length > 1) {
                lookup.set(name.toLowerCase(), domains);
            }
        }
        if (lookup.size > 0) {
            console.log(`[CLASSIFY] Bridge entity catalog loaded: ${lookup.size} entities`);
        }
        return lookup;
    } catch (e) {
        console.warn('[CLASSIFY] Bridge entity catalog unavailable — Phase B skipped:', e.message);
        return new Map();
    }
}

function _bridgeClassify(q) {
    const match = _longestMatchLookup(q, _bridgeEntityLookup);
    return match ? { domains: match.value, matched: match.matched } : null;
}

/**
 * Resolve bridge-entity detail for a question already classified as 'cross_domain' via
 * Phase B. Kept separate from classifyDomain()'s return value so its existing
 * plain-string contract (one call site: cortex-gateway/index.js) is untouched — callers
 * that need the bridge detail call this explicitly.
 *
 * @param {string} question
 * @returns {{bridge_entity: string, candidate_domains: string[]} | null}
 */
function getBridgeContext(question) {
    const match = _bridgeClassify(question || '');
    if (!match) return null;
    return { bridge_entity: match.matched, candidate_domains: match.domains };
}

// ─── Named-person lookup (added 2026-09-14) ──────────────────────────────────
// Separate from _entityLookup by design, same reasoning as _bridgeEntityLookup above —
// Person is a shared/SYSTEM label excluded from domains.* (see generate_entity_catalog.py),
// but "does this question name a specific person" is a distinct, real need: both the
// career-backbone auto-inject and Tier 7 bridge-source resolution must prefer an
// explicitly-named person over a tenant-default fallback. See
// documents/architecture/auth-derived-identity-and-bridge-source-config-design-2026-09-12.md
// §3.3/§4.2 — reuses the existing catalog + longest-match-lookup pattern rather than a new
// mechanism.

let _personLookup = null;  // Map<lowerCaseName, originalCaseName>

function _loadPersonCatalog() {
    try {
        const catalogPath = path.join(__dirname, '../config/entity_catalog.json');
        const raw = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
        const lookup = new Map();
        for (const name of raw.persons || []) {
            if (name && name.length > 2) lookup.set(name.toLowerCase(), name);
        }
        if (lookup.size > 0) {
            console.log(`[CLASSIFY] Person catalog loaded: ${lookup.size} names`);
        }
        return lookup;
    } catch (e) {
        console.warn('[CLASSIFY] Person catalog unavailable — named-person lookup skipped:', e.message);
        return new Map();
    }
}

/**
 * Resolve whether a question explicitly names a known person, independent of domain
 * classification. Returns the person's name in its original catalog casing (the exact
 * form Neo4j stores it as), suitable for passing straight through as a node_name argument.
 *
 * @param {string} question
 * @returns {string | null}
 */
function classifyNamedPerson(question) {
    const match = _longestMatchLookup(question || '', _personLookup);
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
async function classifyDomain(question, openaiClient) {
    const q = question || '';

    // Phase B: Bridge entity — free, <1ms. Runs BEFORE Phase R's short-circuit (added
    // 2026-08-24) — see the module doc comment at the top of this file. Root-caused a
    // real failure this fix addresses: "What does the Apache Iceberg Wikipedia page
    // discuss?" matched Phase R's podcast regex (the word "discuss") before Phase E's
    // entity lookup ever ran, so a genuine website<->podcast bridge was missed entirely.
    const bridgeMatch = _bridgeClassify(q);
    if (bridgeMatch) {
        console.log(`[CLASSIFY] phase=B(bridge) domain=cross_domain matched="${bridgeMatch.matched}" candidate_domains=${bridgeMatch.domains}`);
        return { domain: 'cross_domain', confident: true };
    }

    // Phase R: Regex — free, <1ms
    const rxDomain = _regexClassify(q);
    if (rxDomain) {
        console.log(`[CLASSIFY] phase=R(regex) domain=${rxDomain}`);
        return { domain: rxDomain, confident: true };
    }

    // Phase E: Entity catalog — free, <1ms
    const entityMatch = _entityClassify(q);
    if (entityMatch) {
        console.log(`[CLASSIFY] phase=E(entity) domain=${entityMatch.domain} matched="${entityMatch.matched}"`);
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

_entityLookup = _loadEntityCatalog();
_bridgeEntityLookup = _loadBridgeEntities();
_personLookup = _loadPersonCatalog();

module.exports = { classifyDomain, initClassifier, INTENT_PATTERNS, getBridgeContext, classifyNamedPerson };
