'use strict';

/**
 * Multi-phase intent classifier for Cortex-Drive gateway.
 *
 * Execution order — cheapest phase runs first, paid phases only fire on miss:
 *
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
// routes to cross_domain, not career.

const INTENT_PATTERNS = [
    {
        domain_signal: 'podcast',
        pattern: /\bepisode|podcast|guest|interview|transcript|talks?\s+about|discuss/i
    },
    {
        domain_signal: 'cross_domain',
        pattern: /influenc|how\s+did.*affect|how\s+did.*shape|bridge|connects?\s+.*to|relation.*between|impact.*on.*design|decision\s+trace|trace.*from|from.*to.*(?:architecture|security|design|system|platform)|led\s+to|drove.*(?:architecture|design|security)|shaped.*(?:architecture|design|security)/i
    },
    {
        domain_signal: 'career',
        // Covers core career vocabulary + thought leadership (publish/write/author/infoq/conference/blog)
        // + project/startup/hackathon vocabulary + person-centric action queries.
        pattern: /career|resume|background|experience|worked\s+at|compan(y|ies)|my\s+role|education|certification|professional|publish|wrote|written|article|infoq|conference|hackathon|startup|project|thought\s+leader|blog|speaking\s+at|presentation|authored|what.*\bdid.*\bdo\b|what.*\bhas.*\bbuilt\b|founded|built\b|created\b/i
    }
];

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

function _entityClassify(q) {
    if (!_entityLookup || _entityLookup.size === 0) return null;
    const lower = q.toLowerCase();
    // Longest-match wins to avoid false positives on short names
    let bestDomain = null;
    let bestLen    = 0;
    let bestName   = null;
    for (const [name, domain] of _entityLookup) {
        if (name.length > bestLen && lower.includes(name)) {
            bestDomain = domain;
            bestLen    = name.length;
            bestName   = name;
        }
    }
    return bestDomain ? { domain: bestDomain, matched: bestName } : null;
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
 * @returns {Promise<'podcast' | 'career' | 'cross_domain'>}
 */
async function classifyDomain(question, openaiClient) {
    const q = question || '';

    // Phase R: Regex — free, <1ms
    const rxDomain = _regexClassify(q);
    if (rxDomain) {
        console.log(`[CLASSIFY] phase=R(regex) domain=${rxDomain}`);
        return rxDomain;
    }

    // Phase E: Entity catalog — free, <1ms
    const entityMatch = _entityClassify(q);
    if (entityMatch) {
        console.log(`[CLASSIFY] phase=E(entity) domain=${entityMatch.domain} matched="${entityMatch.matched}"`);
        return entityMatch.domain;
    }

    // Phase S: Embedding similarity — paid, ~50ms
    if (openaiClient && _embeddingsReady) {
        console.log(`[CLASSIFY] phase=R miss, phase=E miss → phase=S(embedding) model=${EMBEDDING_MODEL}`);
        try {
            const result = await _embeddingClassify(q, openaiClient);
            if (result.confidence >= EMBEDDING_CONFIDENCE_THRESHOLD) {
                console.log(`[CLASSIFY] phase=S(embedding) domain=${result.domain} confidence=${result.confidence.toFixed(3)} cost=~$${result.costEstimate}`);
                return result.domain;
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

    // Safe default — AP-21: never return 'unknown'
    console.log(`[CLASSIFY] safe_default=${SAFE_DEFAULT} applied`);
    return SAFE_DEFAULT;
}

// ─── Module init ──────────────────────────────────────────────────────────────

_entityLookup = _loadEntityCatalog();

module.exports = { classifyDomain, initClassifier, INTENT_PATTERNS };
