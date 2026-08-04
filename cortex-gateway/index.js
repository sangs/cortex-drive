const express = require('express');
const fs = require('fs');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { classifyDomain, initClassifier } = require('./utils/intent_classifier');

// Inclusion-based domain manifests (AP-3: single source of truth in config/domain_manifests.json).
const _domainManifestsRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'domain_manifests.json'), 'utf-8'));
const DOMAIN_ALLOWED_TYPES = {
    podcast: new Set(_domainManifestsRaw.podcast.node_types),
    career: new Set(_domainManifestsRaw.career.node_types),
};

// Tools that return large graph payloads — LLM only needs a compact summary.
// Full graph data is already accumulated in accumulatedGraph before truncation.
const GRAPH_HEAVY_TOOLS = new Set(['search_enterprise_graph', 'get_cluster_context', 'connect_knowledge_on_demand']);

// Relationship types included in the composition subtree BFS snapshot.
// Stored in share_grants.composition_rels for audit. Must match Bento server behavior.
const COMPOSITION_RELS = ['HAS_EPISODE', 'HAS_SOURCE', 'CONTAINS', 'HAS_REFERENCE', 'HAS_PRIVATE_NOTE'];
// Max chars sent to LLM for knowledge/text tools (chunks, resume narratives).
const MAX_KNOWLEDGE_CONTENT_CHARS = 8000;

function buildLlmToolContent(toolName, toolContent) {
    if (GRAPH_HEAVY_TOOLS.has(toolName)) {
        try {
            const parsed = JSON.parse(toolContent);
            const nodes = parsed.nodes || [];
            // Deduplicate by name+type: prefer nodes with descriptions over SYSTEM-tenant duplicates.
            const seenKeys = new Map();
            nodes.forEach(n => {
                const key = `${n.name}::${n.type}`;
                if (!seenKeys.has(key) || (!seenKeys.get(key).description && n.description)) seenKeys.set(key, n);
            });
            const uniqueNodes = Array.from(seenKeys.values());
            // Sort by temporal_boost DESC (Cypher-computed field; preserves the ordering already
            // established by the query — re-sorting by isPresent/endYear scrambles it).
            uniqueNodes.sort((a, b) => (b.temporal_boost || 0) - (a.temporal_boost || 0));
            const extra = uniqueNodes.length > 20 ? ` … and ${uniqueNodes.length - 20} more` : '';
            const vl = parsed.virtual_links ? ` ${parsed.virtual_links.length} virtual bridge(s).` : '';
            const bs = parsed.bridge_summary ? ` ${parsed.bridge_summary}` : '';

            // For search_enterprise_graph: emit explicit numbered rank list so LLM cannot reorganize.
            if (toolName === 'search_enterprise_graph') {
                const rankedList = uniqueNodes.slice(0, 20).map((n, i) => {
                    const linkStr = Array.isArray(n.links) && n.links.length > 0
                        ? ` [Links: ${n.links.slice(0, 2).map((url, idx) => {
                            const title = Array.isArray(n.link_titles) && n.link_titles[idx] ? n.link_titles[idx] : null;
                            return title ? `${title} (${url})` : url;
                          }).join(', ')}]`
                        : (n.url ? ` [Link: ${n.url}]` : '');
                    const statusStr = n.isPresent ? ' [PRESENT — CURRENT WORK]' : (n.displayDate ? ` [${n.displayDate}]` : '');
                    const desc = n.description && n.description.length > 5 ? `: ${n.description.slice(0, 150)}` : '';
                    return `#${i + 1}${statusStr} ${n.name} (${n.type})${desc}${linkStr}`;
                }).join('\n');
                return `RANKED RESULT — CHAT MUST FOLLOW THIS ORDER EXACTLY (item #1 is always first in your response):\n${rankedList}${extra}\n${vl}${bs}Full graph data accumulated for visualization.`;
            }

            const nodeList = uniqueNodes.slice(0, 20).map(n => `${n.name} (${n.type})`).join('; ');
            const snapNodes = uniqueNodes.filter(n => n.description && n.description.length > 5).slice(0, 8);
            const snapText = snapNodes.length > 0
                ? '\nNode context: ' + snapNodes.map(n => {
                    const linkStr = Array.isArray(n.links) && n.links.length > 0
                        ? ` [Links: ${n.links.slice(0, 2).map((url, i) => {
                            const title = Array.isArray(n.link_titles) && n.link_titles[i] ? n.link_titles[i] : null;
                            return title ? `${title} (${url})` : url;
                          }).join(', ')}]`
                        : (n.url ? ` [Link: ${n.url}]` : '');
                    const roleStr = n.role ? ` — ${n.role}` : '';
                    const statusStr = n.isPresent ? ' [Currently Active]' : (n.displayDate && n.displayDate !== 'Active' ? ` [${n.displayDate}]` : '');
                    return `${n.name}${roleStr}${statusStr}: ${n.description.slice(0, 100)}${linkStr}`;
                }).join(' | ')
                : '';
            return `Graph tool returned ${nodes.length} node(s): ${nodeList}${extra}.${vl}${bs}${snapText} Full graph data accumulated for visualization.`;
        } catch (e) {
            return toolContent.slice(0, 500) + (toolContent.length > 500 ? ' [truncated]' : '');
        }
    }
    if (toolContent.length > MAX_KNOWLEDGE_CONTENT_CHARS) {
        return toolContent.slice(0, MAX_KNOWLEDGE_CONTENT_CHARS) + `\n[Truncated — ${toolContent.length} chars total]`;
    }
    return toolContent;
}

/**
 * Build the set of URLs that appeared in tool results for this turn.
 * Used by auditResponseUrls to strip hallucinated links before sending to the UI.
 */
function extractToolUrls(parsed) {
    const urls = new Set();
    if (!parsed || typeof parsed !== 'object') return urls;
    const nodes = parsed.nodes || [];
    nodes.forEach(n => {
        if (n.url) urls.add(n.url);
        if (n.link) urls.add(n.link);
        if (Array.isArray(n.links)) n.links.forEach(u => u && urls.add(u));
    });
    const refUrls = parsed.ref_urls || parsed.reference_links || [];
    if (Array.isArray(refUrls)) refUrls.forEach(u => u && urls.add(u));
    return urls;
}

/**
 * Strip any URLs in the LLM response that were not present in tool results.
 * - Markdown links [text](url): removes the link wrapper, keeps the display text.
 * - Bare URLs: replaces with [source not in graph].
 * This is the gateway-side grounding enforcement layer — deterministic, cannot be
 * overridden by prompt injection.
 */
function auditResponseUrls(content, seenUrls) {
    if (!content || seenUrls.size === 0) return content;
    // Normalize: strip trailing slash so url and url/ match the same entry.
    const normalize = (u) => u.replace(/[.,;:!?]+$/, '').replace(/\/$/, '');
    const normalizedSeen = new Set([...seenUrls].map(normalize));
    // Strip markdown links whose URL wasn't in tool results — keep display text.
    let audited = content.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (match, text, url) => {
        if (normalizedSeen.has(normalize(url))) return match;
        console.warn(`[GROUNDING] Removing hallucinated link: ${normalize(url)}`);
        return text;
    });
    // Replace bare URLs not from tool results.
    audited = audited.replace(/https?:\/\/[^\s)\]"'<]+/g, (url) => {
        if (normalizedSeen.has(normalize(url))) return url;
        console.warn(`[GROUNDING] Replacing hallucinated bare URL: ${normalize(url)}`);
        return '[source not in graph]';
    });
    return audited;
}

// Node types eligible to appear in a Q2 (career map) chat response.
// Excludes structural nodes (Category, Person, Year, Technology, Skill) and
// granular project-breakdown types that add noise rather than career narrative.
const CAREER_CHAT_NODE_TYPES = new Set([
    'Project', 'Role', 'Company', 'Startup', 'Hackathon',
    'ThoughtLeadership', 'Certification', 'Degree',
    'Institution', 'ProfessionalEducation', 'Publication'
]);

// Types that receive writer prose (focused single-item narrative exists).
// Startup is included because Cortex-Drive resolves to type 'Startup' (Startup:Project → 'Startup').
function isWriterEligible(n) {
    if (['Project', 'Startup', 'ThoughtLeadership', 'Publication'].includes(n.type)) return true;
    return false;
}

// Timeline string for a node.
function nodeTimeline(n) {
    return n.displayDate ||
        (n.startYear && n.endYear ? `${n.startYear}–${n.endYear}` :
         n.startYear ? n.startYear : n.endYear ? n.endYear : '');
}

// All URL links for a node — returns only http/https items to avoid article titles
// stored as link entries in Neo4j appearing as duplicate text lines.
function nodeLinks(n) {
    const isUrl = l => l && (l.startsWith('http://') || l.startsWith('https://'));
    const allLinks = Array.isArray(n.links) && n.links.length > 0 ? n.links : (n.url ? [n.url] : []);
    return allLinks.filter(isUrl);
}

// Splits contentNodes into the Q2 display sections.
// Cortex-Drive resolves to type 'Startup' (Startup:Project → 'Startup' in type CASE).
// isCurrentProject covers both pure Project nodes and Startup nodes that are active ventures.
function groupNodesForQ2(contentNodes) {
    const isCurrentProject = n =>
        (n.type === 'Project' || n.type === 'Startup') &&
        (n.isPresent === true || n.isPresent === 'true' || n.endDate === 'Present' || n.endYear === 'Present' || n.displayDate?.includes('Present'));

    // currentlyBuilding: active ventures/projects — shown at the top of Career Timeline
    const currentlyBuilding = contentNodes.filter(isCurrentProject);
    const currentNames = new Set(currentlyBuilding.map(n => n.name));

    // companies: past employers — shown below currently-building entries in Career Timeline
    const companies = contentNodes.filter(n => n.type === 'Company' && !currentNames.has(n.name));

    // projects: all Project nodes + currently-building Startup nodes (for description in What She Built)
    const projects = contentNodes.filter(n =>
        n.type === 'Project' ||
        (n.type === 'Startup' && (n.isPresent === true || n.isPresent === 'true' || n.endDate === 'Present' || n.endYear === 'Present'))
    );

    const thoughtLeadership = contentNodes.filter(n => n.type === 'ThoughtLeadership' || n.type === 'Publication');
    const hackathons   = contentNodes.filter(n => n.type === 'Hackathon');
    const education    = contentNodes.filter(n => ['Degree', 'Certification', 'ProfessionalEducation', 'Institution'].includes(n.type));

    return { currentlyBuilding, companies, projects, thoughtLeadership, hackathons, education };
}

/**
 * Strips STAR-framework and preparatory-note markup from narrative text so the
 * Q2 response reads as seamless professional experience (per system prompt PRIVACY rule).
 */
function sanitizeNarrative(text) {
    if (!text) return '';
    return text
        .replace(/^(Situation|Task|Action|Result|Preparatory Note|STAR Framework)[:\s]*/gim, '')
        .replace(/\n---\n/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Option B — section-based Q2 career map (no writer calls, uses node description only).
 * Used as fallback when Option A writer calls fail, and as the static buildLlmToolContent
 * ranked summary sent to the LLM. Sections: Career Timeline / What She Built /
 * Thought Leadership / Hackathons / Education.
 * Currently-building ventures appear at the top of Career Timeline (not a separate section).
 */
function buildCareerMapResponse(rankedNodes) {
    const contentNodes = rankedNodes.filter(n => CAREER_CHAT_NODE_TYPES.has(n.type));
    if (contentNodes.length === 0) return null;

    const { currentlyBuilding, companies, projects, thoughtLeadership, hackathons, education } = groupNodesForQ2(contentNodes);
    const lines = ['## Institutional Memory Map'];

    // Career Timeline: active ventures at top, then past employers chronologically.
    if (currentlyBuilding.length > 0 || companies.length > 0) {
        lines.push('', '---', '', '### Career Timeline');
        currentlyBuilding.forEach(n => {
            const tl = nodeTimeline(n);
            const role = n.role ? ` · ${n.role}` : '';
            lines.push(`#### ${n.name}${role}${tl ? ` [${tl}]` : ''}`);
            lines.push('');
        });
        companies.forEach(n => {
            const tl = nodeTimeline(n);
            const role = n.role ? ` · ${n.role}` : '';
            lines.push(`#### ${n.name}${role}${tl ? ` [${tl}]` : ''}`);
            lines.push('');
        });
    }

    if (projects.length > 0) {
        lines.push('', '---', '', '### What She Built');
        projects.forEach((n, i) => {
            const tl = nodeTimeline(n);
            lines.push(`#### ${n.name}${tl ? ` [${tl}]` : ''}`);
            if (i < 3 && n.description?.length > 10) { lines.push(''); lines.push(n.description); }
            nodeLinks(n).forEach(url => lines.push(`- ${url}`));
            lines.push('');
        });
    }

    if (thoughtLeadership.length > 0) {
        lines.push('', '---', '', '### Thought Leadership & Publications');
        thoughtLeadership.forEach(n => {
            const tl = nodeTimeline(n);
            lines.push(`#### ${n.name}${tl ? ` [${tl}]` : ''}`);
            if (n.description?.length > 10) { lines.push(''); lines.push(n.description); }
            nodeLinks(n).forEach(url => lines.push(`- ${url}`));
            lines.push('');
        });
    }

    if (hackathons.length > 0) {
        lines.push('', '---', '', '### Hackathons & Contributions');
        hackathons.forEach(n => {
            const tl = nodeTimeline(n);
            lines.push(`- **${n.name}**${tl ? ` [${tl}]` : ''}`);
        });
    }

    if (education.length > 0) {
        lines.push('', '---', '', '### Education & Certifications');
        education.forEach(n => {
            const yr = n.year || n.endYear || n.startYear || '';
            lines.push(`- ${yr ? `[${yr}] ` : ''}**${n.name}**`);
        });
    }

    return lines.join('\n');
}

/**
 * Option A — focused single-task GPT-4o writer call for one Q2 career item.
 * The writer sees only the node's name, timeline, and sanitized narrative — no
 * career map structure, so the organizational prior cannot corrupt the output.
 * Returns synthesized prose (3–4 sentences) or null on failure.
 */
async function buildQ2WriterCall(node, openaiClient) {
    const narrative = sanitizeNarrative(node.text) || (node.description && node.description.length > 20 ? node.description : '');
    if (!narrative) return null;

    const timelineStr = node.displayDate ||
        (node.startYear && node.endYear ? `${node.startYear}–${node.endYear}` :
         node.startYear || node.endYear || '');

    const response = await openaiClient.chat.completions.create({
        model: "gpt-4o",
        messages: [
            {
                role: "system",
                content: "You are a professional biographer writing for a career portfolio. Write 3–4 concise sentences describing this work item using ONLY the narrative provided. Do not add any information not present in the narrative. Do not generate URLs. Present as seamless professional experience — no STAR headers, no framework labels. Plain prose only, no markdown."
            },
            {
                role: "user",
                content: `Work item: ${node.name}\nType: ${node.type}\nTimeline: ${timelineStr}\n\nNarrative:\n${narrative.slice(0, 1500)}`
            }
        ],
        max_tokens: 200,
        temperature: 0.3
    });
    return response.choices[0].message.content?.trim() || null;
}

/**
 * Fetches PreparatoryNote narratives from the bento server for a given node.
 * Returns the joined narrative string, or '' if the bento server is unavailable.
 * Used to enrich top-2 Q2 nodes before writer calls, since search_enterprise_graph
 * only surfaces Note nodes (HAS_NOTE), not PreparatoryNote (HAS_PRIVATE_NOTE).
 */
async function fetchNodeNarratives(node, tenantId, userId, guestShareAnchor = '') {
    const bentoBase = process.env.BENTO_SERVER_URL || 'http://localhost:8000';
    try {
        const bentoOidcToken = await getCloudRunToken(bentoBase);
        const res = await fetch(`${bentoBase}/get_node_details`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-tenant-id': tenantId,
                'x-user-id': userId || '',
                ...(guestShareAnchor ? { 'x-guest-share-anchor': guestShareAnchor } : {}),
                ...(bentoOidcToken ? { Authorization: bentoOidcToken } : {}),
            },
            body: JSON.stringify({ node_name: node.name }),
            signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) return '';
        const raw = await res.json();
        // get_node_details returns [record] (list); unwrap to the first element.
        const record = Array.isArray(raw) ? raw[0] : raw;
        if (!record || record.error) return '';
        const joined = Array.isArray(record.narratives) && record.narratives.length > 0
            ? record.narratives.join('\n---\n')
            : (record.properties?.text || '');
        return sanitizeNarrative(joined);
    } catch (e) {
        console.warn(`[Q2] fetchNodeNarratives failed for "${node.name}":`, e.message);
        return '';
    }
}

// Load externalized prompts into memory on startup
const promptsDir = path.join(__dirname, '..', 'prompts');
const gatewaySystemPrompt = fs.readFileSync(path.join(promptsDir, 'gateway_system_assistant.md'), 'utf-8');
const gatewaySecurityPrompt = fs.readFileSync(path.join(promptsDir, 'gateway_security_guest.md'), 'utf-8');
const gatewayRerankerPrompt = fs.readFileSync(path.join(promptsDir, 'gateway_search_reranker.md'), 'utf-8');
const { createClerkClient, verifyToken } = require('@clerk/backend');
const { Webhook: SvixWebhook } = require('svix');
const cors = require('cors');
const OpenAI = require('openai');
const NodeCache = require('node-cache');
require('dotenv').config();

// Initialize Semantic Cache (24h default TTL, check every 1h)
const semanticCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

// Log prefix for all permission cache operations (Redis hit/miss/error)
const LOG_PERM_CACHE = '[PERM-CACHE]';

// Redis client for permission resolution cache (Phase 2 + Phase 4)
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
});
redis.on('error', (err) => console.warn('[REDIS] connection error (non-fatal):', err.message));

// Ensure fetch is available globally (for orchestration)
if (!global.fetch) {
    global.fetch = require('node-fetch');
}

// --- Permify + Cloud SQL clients ---
const permify = require('./utils/permify_gateway');
const db      = require('./utils/db');

// --- OpenFGA Authorization Client ---
const { OpenFgaClient, CredentialsMethod } = require('@openfga/sdk');

// getFgaClient creates a fresh OpenFGA client per call (no singleton) so that
// the OIDC bearer token — which expires after 1hr — is always current.
// bearerToken is a "Bearer <token>" string from getCloudRunToken(); omit for local dev.
function getFgaClient(bearerToken = null) {
    const storeId = process.env.OPENFGA_STORE_ID;
    if (!storeId) return null; // OpenFGA not configured — legacy mode
    const config = {
        apiUrl: process.env.OPENFGA_API_URL || 'http://localhost:8082',
        storeId,
        authorizationModelId: process.env.OPENFGA_MODEL_ID,
    };
    if (bearerToken) {
        config.credentials = {
            method: CredentialsMethod.ApiToken,
            config: { token: bearerToken.replace('Bearer ', '') },
        };
    }
    return new OpenFgaClient(config);
}

/**
 * Returns the list of node_id UUIDs the user can see via Permify LookupEntity.
 * Returns null when Permify is not configured (triggers legacy tenant_id mode in MCP).
 * agentSessionId parameter is reserved for future agent-scoped queries; current
 * call sites always pass only userId.
 */
async function getAllowedNodeIds(userId, agentSessionId = null) {
    if (!permify.configured()) return null; // legacy mode — no PERMIFY_API_URL set
    try {
        const ids = await permify.listViewableNodeIds(userId);
        console.log(`[PERMIFY] user:${userId} can_view ${ids.length} nodes`);
        return ids;
    } catch (err) {
        console.warn('[PERMIFY] listViewableNodeIds failed (non-fatal):', err.message);
        return null; // fall back to legacy mode on Permify errors
    }
}

/**
 * Resolve allowed_ids for a user — Redis cache first, Permify fallback on miss.
 * Writes result to Redis with 300s TTL. Also reads the per-tenant generation counter
 * so callers can detect stale permission sets mid-request.
 * Returns { allowedIds, permVersion } — both null-safe.
 */
async function resolveAndCachePermissions(userId, tenantId) {
    const permKey = `perm:${userId}`;
    const versionKey = `perm_version:${tenantId}`;
    try {
        const [cached, version] = await redis.mget(permKey, versionKey);
        if (cached !== null) {
            console.log(`${LOG_PERM_CACHE} hit user=${userId} version=${version || '0'}`);
            return { allowedIds: JSON.parse(cached), permVersion: version || '0' };
        }
    } catch (redisErr) {
        console.warn(`${LOG_PERM_CACHE} Redis read failed, falling back to Permify:`, redisErr.message);
    }

    // Cache miss — resolve from Permify
    const allowedIds = await getAllowedNodeIds(userId);
    const permVersion = await redis.get(versionKey).catch(() => '0') || '0';

    if (allowedIds !== null) {
        try {
            await redis.setex(permKey, 300, JSON.stringify(allowedIds));
            console.log(`${LOG_PERM_CACHE} miss — resolved ${allowedIds.length} ids for user=${userId}, cached 300s`);
        } catch (redisErr) {
            console.warn(`${LOG_PERM_CACHE} Redis write failed (non-fatal):`, redisErr.message);
        }
    }
    return { allowedIds, permVersion };
}

/**
 * OIDC token for Cloud Run service-to-service auth.
 * Returns null in local dev (NODE_ENV !== 'production').
 */
async function getCloudRunToken(targetUrl) {
    if (process.env.NODE_ENV !== 'production') return null;
    try {
        const { GoogleAuth } = require('google-auth-library');
        const client = await new GoogleAuth().getIdTokenClient(targetUrl);
        const h = await client.getRequestHeaders(targetUrl);
        return h.Authorization;
    } catch (e) {
        console.warn('[OIDC] token fetch failed:', e.message);
        return null;
    }
}

const app = express();

// Capture raw body for webhook routes BEFORE express.json parses them.
// svix signature verification requires the original bytes, not a parsed object.
app.use((req, res, next) => {
    if (req.path.startsWith('/api/webhooks/')) {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => { req.rawBody = Buffer.concat(chunks); next(); });
    } else {
        next();
    }
});

app.use(express.json({ limit: '10mb' })); // 10mb covers large graph snapshots for public link sharing

const port = process.env.PORT || 4000;
const mcpServerUrl = process.env.MCP_SERVER_URL || 'http://localhost:8080';

// connect_knowledge_on_demand bridge result limits — mirrors BRIDGE_DEFAULT_LIMIT/BRIDGE_MAX_LIMIT
// in src/mcp_server/domain_registry.py (same env var names, same defaults; keep in sync).
const BRIDGE_DEFAULT_LIMIT = parseInt(process.env.BRIDGE_DEFAULT_LIMIT || '10', 10);
const BRIDGE_MAX_LIMIT = parseInt(process.env.BRIDGE_MAX_LIMIT || '25', 10);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// Fire-and-forget — gateway accepts requests immediately; embedding centroid init runs in background.
// Queries that arrive before init completes skip Phase S and use safe default.
initClassifier(openai).catch(e => console.warn('[CLASSIFY] initClassifier failed:', e.message));
const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
const crypto = require('crypto');

/**
 * Stateless Guest Share Token Utilities
 * Uses HMAC-SHA256 for tamper-proof node sharing.
 */
const SHARE_SECRET = process.env.GATEWAY_SHARE_SECRET || 'cortex_default_fallback_secret_2026';

const signShareToken = (tenantId, nodeId, expiresDays = 30) => {
    const expiresAt = Date.now() + (expiresDays * 24 * 60 * 60 * 1000);
    const payload = `${tenantId}:${nodeId}:${expiresAt}`;
    const signature = crypto.createHmac('sha256', SHARE_SECRET).update(payload).digest('hex');
    return Buffer.from(`${payload}:${signature}`).toString('base64');
};

const verifyShareToken = (token) => {
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const [tenantId, nodeId, expiresAt, signature] = decoded.split(':');
        
        if (Date.now() > parseInt(expiresAt)) return null;
        
        const expectedPayload = `${tenantId}:${nodeId}:${expiresAt}`;
        const expectedSignature = crypto.createHmac('sha256', SHARE_SECRET).update(expectedPayload).digest('hex');
        
        if (signature !== expectedSignature) return null;
        
        return { tenantId, nodeId };
    } catch (e) {
        return null;
    }
};

// ALLOWED_ORIGIN: restrict to app subdomain in production, wildcard in local dev.
// Set ALLOWED_ORIGIN=https://app.cortex-drive.com in Cloud Run env after custom domain is live.
const _corsOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: _corsOrigin }));

/**
 * Interceptor for Stateless Guest Share Tokens
 * Async: checks Redis to support link revocation (DEL guest_link:{tokenHash} = revoke).
 */
const guestTokenMiddleware = async (req, res, next) => {
    const token = req.query.share || req.headers['x-share-token'];

    if (token) {
        const verified = verifyShareToken(token);
        if (verified) {
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            try {
                const active = await redis.get(`guest_link:${tokenHash}`);
                if (!active) {
                    console.warn(`[GUEST-AUTH] Token revoked or not registered (hash: ${tokenHash.slice(0, 8)}…)`);
                    return res.status(403).json({ error: 'This link has been revoked or has expired.' });
                }
            } catch (redisErr) {
                // Redis unavailable — fall through and honour the HMAC signature alone
                console.warn('[GUEST-AUTH] Redis check failed, falling back to HMAC-only:', redisErr.message);
            }
            console.log(`[GUEST-AUTH] Valid Share Token for Node: ${verified.nodeId}`);
            req.headers['x-tenant-id'] = verified.tenantId;
            req.headers['x-user-id'] = 'guest-auth';
            req.headers['x-guest-share-anchor'] = verified.nodeId;
            return next();
        } else {
            console.warn(`[GUEST-AUTH] Expired or Invalid Share Token attempt.`);
        }
    }
    next();
};

// Health check
app.get('/health', (req, res) => res.send({ status: 'ok' }));

// Auth Middleware
const authMiddleware = async (req, res, next) => {
    // 0. Guest Share Token Bypass (Signature-validated by guestTokenMiddleware)
    if (req.headers['x-user-id'] === 'guest-auth') {
        console.log(`[AUTH] Bypassing Clerk for guest-auth (Anchor: ${req.headers['x-guest-share-anchor']})`);
        return next();
    }

    const authHeader = req.headers.authorization;
    const apiKey = req.headers['x-api-key'];

    // 1. Primary Auth: Clerk JWT
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
            // Standardizing for @clerk/backend standalone verification
            const decoded = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
            
            // TENANT_ID env var wins — handles dev/prod Clerk split where dev JWT carries
            // a different org_id than the Neo4j tenant (migrated to prod org_id in Phase 1).
            const tenantId = process.env.TENANT_ID || decoded.org_id || decoded.sub;
            console.log(`[AUTH] Resolved Tenant ID: ${tenantId} (EnvOverride: ${!!process.env.TENANT_ID}, JwtOrg: ${decoded.org_id || 'none'})`);
            
            req.headers['x-tenant-id'] = tenantId;
            // OWNER_USER_ID env var wins — dev Clerk sub differs from prod sub, but OpenFGA
            // tuples are keyed on the production sub. Same override pattern as TENANT_ID.
            req.headers['x-raw-user-id'] = decoded.sub || ''; // always the real Clerk sub — used by activate-pending
            req.headers['x-user-id'] = process.env.OWNER_USER_ID || decoded.sub || '';
            
            // Check for admin role to grant 'Schema Readable' permission (Founder/Owner)
            const isAdmin = decoded.org_role === 'org:admin' || decoded.org_role === 'admin';
            if (isAdmin) {
                req.headers['x-schema-readable'] = 'true';
            }
            
            delete req.headers['authorization'];
            console.log('JWT Auth verified for tenant:', tenantId, 'user:', decoded.sub, 'admin:', isAdmin);
            return next();
        } catch (err) {
            console.error('JWT verification failed:', err.message);
            return res.status(401).send({ error: 'Unauthorized: Invalid JWT token' });
        }
    }

    // 2. Secondary Auth: Public API Key (For Trials/CURL)
    // Only reachable if NO Authorization header was provided
    if (apiKey) {
        const PUBLIC_TRIAL_KEY = process.env.PUBLIC_TRIAL_API_KEY || 'cortex_trial_key_2024';
        const TRIAL_TENANT_ID = process.env.TENANT_ID || process.env.PUBLIC_TRIAL_TENANT_ID || 'org_3AacpFBbt39hPmDKyZyNBQuuM6t';

        if (apiKey === PUBLIC_TRIAL_KEY) {
            req.headers['x-tenant-id'] = TRIAL_TENANT_ID;
            // Use OWNER_USER_ID so OpenFGA lookups return the owner's allowed nodes
            req.headers['x-user-id'] = process.env.OWNER_USER_ID || 'trial-user';
            console.log('Public Trial Access granted for tenant:', TRIAL_TENANT_ID);
            return next();
        } else {
            return res.status(401).send({ error: 'Unauthorized: Invalid API Key' });
        }
    }

    return res.status(401).send({ error: 'Unauthorized: Authentication required (JWT or API Key)' });
};

// ─── Pending Grant Helpers ────────────────────────────────────────────────────

/**
 * Activate all pending invitations for a newly signed-up user.
 * Reads from the unified `invitations` table (share and group types).
 * Called by the Clerk webhook fast-path and the pull-model safety net on first login.
 */
async function activatePendingGrants(email, userSub) {
    if (!email || !userSub) return;
    const normalizedEmail = email.toLowerCase().trim();

    const { rows: invites } = await db.query(
        `SELECT i.invitation_id, i.invitation_type, i.resource_id, i.expires_at,
                sg.child_node_ids, sg.grant_type
         FROM invitations i
         LEFT JOIN share_grants sg
             ON i.invitation_type = 'share' AND sg.grant_id::text = i.resource_id
         WHERE i.invited_email = $1 AND i.status = 'pending'`,
        [normalizedEmail]
    );

    if (invites.length > 0) {
        console.log(`[pending-grants] Activating ${invites.length} invitation(s) for ${normalizedEmail} → ${userSub}`);
    }

    for (const inv of invites) {
        try {
            if (inv.invitation_type === 'share') {
                const nodeIds = inv.child_node_ids || [];
                await Promise.all(nodeIds.map(id =>
                    permify.shareNodeWithUser(id, userSub, inv.expires_at || null)
                ));
                await db.query(
                    `INSERT INTO role_assignments
                       (resource_type, resource_id, assignee_type, assignee_id,
                        assignee_email, assigned_by, expires_at)
                     VALUES ('grant', $1, 'user', $2, $3, 'system:invite-activation', $4)`,
                    [inv.resource_id, userSub, normalizedEmail, inv.expires_at]
                );
                console.log(`[pending-grants] Activated share grant ${inv.resource_id} for ${userSub}`);
            } else {
                // group invitation
                await db.query(
                    `INSERT INTO group_members (group_id, user_sub, added_by, email)
                     VALUES ($1, $2, 'system:invite-activation', $3)
                     ON CONFLICT (group_id, user_sub) DO NOTHING`,
                    [inv.resource_id, userSub, normalizedEmail]
                );
                if (permify.configured()) {
                    await permify.addGroupMember(inv.resource_id, userSub);
                }
                console.log(`[pending-grants] Added ${userSub} to group ${inv.resource_id}`);
            }
            await db.query(
                `UPDATE invitations SET status = 'accepted', accepted_at = now()
                 WHERE invitation_id = $1`,
                [inv.invitation_id]
            );
            await redis.del(`perm:${userSub}`);
        } catch (err) {
            console.error(`[pending-grants] Failed invite ${inv.invitation_id}:`, err.message);
        }
    }

    // Clean up Clerk allowlist — user has signed up, no longer needed
    await removeFromClerkAllowlist(normalizedEmail).catch(() => {});
    return invites.length;
}

/**
 * Send a Resend transactional email notifying a pending recipient they were shared with.
 * No-op if RESEND_API_KEY is not configured — safe to call at any time.
 */
// Provisions a new invited user end-to-end without depending on Clerk's sign-up flow:
// 1. Creates the Clerk account programmatically (bypasses all sign-up restrictions)
// 2. Adds to Clerk org immediately
// 3. Activates pending CortexDrive grants directly (doesn't wait for webhook)
// 4. Issues a sign-in token (single-use magic link, no password required)
// 5. Delivers via Resend — user clicks → signs in → lands on dashboard with full access
// If the user already has a Clerk account, skips creation and just sends the sign-in link.
async function sendClerkOrgInvitation(toEmail, inviterName = 'A Cortex-Drive member') {
    const orgId  = process.env.CLERK_ORG_ID || 'org_3E0FtIXiFM6DHwXg05sEVvq2mi0';
    const appUrl = process.env.APP_URL || 'https://app.cortex-drive.com';
    try {
        let userId;
        const existing = await clerkClient.users.getUserList({ emailAddress: [toEmail] });
        if (existing.data.length > 0) {
            userId = existing.data[0].id;
            console.log(`[clerk/invite] ${toEmail} already has Clerk account ${userId} — sending sign-in link`);
        } else {
            // Create Clerk account directly — bypasses all sign-up mode restrictions.
            // Random password is set but never used — the user signs in via the token link.
            // Derive a display name from the email local-part so the UI shows a name instead
            // of the "Agent Identity" fallback (user?.fullName || "Agent Identity" in dashboard).
            const randomPassword = require('crypto').randomBytes(32).toString('hex');
            const emailLocalPart = toEmail.split('@')[0];
            const derivedFirstName = emailLocalPart
                .replace(/[._-]+/g, ' ')
                .replace(/\b\w/g, c => c.toUpperCase());
            const newUser = await clerkClient.users.createUser({
                emailAddress:        [toEmail],
                password:            randomPassword,
                skipPasswordChecks:  true,
                firstName:           derivedFirstName,
            });
            userId = newUser.id;
            console.log(`[clerk/invite] Created Clerk account for ${toEmail}: ${userId}`);

            // Add to org immediately (webhook may also do this, but fire it here too)
            await clerkClient.organizations.createOrganizationMembership({
                organizationId: orgId,
                userId,
                role: 'org:member',
            }).then(() =>
                console.log(`[clerk/invite] Added ${userId} to org`)
            ).catch(e =>
                console.warn('[clerk/invite] Org membership:', e.message)
            );

            // Activate pending grants directly in case the user.created webhook fires
            // after we send the email and the user signs in before the webhook arrives
            activatePendingGrants(toEmail, userId).catch(e =>
                console.error('[clerk/invite] activatePendingGrants:', e.message)
            );
        }

        // Issue a single-use sign-in token — user clicks the link to sign in without
        // a password, regardless of Clerk's sign-up or authentication restrictions
        const signInToken = await clerkClient.signInTokens.createSignInToken({
            userId,
            expiresInSeconds: 60 * 60 * 24 * 7, // 7 days
        });
        const signInUrl = `${appUrl}/sign-in?__clerk_ticket=${signInToken.token}`;

        if (process.env.RESEND_API_KEY) {
            await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    from: 'Cortex-Drive <noreply@cortex-drive.com>',
                    to:   [toEmail],
                    subject: `${inviterName} invited you to Cortex-Drive`,
                    html: `
                        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#080a0f;color:#e2e8f0;border-radius:16px">
                            <h2 style="color:#fff;margin:0 0 16px">${inviterName} invited you to Cortex-Drive</h2>
                            <p style="color:#94a3b8;margin:0 0 8px">You've been given access to a shared knowledge graph on Cortex-Drive.</p>
                            <p style="color:#94a3b8;margin:0 0 24px">Click below to sign in — your account has been created and access will be granted automatically.</p>
                            <a href="${signInUrl}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 24px;border-radius:12px;text-decoration:none;font-weight:700">Sign in to Cortex-Drive →</a>
                            <p style="color:#475569;font-size:12px;margin-top:32px">This link expires in 7 days. If you didn't expect this, you can ignore this email.</p>
                        </div>
                    `,
                }),
            });
            console.log(`[clerk/invite] Resend sign-in link sent to ${toEmail}`);
        } else {
            console.warn(`[clerk/invite] RESEND_API_KEY not set — account created but email not sent for ${toEmail}`);
        }
    } catch (err) {
        const detail = err.errors ? JSON.stringify(err.errors) : err.message;
        console.error('[clerk/invite]', detail); // non-fatal — pull model is the fallback
    }
}

// ─── Clerk Allowlist Helpers ───────────────────────────────────────────────────
// Stubbed out: Clerk allowlist API requires a paid plan (returns 402 Payment Required
// on the current plan). Access control is enforced entirely by Permify — users who
// sign up without an invite can authenticate but see zero nodes (accessScope=restricted).
// Re-enable by restoring the Clerk API calls if the plan is upgraded.

async function addToClerkAllowlist(_email) { /* no-op — see comment above */ }

async function hasOtherPendingInvites(email) {
    const { rows } = await db.query(
        `SELECT 1 FROM invitations WHERE invited_email = $1 AND status = 'pending' LIMIT 1`,
        [email]
    );
    return rows.length > 0;
}

async function removeFromClerkAllowlist(_email) { /* no-op — see comment above */ }

// ─── Grant Reuse Helpers ───────────────────────────────────────────────────────
// Grant = content bundle (what was shared). Multiple audience members can share
// one grant. findOrCreateGrant ensures one grant per (issuer, root_node, type).

async function findOrCreateGrant(issuedBy, rootNodeId, nodeIds, grantType, expiresAt) {
    const { rows: [existing] } = await db.query(
        `SELECT grant_id, child_node_ids FROM share_grants
         WHERE issued_by = $1 AND root_node_id = $2 AND grant_type = $3 AND status = 'active'
         ORDER BY issued_at DESC LIMIT 1`,
        [issuedBy, rootNodeId, grantType]
    );

    if (existing) {
        const incomingSet = new Set(nodeIds);
        const existingSet = new Set(existing.child_node_ids || []);
        const exactMatch  = incomingSet.size === existingSet.size
                         && [...incomingSet].every(id => existingSet.has(id));

        if (exactMatch) {
            return { grantId: existing.grant_id, reused: true, nodesChanged: false };
        }
        // Graph changed — update content bundle and refresh Permify for existing audience
        await db.query(
            `UPDATE share_grants SET child_node_ids = $1 WHERE grant_id = $2`,
            [nodeIds, existing.grant_id]
        );
        await refreshPermifyForGrant(existing.grant_id, existing.child_node_ids || [], nodeIds);
        return { grantId: existing.grant_id, reused: true, nodesChanged: true };
    }

    const { rows: [newGrant] } = await db.query(
        `INSERT INTO share_grants
           (root_node_id, grant_type, depth_ui_selection, composition_rels,
            child_node_ids, already_accessible_ids, private_node_ids, issued_by, expires_at)
         VALUES ($1, $2, 0, $3, $4, '{}', '{}', $5, $6)
         RETURNING grant_id`,
        [rootNodeId, grantType, COMPOSITION_RELS, nodeIds, issuedBy, expiresAt || null]
    );
    return { grantId: newGrant.grant_id, reused: false, nodesChanged: false };
}

async function refreshPermifyForGrant(grantId, oldNodeIds, newNodeIds) {
    const { rows: audience } = await db.query(
        `SELECT assignee_type, assignee_id FROM role_assignments
         WHERE resource_type = 'grant' AND resource_id = $1 AND status = 'active'`,
        [grantId]
    );
    if (audience.length === 0) return;

    const oldSet  = new Set(oldNodeIds);
    const newSet  = new Set(newNodeIds);
    const added   = newNodeIds.filter(id => !oldSet.has(id));
    const removed = oldNodeIds.filter(id => !newSet.has(id));

    for (const member of audience) {
        if (added.length > 0) {
            await Promise.all(added.map(nodeId =>
                member.assignee_type === 'group'
                    ? permify.shareNodeWithGroup(nodeId, member.assignee_id, null).catch(() => {})
                    : permify.shareNodeWithUser(nodeId, member.assignee_id, null).catch(() => {})
            ));
        }
        if (removed.length > 0) {
            const subject = member.assignee_type === 'group'
                ? `group:${member.assignee_id}#member` : member.assignee_id;
            await Promise.all(removed.map(nodeId =>
                permify.revokeNodeAccess(nodeId, subject, 'shared_viewer').catch(() => {})
            ));
        }
    }
}

// ─── Clerk Webhook ─────────────────────────────────────────────────────────────
// Fast path: Clerk fires user.created → provision pending grants immediately.
// Signature verified with svix using CLERK_WEBHOOK_SECRET.
// Register the endpoint in Clerk dashboard → Webhooks → Add endpoint.
// URL: https://api.cortex-drive.com/api/webhooks/clerk
// Event: user.created

app.post('/api/webhooks/clerk', async (req, res) => {
    const WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;
    if (!WEBHOOK_SECRET) {
        console.log('[webhook/clerk] CLERK_WEBHOOK_SECRET not set — skipping');
        return res.status(200).json({ skipped: true });
    }
    const svixId        = req.headers['svix-id'];
    const svixTimestamp = req.headers['svix-timestamp'];
    const svixSignature = req.headers['svix-signature'];
    if (!svixId || !svixTimestamp || !svixSignature) {
        return res.status(400).json({ error: 'Missing svix headers' });
    }
    let event;
    try {
        const wh = new SvixWebhook(WEBHOOK_SECRET);
        event = wh.verify(req.rawBody || req.body, {
            'svix-id':        svixId,
            'svix-timestamp': svixTimestamp,
            'svix-signature': svixSignature,
        });
    } catch (err) {
        console.error('[webhook/clerk] Signature verification failed:', err.message);
        return res.status(400).json({ error: 'Invalid signature' });
    }

    if (event.type === 'user.created') {
        const { id: userSub, email_addresses, primary_email_address_id } = event.data;
        const primaryEmail =
            email_addresses?.find(e => e.id === primary_email_address_id)?.email_address
            || email_addresses?.[0]?.email_address;
        console.log(`[webhook/clerk] user.created: ${primaryEmail} → ${userSub}`);
        if (primaryEmail && userSub) {
            const orgId = process.env.CLERK_ORG_ID || 'org_3E0FtIXiFM6DHwXg05sEVvq2mi0';
            // Fire-and-forget — respond 200 immediately so Clerk doesn't retry
            Promise.all([
                activatePendingGrants(primaryEmail, userSub).catch(e =>
                    console.error('[webhook/clerk activation]', e.message)
                ),
                clerkClient.organizations.createOrganizationMembership({
                    organizationId: orgId,
                    userId: userSub,
                    role: 'org:member',
                }).then(() =>
                    console.log(`[webhook/clerk] Added ${userSub} to org ${orgId}`)
                ).catch(e =>
                    // Non-fatal: user may already be a member
                    console.warn('[webhook/clerk] Org membership:', e.message)
                ),
            ]);
        }
    }
    res.status(200).json({ received: true });
});

// ─── Pull Model: Pending Grant Activation ─────────────────────────────────────
// Safety net called from the dashboard on first load each session.
// Handles cases where the Clerk webhook failed or app was down at sign-up time.
// Uses x-raw-user-id (real Clerk sub) to avoid OWNER_USER_ID substitution.
// Rate-limited per user via Redis TTL (1 hour) to avoid hammering the DB.

app.post('/api/auth/activate-pending', authMiddleware, async (req, res) => {
    const userSub  = req.headers['x-raw-user-id'] || req.headers['x-user-id'];
    const cacheKey = `pending_activated:${userSub}`;
    try {
        // Redis gate is best-effort — a miss or error means run activation anyway.
        // enableOfflineQueue:false causes ioredis to throw on cold-start before the
        // connection is established; treating that as a cache miss is correct behavior.
        let cached = null;
        try { cached = await redis.get(cacheKey); } catch { /* non-fatal — treat as miss */ }
        if (cached) return res.json({ skipped: true });

        // Resolve this user's primary email from Clerk (one-time Clerk API call per hour)
        const user = await clerkClient.users.getUser(userSub);
        const email =
            user.emailAddresses?.find(e => e.id === user.primaryEmailAddressId)?.emailAddress
            || user.emailAddresses?.[0]?.emailAddress;

        let activatedCount = 0;
        if (email) {
            activatedCount = await activatePendingGrants(email, userSub);
        }

        // Only set the gate when invitations were actually found and processed.
        // If set unconditionally on a clean (no-invite) login, future invites sent
        // within the 1hr window would never activate — user stays locked out.
        if (activatedCount > 0) {
            try { await redis.set(cacheKey, '1', 'EX', 3600); } catch { /* non-fatal */ }
        }
        res.json({ ok: true, activated: activatedCount });
    } catch (err) {
        console.error('[/api/auth/activate-pending]', err.message);
        res.json({ ok: false }); // non-fatal — return 200 so frontend doesn't surface an error
    }
});

// Admin-only sweep: scan ALL pending grants, look up each pending_email in Clerk,
// and activate those whose recipients have already signed up.
// Use case: admin logs in and provisions any users whose webhook delivery was missed
// (e.g., gateway was cold/restarting at the moment they signed up).
// Gated on x-schema-readable header (set by authMiddleware for org:admin role).
app.post('/api/auth/activate-pending/sweep', authMiddleware, async (req, res) => {
    if (req.headers['x-schema-readable'] !== 'true') {
        return res.status(403).json({ error: 'Admin role required' });
    }
    try {
        const { rows: pending } = await db.query(
            `SELECT DISTINCT invited_email FROM invitations WHERE status = 'pending'`
        );
        if (pending.length === 0) return res.json({ swept: 0, activated: 0, stillPending: 0 });

        let activated = 0;
        let stillPending = 0;

        for (const { invited_email: email } of pending) {
            try {
                const users = await clerkClient.users.getUserList({ emailAddress: [email] });
                if (users.data.length > 0) {
                    const clerkUser = users.data[0];
                    await activatePendingGrants(email, clerkUser.id);
                    activated++;
                    console.log(`[admin-sweep] Activated grants for ${email} → ${clerkUser.id}`);
                } else {
                    stillPending++;
                    console.log(`[admin-sweep] ${email} has not signed up yet — skipping`);
                }
            } catch (err) {
                console.error(`[admin-sweep] Error processing ${email}:`, err.message);
                stillPending++;
            }
        }

        res.json({ swept: pending.length, activated, stillPending });
    } catch (err) {
        console.error('[/api/auth/activate-pending/sweep]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Endpoints
 */
app.get('/api/share', authMiddleware, async (req, res) => {
    const { nodeId } = req.query;
    const tenantId = req.headers['x-tenant-id'];
    if (!nodeId) return res.status(400).send({ error: "Missing 'nodeId' for sharing" });

    const expireDays = Math.min(Math.max(parseInt(req.query.expireDays) || 30, 1), 90);
    const token = signShareToken(tenantId, nodeId, expireDays);
    const shareUrl = `${process.env.FRONTEND_URL || 'https://app.cortex-drive.com'}/discovery?share=${token}`;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expirySeconds = expireDays * 86400;
    const issuedAt = Date.now();
    const expiresAt = issuedAt + expirySeconds * 1000;

    try {
        const linkMeta = JSON.stringify({ nodeId, tenantId, issuedAt, expiresAt, expireDays });
        await redis.setex(`guest_link:${tokenHash}`, expirySeconds, linkMeta);
        await redis.sadd(`guest_links:${tenantId}:${nodeId}`, tokenHash);
        await redis.expire(`guest_links:${tenantId}:${nodeId}`, 90 * 86400);
    } catch (redisErr) {
        console.warn('[GUEST-LINK] Redis registration failed (non-fatal):', redisErr.message);
    }

    res.send({
        token,
        shareUrl,
        tokenHash,
        expiresIn: `${expireDays} days`,
        note: "This URL grants stateless 'read-only' access to the specified graph island."
    });
});

app.get('/api/share/links/:node_id', authMiddleware, async (req, res) => {
    const tenantId = req.headers['x-tenant-id'];
    try {
        const members = await redis.smembers(`guest_links:${tenantId}:${req.params.node_id}`);
        const links = (await Promise.all(members.map(async h => {
            const meta = await redis.get(`guest_link:${h}`);
            return meta ? { tokenHash: h, ...JSON.parse(meta) } : null;
        }))).filter(Boolean);
        res.json(links);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/share/revoke-link', authMiddleware, async (req, res) => {
    const { tokenHash, node_id } = req.body;
    const tenantId = req.headers['x-tenant-id'];
    if (!tokenHash || !node_id) return res.status(400).json({ error: 'tokenHash and node_id required' });
    try {
        await redis.del(`guest_link:${tokenHash}`);
        await redis.srem(`guest_links:${tenantId}:${node_id}`, tokenHash);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Share Endpoints (Permify-backed, depth-aware) ---
// Permify is the enforcement layer. share_grants (Cloud SQL) is the audit/UI record.
// Every share writes ONE shared_viewer tuple on the root; children inherit via parent chain.

app.post('/api/share/tenant-wide', authMiddleware, async (req, res) => {
    const { node_id } = req.body;
    const tenantId = req.headers['x-tenant-id'];
    if (!node_id) return res.status(400).json({ error: 'node_id required' });
    const fga = getFgaClient();
    if (!fga) return res.status(503).json({ error: 'OpenFGA not configured' });
    try {
        const { makeNodeTenantWide } = require('./utils/openfga_gateway');
        await makeNodeTenantWide(fga, node_id, tenantId);
        await redis.incr(`perm_version:${tenantId}`);
        res.json({ ok: true });
    } catch (err) {
        console.error('[/api/share/tenant-wide]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Preview what will be shared — no Permify writes, no share_grants record.
// Returns child_node_ids[], private_node_ids[], alreadyAccessible[].
app.post('/api/share/infer', authMiddleware, async (req, res) => {
    const { rootNodeId, targetSub, depthSelection = 5 } = req.body;
    const tenantId = req.headers['x-tenant-id'];
    if (!rootNodeId) return res.status(400).json({ error: 'rootNodeId required' });
    try {
        const bento   = process.env.BENTO_SERVER_URL || 'http://localhost:8000';
        const subtree = await fetch(`${bento}/get_composition_subtree`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
            body:    JSON.stringify({ root_node_id: rootNodeId, max_depth: depthSelection }),
        }).then(r => r.json());

        let alreadyAccessible = [];
        if (targetSub && permify.configured()) {
            const currentIds = await permify.listViewableNodeIds(targetSub) || [];
            const currentSet = new Set(currentIds);
            alreadyAccessible = subtree.child_node_ids.filter(id => currentSet.has(id));
        }
        res.json({ ...subtree, alreadyAccessible });
    } catch (err) {
        console.error('[/api/share/infer]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Share a node (and its composition subtree) with a user or via pending invite.
// Audience tracked in role_assignments. Grant reuse: one grant per (issuer, root, type).
app.post('/api/share/user', authMiddleware, async (req, res) => {
    const { rootNodeId, targetSub, pendingEmail, expiresAt, depthSelection = 5 } = req.body;
    const tenantId  = req.headers['x-tenant-id'];
    const issuedBy  = req.headers['x-user-id'];
    const issuerSub = req.headers['x-raw-user-id'] || issuedBy;

    if (!rootNodeId || (!targetSub && !pendingEmail)) {
        return res.status(400).json({ error: 'rootNodeId and (targetSub or pendingEmail) required' });
    }

    try {
        let childNodeIds   = [rootNodeId];
        let privateNodeIds = [];

        if (targetSub) {
            const bento   = process.env.BENTO_SERVER_URL || 'http://localhost:8000';
            const subtree = await fetch(`${bento}/get_composition_subtree`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
                body:    JSON.stringify({ root_node_id: rootNodeId, max_depth: depthSelection }),
            }).then(r => r.json());
            childNodeIds   = subtree.child_node_ids || [rootNodeId];
            privateNodeIds = subtree.private_node_ids || [];
        }

        const { grantId, reused } = await findOrCreateGrant(
            issuedBy, rootNodeId, childNodeIds, 'node', expiresAt
        );

        if (pendingEmail) {
            const normalizedEmail = pendingEmail.toLowerCase().trim();
            await db.query(
                `INSERT INTO invitations
                   (org_id, invitation_type, resource_id, invited_email, invited_by, expires_at)
                 VALUES ($1, 'share', $2, $3, $4, $5)
                 ON CONFLICT (invitation_type, resource_id, invited_email) WHERE status = 'pending'
                 DO UPDATE SET invited_at = now(), expires_at = $5`,
                [tenantId, grantId, normalizedEmail, issuedBy, expiresAt || null]
            );
            let sharerName = issuedBy;
            try {
                const issuer = await clerkClient.users.getUser(issuerSub);
                sharerName = `${issuer.firstName || ''} ${issuer.lastName || ''}`.trim()
                    || issuer.emailAddresses?.[0]?.emailAddress || issuedBy;
            } catch { /* non-fatal */ }
            await sendClerkOrgInvitation(normalizedEmail, sharerName);
            return res.json({ pending: true, grantId, reused });
        }

        await permify.shareNodeWithUser(rootNodeId, targetSub, expiresAt || null);

        let targetEmail = null;
        try {
            const u = await clerkClient.users.getUser(targetSub);
            targetEmail = u.emailAddresses?.[0]?.emailAddress || null;
        } catch { /* non-fatal */ }

        await db.query(
            `INSERT INTO role_assignments
               (resource_type, resource_id, assignee_type, assignee_id, assignee_email, assigned_by, expires_at)
             SELECT 'grant', $1, 'user', $2, $3, $4, $5
             WHERE NOT EXISTS (
               SELECT 1 FROM role_assignments
               WHERE resource_type = 'grant' AND resource_id = $1
                 AND assignee_type = 'user' AND assignee_id = $2 AND status = 'active'
             )`,
            [grantId, targetSub, targetEmail, issuedBy, expiresAt || null]
        );
        await Promise.all([
            redis.del(`perm:${targetSub}`),
            redis.incr(`perm_version:${tenantId}`),
        ]);
        res.json({ grantId, reused, childNodeIds, privateNodeIds });
    } catch (err) {
        console.error('[/api/share/user]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/share/group', authMiddleware, async (req, res) => {
    const { rootNodeId, groupId, expiresAt, depthSelection = 5 } = req.body;
    if (!rootNodeId || !groupId) return res.status(400).json({ error: 'rootNodeId and groupId required' });
    const tenantId = req.headers['x-tenant-id'];
    const issuedBy = req.headers['x-user-id'];
    try {
        const bento = process.env.BENTO_URL || 'http://localhost:8000';
        const subtreeResp = await fetch(`${bento}/get_composition_subtree`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
            body: JSON.stringify({ root_node_id: rootNodeId, max_depth: depthSelection }),
        });
        const subtree = subtreeResp.ok ? await subtreeResp.json() : { child_node_ids: [], private_node_ids: [] };
        const { child_node_ids: childNodeIds = [rootNodeId], private_node_ids: privateNodeIds = [] } = subtree;

        const { grantId, reused } = await findOrCreateGrant(
            issuedBy, rootNodeId, childNodeIds, 'node', expiresAt
        );

        await permify.shareNodeWithGroup(rootNodeId, groupId, expiresAt || null);

        await db.query(
            `INSERT INTO role_assignments
               (resource_type, resource_id, assignee_type, assignee_id, assigned_by, expires_at)
             SELECT 'grant', $1, 'group', $2, $3, $4
             WHERE NOT EXISTS (
               SELECT 1 FROM role_assignments
               WHERE resource_type = 'grant' AND resource_id = $1
                 AND assignee_type = 'group' AND assignee_id = $2 AND status = 'active'
             )`,
            [grantId, groupId, issuedBy, expiresAt || null]
        );
        await redis.incr(`perm_version:${tenantId}`);
        res.json({ grantId, reused, childNodeIds, privateNodeIds });
    } catch (err) {
        console.error('[/api/share/group]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Grant-level revocation: removes access for ALL audience members atomically.
app.delete('/api/share/grants/:grant_id', authMiddleware, async (req, res) => {
    const { grant_id } = req.params;
    const tenantId  = req.headers['x-tenant-id'];
    const revokedBy = req.headers['x-user-id'] || 'unknown';
    try {
        const { rows: [grant] } = await db.query(
            `SELECT child_node_ids FROM share_grants WHERE grant_id = $1 AND status = 'active'`,
            [grant_id]
        );
        if (!grant) return res.status(404).json({ error: 'Grant not found or already revoked' });

        const { rows: audience } = await db.query(
            `SELECT assignment_id, assignee_type, assignee_id FROM role_assignments
             WHERE resource_type = 'grant' AND resource_id = $1 AND status = 'active'`,
            [grant_id]
        );

        // Revoke all Permify tuples for all audience × all nodes
        for (const member of audience) {
            const subject = member.assignee_type === 'group'
                ? `group:${member.assignee_id}#member` : member.assignee_id;
            await Promise.all((grant.child_node_ids || []).map(nodeId =>
                permify.revokeNodeAccess(nodeId, subject, 'shared_viewer').catch(() => {})
            ));
        }

        await db.query(
            `UPDATE role_assignments SET status = 'revoked', revoked_at = now(), revoked_by = $1
             WHERE resource_type = 'grant' AND resource_id = $2`,
            [revokedBy, grant_id]
        );
        const { rows: cancelledInvites } = await db.query(
            `UPDATE invitations SET status = 'cancelled'
             WHERE invitation_type = 'share' AND resource_id = $1 AND status = 'pending'
             RETURNING invited_email`,
            [grant_id]
        );
        await db.query(
            `UPDATE share_grants SET status = 'revoked', revoked_at = now(), revoked_by = $1
             WHERE grant_id = $2`,
            [revokedBy, grant_id]
        );

        // Clean up Clerk allowlist for any cancelled pending invitations
        for (const { invited_email } of cancelledInvites) {
            removeFromClerkAllowlist(invited_email).catch(() => {});
        }

        // Bust caches for all user-type audience members
        const userSubs = audience
            .filter(m => m.assignee_type === 'user')
            .map(m => m.assignee_id);
        await Promise.all([
            ...userSubs.map(sub => redis.del(`perm:${sub}`)),
            redis.incr(`perm_version:${tenantId}`),
        ]);
        res.json({ revoked: true, audienceCount: audience.length });
    } catch (err) {
        console.error('[DELETE /api/share/grants/:grant_id]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Per-audience revocation: removes one audience member's access while others retain theirs.
app.delete('/api/share/grants/:grant_id/audience/:assignment_id', authMiddleware, async (req, res) => {
    const { grant_id, assignment_id } = req.params;
    const tenantId  = req.headers['x-tenant-id'];
    const revokedBy = req.headers['x-user-id'] || 'unknown';
    try {
        const { rows: [assignment] } = await db.query(
            `SELECT assignee_type, assignee_id FROM role_assignments
             WHERE assignment_id = $1 AND resource_id = $2 AND resource_type = 'grant' AND status = 'active'`,
            [assignment_id, grant_id]
        );
        if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

        const { rows: [grant] } = await db.query(
            `SELECT child_node_ids FROM share_grants WHERE grant_id = $1`,
            [grant_id]
        );
        const subject = assignment.assignee_type === 'group'
            ? `group:${assignment.assignee_id}#member` : assignment.assignee_id;

        await Promise.all((grant?.child_node_ids || []).map(nodeId =>
            permify.revokeNodeAccess(nodeId, subject, 'shared_viewer').catch(() => {})
        ));
        await db.query(
            `UPDATE role_assignments SET status = 'revoked', revoked_at = now(), revoked_by = $1
             WHERE assignment_id = $2`,
            [revokedBy, assignment_id]
        );

        if (assignment.assignee_type === 'user') {
            await Promise.all([
                redis.del(`perm:${assignment.assignee_id}`),
                redis.incr(`perm_version:${tenantId}`),
            ]);
        } else {
            await redis.incr(`perm_version:${tenantId}`);
        }
        res.json({ revoked: true });
    } catch (err) {
        console.error('[DELETE /api/share/grants/:grant_id/audience/:assignment_id]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/share/access/:node_id', authMiddleware, async (req, res) => {
    const { node_id } = req.params;
    try {
        const access = await permify.listNodeAccess(node_id);
        res.json(access);
    } catch (err) {
        console.error('[/api/share/access]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/share/history/:node_id', authMiddleware, async (req, res) => {
    const { node_id } = req.params;
    try {
        const { rows } = await db.query(
            `SELECT grant_id, grant_type, depth_ui_selection,
                    child_node_ids, already_accessible_ids, private_node_ids,
                    issued_by, issued_at, expires_at, revoked_at, revoked_by, status
             FROM share_grants
             WHERE root_node_id = $1
             ORDER BY issued_at DESC`,
            [node_id]
        );
        const active  = rows.filter(r => r.status === 'active');
        const revoked = rows.filter(r => r.status !== 'active');
        res.json({ active, revoked });
    } catch (err) {
        console.error('[/api/share/history]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Toggle is_private on a node (owner only). Permify attribute is the enforcement source.
app.patch('/api/nodes/:nodeId/privacy', authMiddleware, async (req, res) => {
    const { nodeId }    = req.params;
    const { is_private } = req.body;
    const tenantId = req.headers['x-tenant-id'];
    const userId   = req.headers['x-user-id'];
    if (typeof is_private !== 'boolean') return res.status(400).json({ error: 'is_private (boolean) required' });
    try {
        const canShare = await permify.checkPermission(nodeId, userId, 'can_share');
        if (!canShare) return res.status(403).json({ error: 'Only the node owner can change privacy' });

        await permify.writePrivacyAttribute(nodeId, is_private);
        // Bust tenant-wide cache — privacy change affects all active grants simultaneously
        await redis.incr(`perm_version:${tenantId}`);
        res.json({ nodeId, is_private });
    } catch (err) {
        console.error('[/api/nodes/privacy]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/user/resolve', authMiddleware, async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email required' });
    try {
        const users = await clerkClient.users.getUserList({ emailAddress: [email] });
        if (!users.data.length) return res.status(404).json({ error: 'No Cortex-Drive account found for that email' });
        const u = users.data[0];
        res.json({
            sub: u.id,
            email: u.emailAddresses[0]?.emailAddress,
            name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.emailAddresses[0]?.emailAddress,
        });
    } catch (err) {
        console.error('[/api/user/resolve]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Custom Group Management ─────────────────────────────────────────────────

app.post('/api/groups', authMiddleware, async (req, res) => {
    const { name, slug, description } = req.body;
    const orgId    = req.headers['x-tenant-id'];
    const issuedBy = req.headers['x-user-id'];
    if (!name || !slug) return res.status(400).json({ error: 'name and slug required' });
    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    try {
        const { rows } = await db.query(
            `INSERT INTO groups (org_id, name, slug, description, created_by)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING group_id, name, slug, created_at`,
            [orgId, name, cleanSlug, description || null, issuedBy]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'A group with that slug already exists in your org' });
        console.error('[POST /api/groups]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/groups', authMiddleware, async (req, res) => {
    const orgId = req.headers['x-tenant-id'];
    try {
        const { rows } = await db.query(
            `SELECT g.group_id, g.name, g.slug, g.description, g.created_at,
                    COUNT(gm.user_sub)::int AS member_count
             FROM groups g
             LEFT JOIN group_members gm ON gm.group_id = g.group_id
             WHERE g.org_id = $1
             GROUP BY g.group_id
             ORDER BY g.name`,
            [orgId]
        );
        res.json(rows);
    } catch (err) {
        console.error('[GET /api/groups]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/groups/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const orgId  = req.headers['x-tenant-id'];
    try {
        const { rows: [group] } = await db.query(
            `SELECT group_id, name, slug, description, created_at FROM groups WHERE group_id = $1 AND org_id = $2`,
            [id, orgId]
        );
        if (!group) return res.status(404).json({ error: 'Group not found' });
        const { rows: members } = await db.query(
            `SELECT user_sub, user_org_id, added_by, added_at FROM group_members WHERE group_id = $1 ORDER BY added_at`,
            [id]
        );
        // Enrich members with Clerk display info (best-effort batch)
        const enriched = await Promise.all(members.map(async m => {
            try {
                const u = await clerkClient.users.getUser(m.user_sub);
                return {
                    ...m,
                    display_name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || null,
                    email: u.emailAddresses?.[0]?.emailAddress || null,
                };
            } catch {
                return { ...m, display_name: null, email: null };
            }
        }));
        res.json({ ...group, members: enriched });
    } catch (err) {
        console.error('[GET /api/groups/:id]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/groups/:id/members', authMiddleware, async (req, res) => {
    const { id }    = req.params;
    const { userSub, userOrgId } = req.body;
    const addedBy  = req.headers['x-user-id'];
    const tenantId = req.headers['x-tenant-id'];
    if (!userSub) return res.status(400).json({ error: 'userSub required' });
    try {
        await db.query(
            `INSERT INTO group_members (group_id, user_sub, user_org_id, added_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (group_id, user_sub) DO NOTHING`,
            [id, userSub, userOrgId || null, addedBy]
        );
        if (permify.configured()) {
            await permify.addGroupMember(id, userSub);
        }
        await Promise.all([
            redis.del(`perm:${userSub}`),
            redis.incr(`perm_version:${tenantId}`),
        ]);
        res.status(201).json({ ok: true, groupId: id, userSub });
    } catch (err) {
        console.error('[POST /api/groups/:id/members]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/groups/:id/members/:sub', authMiddleware, async (req, res) => {
    const { id, sub } = req.params;
    const tenantId    = req.headers['x-tenant-id'];
    try {
        const { rowCount } = await db.query(
            `DELETE FROM group_members WHERE group_id = $1 AND user_sub = $2`,
            [id, sub]
        );
        if (rowCount === 0) return res.status(404).json({ error: 'Member not found in group' });
        if (permify.configured()) {
            await permify.removeGroupMember(id, sub);
        }
        await Promise.all([
            redis.del(`perm:${sub}`),
            redis.incr(`perm_version:${tenantId}`),
        ]);
        res.json({ ok: true });
    } catch (err) {
        console.error('[DELETE /api/groups/:id/members/:sub]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Group Invitations ────────────────────────────────────────────────────────
// Unified invite endpoint: resolves email → adds directly if Clerk user exists,
// creates a pending group_invitation + sends email if not.

app.post('/api/groups/:id/invite', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { email } = req.body;
    const orgId    = req.headers['x-tenant-id'];
    const addedBy  = req.headers['x-user-id'];
    const issuerSub = req.headers['x-raw-user-id'] || addedBy;
    if (!email) return res.status(400).json({ error: 'email required' });
    const normalizedEmail = email.toLowerCase().trim();

    try {
        // Verify group belongs to this org
        const { rows: [group] } = await db.query(
            `SELECT group_id, name FROM groups WHERE group_id = $1 AND org_id = $2`,
            [id, orgId]
        );
        if (!group) return res.status(404).json({ error: 'Group not found' });

        // Try to resolve the email in Clerk
        const clerkUsers = await clerkClient.users.getUserList({ emailAddress: [normalizedEmail] });
        if (clerkUsers.data.length > 0) {
            // User exists — add directly as a member
            const userSub = clerkUsers.data[0].id;
            await db.query(
                `INSERT INTO group_members (group_id, user_sub, user_org_id, added_by, email)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (group_id, user_sub) DO NOTHING`,
                [id, userSub, orgId, addedBy, normalizedEmail]
            );
            if (permify.configured()) await permify.addGroupMember(id, userSub);
            await Promise.all([
                redis.del(`perm:${userSub}`),
                redis.incr(`perm_version:${orgId}`),
            ]);
            const u = clerkUsers.data[0];
            return res.status(201).json({
                added: true,
                member: {
                    user_sub: userSub,
                    email: normalizedEmail,
                    display_name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || null,
                    added_at: new Date().toISOString(),
                },
            });
        }

        // User not in Clerk — create pending invitation
        const { rows: [inv] } = await db.query(
            `INSERT INTO invitations (org_id, invitation_type, resource_id, invited_email, invited_by)
             VALUES ($1, 'group', $2, $3, $4)
             ON CONFLICT (invitation_type, resource_id, invited_email) WHERE status = 'pending'
             DO UPDATE SET invited_at = now(), invited_by = $4
             RETURNING invitation_id, invited_at`,
            [orgId, id, normalizedEmail, addedBy]
        );

        // Resolve inviter display name for email
        let inviterName = addedBy;
        try {
            const issuer = await clerkClient.users.getUser(issuerSub);
            inviterName = `${issuer.firstName || ''} ${issuer.lastName || ''}`.trim()
                || issuer.emailAddresses?.[0]?.emailAddress || addedBy;
        } catch { /* non-fatal */ }

        await sendClerkOrgInvitation(normalizedEmail, inviterName);

        res.status(201).json({
            invited: true,
            invitation: {
                invitation_id: inv.invitation_id,
                invited_email: normalizedEmail,
                invited_at: inv.invited_at,
                status: 'pending',
            },
        });
    } catch (err) {
        console.error('[POST /api/groups/:id/invite]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// List pending invitations for a group
app.get('/api/groups/:id/invitations', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const orgId  = req.headers['x-tenant-id'];
    try {
        const { rows: [group] } = await db.query(
            `SELECT group_id FROM groups WHERE group_id = $1 AND org_id = $2`, [id, orgId]
        );
        if (!group) return res.status(404).json({ error: 'Group not found' });
        const { rows } = await db.query(
            `SELECT invitation_id, invited_email AS pending_email, invited_by, invited_at, status
             FROM invitations
             WHERE invitation_type = 'group' AND resource_id = $1 AND status = 'pending'
             ORDER BY invited_at DESC`,
            [id]
        );
        res.json(rows);
    } catch (err) {
        console.error('[GET /api/groups/:id/invitations]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Resend a group invitation email
app.post('/api/groups/:id/invitations/:inv_id/resend', authMiddleware, async (req, res) => {
    const { id, inv_id } = req.params;
    const issuerSub = req.headers['x-raw-user-id'] || req.headers['x-user-id'];
    const orgId     = req.headers['x-tenant-id'];
    try {
        const { rows: [inv] } = await db.query(
            `SELECT i.invited_email AS pending_email, g.name AS group_name
             FROM invitations i
             JOIN groups g ON g.group_id::text = i.resource_id
             WHERE i.invitation_id = $1 AND i.resource_id = $2 AND g.org_id = $3
               AND i.invitation_type = 'group' AND i.status = 'pending'`,
            [inv_id, id, orgId]
        );
        if (!inv) return res.status(404).json({ error: 'Invitation not found' });

        let inviterName = issuerSub;
        try {
            const issuer = await clerkClient.users.getUser(issuerSub);
            inviterName = `${issuer.firstName || ''} ${issuer.lastName || ''}`.trim()
                || issuer.emailAddresses?.[0]?.emailAddress || issuerSub;
        } catch { /* non-fatal */ }

        await sendClerkOrgInvitation(inv.pending_email, inviterName);
        res.json({ ok: true });
    } catch (err) {
        console.error('[POST /api/groups/:id/invitations/:inv_id/resend]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Cancel a group invitation
app.delete('/api/groups/:id/invitations/:inv_id', authMiddleware, async (req, res) => {
    const { id, inv_id } = req.params;
    const orgId = req.headers['x-tenant-id'];
    try {
        const { rows } = await db.query(
            `UPDATE invitations SET status = 'cancelled'
             WHERE invitation_id = $1 AND resource_id = $2 AND invitation_type = 'group'
               AND resource_id IN (SELECT group_id::text FROM groups WHERE org_id = $3)
             RETURNING invitation_id, invited_email`,
            [inv_id, id, orgId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Invitation not found' });
        if (rows[0].invited_email) {
            removeFromClerkAllowlist(rows[0].invited_email).catch(() => {});
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('[DELETE /api/groups/:id/invitations/:inv_id]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Graph Island Sharing ─────────────────────────────────────────────────────

// Share all visible graph nodes with a user, group, or pending email.
// Uses findOrCreateGrant for dedup. Audience tracked in role_assignments.
app.post('/api/share/graph-island', authMiddleware, async (req, res) => {
    const { nodeIds, targetSub, groupId, pendingEmail, expiresAt } = req.body;
    const tenantId  = req.headers['x-tenant-id'];
    const issuedBy  = req.headers['x-user-id'];
    const issuerSub = req.headers['x-raw-user-id'] || issuedBy;

    if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
        return res.status(400).json({ error: 'nodeIds (non-empty array) required' });
    }
    const recipientCount = [targetSub, groupId, pendingEmail].filter(Boolean).length;
    if (recipientCount !== 1) {
        return res.status(400).json({ error: 'Provide exactly one of targetSub, groupId, or pendingEmail' });
    }

    try {
        const rootNodeId = nodeIds[0];
        const { grantId, reused } = await findOrCreateGrant(
            issuedBy, rootNodeId, nodeIds, 'graph_island', expiresAt
        );

        if (pendingEmail) {
            const normalizedEmail = pendingEmail.toLowerCase().trim();
            await db.query(
                `INSERT INTO invitations
                   (org_id, invitation_type, resource_id, invited_email, invited_by, expires_at)
                 VALUES ($1, 'share', $2, $3, $4, $5)
                 ON CONFLICT (invitation_type, resource_id, invited_email) WHERE status = 'pending'
                 DO UPDATE SET invited_at = now(), expires_at = $5`,
                [tenantId, grantId, normalizedEmail, issuedBy, expiresAt || null]
            );
            let sharerName = issuedBy;
            try {
                const issuer = await clerkClient.users.getUser(issuerSub);
                sharerName = `${issuer.firstName || ''} ${issuer.lastName || ''}`.trim()
                    || issuer.emailAddresses?.[0]?.emailAddress || issuedBy;
            } catch { /* non-fatal */ }
            await sendClerkOrgInvitation(normalizedEmail, sharerName);
            return res.json({ pending: true, grantId, totalNodes: nodeIds.length, reused });
        }

        // Write Permify tuples for the new audience member
        await Promise.all(nodeIds.map(nodeId =>
            targetSub
                ? permify.shareNodeWithUser(nodeId, targetSub, expiresAt || null)
                : permify.shareNodeWithGroup(nodeId, groupId, expiresAt || null)
        ));

        const assigneeType = targetSub ? 'user' : 'group';
        const assigneeId   = targetSub || groupId;
        let   assigneeEmail = null;
        if (targetSub) {
            try {
                const u = await clerkClient.users.getUser(targetSub);
                assigneeEmail = u.emailAddresses?.[0]?.emailAddress || null;
            } catch { /* non-fatal */ }
        }

        await db.query(
            `INSERT INTO role_assignments
               (resource_type, resource_id, assignee_type, assignee_id, assignee_email, assigned_by, expires_at)
             SELECT 'grant', $1, $2, $3, $4, $5, $6
             WHERE NOT EXISTS (
               SELECT 1 FROM role_assignments
               WHERE resource_type = 'grant' AND resource_id = $1
                 AND assignee_type = $2 AND assignee_id = $3 AND status = 'active'
             )`,
            [grantId, assigneeType, assigneeId, assigneeEmail, issuedBy, expiresAt || null]
        );
        await Promise.all([
            ...(targetSub ? [redis.del(`perm:${targetSub}`)] : []),
            redis.incr(`perm_version:${tenantId}`),
        ]);
        res.json({ grantId, totalNodes: nodeIds.length, reused });
    } catch (err) {
        console.error('[/api/share/graph-island]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- Public Graph Links (Loom-style) ---

app.post('/api/share/graph-link', authMiddleware, async (req, res) => {
    const userSub  = req.headers['x-user-id'];
    const tenantId = req.headers['x-tenant-id'];
    const { nodeIds, graphData, title, expiresAt } = req.body;
    if (!nodeIds?.length || !graphData) return res.status(400).json({ error: 'nodeIds and graphData required' });
    try {
        const token = crypto.randomBytes(32).toString('base64url');
        const result = await db.query(
            `INSERT INTO graph_share_links (share_token, node_ids, graph_snapshot, title, owner_sub, org_id, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING link_id`,
            [token, nodeIds, JSON.stringify(graphData), title || null, userSub, tenantId, expiresAt || null]
        );
        const shareUrl = `${process.env.FRONTEND_URL || 'https://app.cortex-drive.com'}/graph-view/${token}`;
        res.json({ shareUrl, linkId: result.rows[0].link_id });
    } catch (err) {
        console.error('[/api/share/graph-link POST]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/share/graph-link/:token', async (req, res) => {
    const { token } = req.params;
    try {
        const row = await db.query(
            `SELECT * FROM graph_share_links
             WHERE share_token = $1
               AND revoked_at IS NULL
               AND (expires_at IS NULL OR expires_at > NOW())`,
            [token]
        );
        if (!row.rows.length) return res.status(404).json({ error: 'Link not found or expired' });
        const link = row.rows[0];
        // increment view stats (fire-and-forget)
        db.query(
            `UPDATE graph_share_links SET view_count = view_count + 1, last_viewed_at = NOW() WHERE link_id = $1`,
            [link.link_id]
        ).catch(() => {});
        // resolve owner display name from Clerk (best-effort)
        let ownerName = 'CortexDrive';
        try {
            const owner = await clerkClient.users.getUser(link.owner_sub);
            ownerName = `${owner.firstName || ''} ${owner.lastName || ''}`.trim() || ownerName;
        } catch {}
        const snapshot = typeof link.graph_snapshot === 'string'
            ? JSON.parse(link.graph_snapshot)
            : link.graph_snapshot;
        res.json({
            meta: { title: link.title, ownerName, createdAt: link.created_at, nodeCount: link.node_ids.length },
            nodes: snapshot.nodes || [],
            links: snapshot.links || [],
        });
    } catch (err) {
        console.error('[/api/share/graph-link/:token]', err.message);
        res.status(500).json({ error: 'Failed to load graph' });
    }
});

app.get('/api/share/graph-links', authMiddleware, async (req, res) => {
    const userSub = req.headers['x-user-id'];
    try {
        const result = await db.query(
            `SELECT link_id, title,
                    array_length(node_ids, 1) AS node_count,
                    created_at, expires_at, revoked_at, view_count, last_viewed_at,
                    share_token,
                    CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
                         WHEN expires_at IS NOT NULL AND expires_at < NOW() THEN 'expired'
                         ELSE 'active' END AS status
             FROM graph_share_links WHERE owner_sub = $1 ORDER BY created_at DESC`,
            [userSub]
        );
        const frontendUrl = process.env.FRONTEND_URL || 'https://app.cortex-drive.com';
        res.json(result.rows.map(r => ({ ...r, shareUrl: `${frontendUrl}/graph-view/${r.share_token}` })));
    } catch (err) {
        console.error('[/api/share/graph-links]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/share/graph-link/:linkId', authMiddleware, async (req, res) => {
    const userSub = req.headers['x-user-id'];
    const { linkId } = req.params;
    try {
        const result = await db.query(
            `UPDATE graph_share_links SET revoked_at = NOW()
             WHERE link_id = $1 AND owner_sub = $2 AND revoked_at IS NULL RETURNING link_id`,
            [linkId, userSub]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Link not found' });
        res.json({ ok: true });
    } catch (err) {
        console.error('[/api/share/graph-link DELETE]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// List all active grants issued by the current user — grouped shape (one grant, N audience rows).
app.get('/api/share/grants', authMiddleware, async (req, res) => {
    const issuedBy = req.headers['x-user-id'];
    try {
        const { rows: grants } = await db.query(
            `SELECT sg.grant_id, sg.root_node_id, sg.grant_type,
                    array_length(sg.child_node_ids, 1) AS node_count,
                    sg.issued_at, sg.expires_at, sg.status
             FROM share_grants sg
             WHERE sg.issued_by = $1 AND sg.status = 'active'
             ORDER BY sg.issued_at DESC`,
            [issuedBy]
        );

        if (grants.length === 0) return res.json([]);

        const grantIds = grants.map(g => g.grant_id);

        const { rows: audience } = await db.query(
            `SELECT ra.assignment_id, ra.resource_id AS grant_id,
                    ra.assignee_type, ra.assignee_id, ra.assignee_email, ra.status,
                    ra.assigned_at, ra.expires_at,
                    g.name AS group_name,
                    (SELECT COUNT(user_sub)::int FROM group_members WHERE group_id::text = ra.assignee_id) AS member_count
             FROM role_assignments ra
             LEFT JOIN groups g ON ra.assignee_type = 'group' AND g.group_id::text = ra.assignee_id
             WHERE ra.resource_type = 'grant' AND ra.resource_id = ANY($1) AND ra.status = 'active'`,
            [grantIds]
        );

        const { rows: pendingInv } = await db.query(
            `SELECT invitation_id, resource_id AS grant_id,
                    invited_email, invited_at, expires_at
             FROM invitations
             WHERE invitation_type = 'share' AND resource_id = ANY($1) AND status = 'pending'`,
            [grantIds]
        );

        const audienceByGrant = {};
        for (const row of audience) {
            if (!audienceByGrant[row.grant_id]) audienceByGrant[row.grant_id] = [];
            audienceByGrant[row.grant_id].push(row);
        }
        const pendingByGrant = {};
        for (const row of pendingInv) {
            if (!pendingByGrant[row.grant_id]) pendingByGrant[row.grant_id] = [];
            pendingByGrant[row.grant_id].push(row);
        }

        const result = grants.map(g => ({
            ...g,
            audience:        audienceByGrant[g.grant_id] || [],
            pending_audience: pendingByGrant[g.grant_id]  || [],
        }));

        res.json(result);
    } catch (err) {
        console.error('[GET /api/share/grants]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// List all pending invites issued by the current user (reads from pending_invites view)
app.get('/api/share/pending', authMiddleware, async (req, res) => {
    const issuedBy = req.headers['x-user-id'];
    try {
        const { rows } = await db.query(
            `SELECT invitation_id,
                    invitation_type        AS record_type,
                    invitation_id::text    AS id,
                    CASE WHEN invitation_type = 'share' THEN resource_id ELSE NULL END AS grant_id,
                    invitation_id::text    AS invitation_id_col,
                    CASE WHEN invitation_type = 'group' THEN resource_id ELSE NULL END AS group_id,
                    group_name,
                    invited_email          AS pending_email,
                    invited_at             AS issued_at,
                    expires_at,
                    grant_type,
                    node_count
             FROM pending_invites
             WHERE invited_by = $1
             ORDER BY invited_at DESC`,
            [issuedBy]
        );
        res.json(rows);
    } catch (err) {
        console.error('[GET /api/share/pending]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Resend invite email for a pending share invitation
app.post('/api/share/resend-invite/:grant_id', authMiddleware, async (req, res) => {
    const { grant_id } = req.params;
    const issuerSub = req.headers['x-raw-user-id'] || req.headers['x-user-id'];
    const issuedBy  = req.headers['x-user-id'];
    try {
        const { rows } = await db.query(
            `SELECT i.invited_email, sg.grant_type, sg.child_node_ids
             FROM invitations i
             JOIN share_grants sg ON sg.grant_id::text = i.resource_id
             WHERE i.resource_id = $1 AND i.invitation_type = 'share'
               AND i.status = 'pending' AND i.invited_by = $2
             LIMIT 1`,
            [grant_id, issuedBy]
        );
        if (!rows.length) return res.status(404).json({ error: 'Pending invitation not found' });
        const { invited_email, grant_type, child_node_ids } = rows[0];

        let sharerName = issuerSub;
        try {
            const issuer = await clerkClient.users.getUser(issuerSub);
            sharerName = `${issuer.firstName || ''} ${issuer.lastName || ''}`.trim()
                || issuer.emailAddresses?.[0]?.emailAddress || issuerSub;
        } catch { /* non-fatal */ }

        await sendClerkOrgInvitation(invited_email, sharerName);
        res.json({ ok: true });
    } catch (err) {
        console.error('[POST /api/share/resend-invite]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Cancel a pending share invitation
app.delete('/api/share/cancel-invite/:grant_id', authMiddleware, async (req, res) => {
    const { grant_id } = req.params;
    const issuedBy = req.headers['x-user-id'];
    try {
        const { rows } = await db.query(
            `UPDATE invitations SET status = 'cancelled'
             WHERE resource_id = $1 AND invitation_type = 'share'
               AND status = 'pending' AND invited_by = $2
             RETURNING invitation_id, invited_email`,
            [grant_id, issuedBy]
        );
        if (!rows.length) return res.status(404).json({ error: 'Pending invitation not found or already resolved' });
        for (const { invited_email } of rows) {
            removeFromClerkAllowlist(invited_email).catch(() => {});
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('[DELETE /api/share/cancel-invite]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/share/preview', guestTokenMiddleware, async (req, res) => {
    const nodeId = req.headers['x-guest-share-anchor'];
    if (!nodeId) return res.status(400).json({ error: 'Invalid or missing share token' });
    const tenantId = req.headers['x-tenant-id'] || '';
    const bentoUrl = process.env.BENTO_URL || 'http://localhost:8000';
    try {
        const resp = await fetch(`${bentoUrl}/get_node_details`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-tenant-id': tenantId,
                'x-user-id': 'guest-auth',
                'x-guest-share-anchor': nodeId,
            },
            body: JSON.stringify({ node_id: nodeId }),
        });
        const data = await resp.json();
        res.json(data);
    } catch (err) {
        console.error('[/api/share/preview]', err.message);
        res.status(500).json({ error: 'Failed to fetch node preview' });
    }
});

// --- LLM Orchestration Section ---

async function callMcpTool(tenantId, toolName, toolArgs, userId = '', schemaReadable = false, reqHeaders = {}) {
    console.log(`[GATEWAY] Calling MCP tool ${toolName} for tenant ${tenantId}, user ${userId}`);

    const toolCallId = Math.floor(Math.random() * 1000000);
    const initId = Math.floor(Math.random() * 1000000);

    // MCP server resolves allowed_ids from Redis directly — no x-allowed-ids header needed.
    const oidcToken = await getCloudRunToken(mcpServerUrl);
    const mcpHeaders = {
        "x-tenant-id": tenantId,
        "x-user-id": userId,
        "x-schema-readable": schemaReadable ? "true" : "false",
        "x-guest-share-anchor": reqHeaders['x-guest-share-anchor'] || '',
        ...(oidcToken ? { "Authorization": oidcToken } : {}),
    };

    const sseResponse = await fetch(`${mcpServerUrl}/sse`, { headers: mcpHeaders });

    if (!sseResponse.ok) {
        throw new Error(`Failed to connect to SSE: ${sseResponse.statusText}`);
    }

    return new Promise(async (resolve, reject) => {
        let absoluteEndpoint = null;
        let initialized = false;
        let buffer = '';
        const decoder = new TextDecoder();

        // 60 second timeout for the entire orchestration step
        const timeout = setTimeout(() => {
            reject(new Error(`Orchestration timeout calling ${toolName} after 60s`));
        }, 60000);

        const postJson = async (url, body) => {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...mcpHeaders },
                body: JSON.stringify(body)
            });
            return res;
        };

        try {
            console.log(`[GATEWAY] SSE Connection established.`);
            for await (const chunk of sseResponse.body) {
                buffer += decoder.decode(chunk, { stream: true });
                
                let lines = buffer.split(/\r?\n/);
                buffer = lines.pop(); // Keep partial line

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    
                    if (line.startsWith('event: endpoint')) {
                        // The data: line should be either the next line or still in the buffer
                        let dataLine = lines[i + 1] || buffer;
                        if (dataLine && dataLine.startsWith('data: ')) {
                            const relative = dataLine.replace('data: ', '').trim();
                            absoluteEndpoint = `${new URL(mcpServerUrl).origin}${relative.startsWith('/') ? '' : '/'}${relative}`;
                            console.log(`[GATEWAY] Discovered endpoint: ${absoluteEndpoint}. Initializing...`);
                            
                            await postJson(absoluteEndpoint, {
                                jsonrpc: "2.0",
                                id: initId,
                                method: "initialize",
                                params: {
                                    protocolVersion: "2024-11-05",
                                    capabilities: {},
                                    clientInfo: { name: "Cortex-Gateway", version: "1.0.0" }
                                }
                            });
                        }
                    }

                    if (line.startsWith('data: ') && line.includes(`"id":${initId}`)) {
                        console.log(`[GATEWAY] MCP Initialized response received. Sending notification.`);
                        initialized = true;
                        
                        // Send notifications/initialized
                        await postJson(absoluteEndpoint, {
                            jsonrpc: "2.0",
                            method: "notifications/initialized"
                        });

                        console.log(`[GATEWAY] Handshake complete. Calling tool: ${toolName}`);
                        // Send actual tool call
                        await postJson(absoluteEndpoint, {
                            jsonrpc: "2.0",
                            id: toolCallId,
                            method: "tools/call",
                            params: {
                                name: toolName,
                                arguments: toolArgs
                            }
                        });
                    }

                    if (line.startsWith('data: ') && (line.includes(`"id":${toolCallId}`) || (line.includes(`"result"`) && line.includes(`"id":${toolCallId}`)))) {
                        const jsonStr = line.replace('data: ', '').trim();
                        try {
                            const msg = JSON.parse(jsonStr);
                            console.log(`[GATEWAY] SUCCESS: Received tool result for ${toolName}`);
                            clearTimeout(timeout);
                            resolve(msg);
                            return; 
                        } catch (e) {
                            console.error("[GATEWAY] Error parsing tool result JSON:", e.message);
                            // If we fail to parse, it might be a raw string error. 
                            // Wrap it so the UI doesn't crash on SyntaxError.
                            clearTimeout(timeout);
                            resolve({
                                jsonrpc: "2.0",
                                id: toolCallId,
                                result: {
                                    content: [{ type: "text", text: JSON.stringify({ error: `Backend returned invalid JSON: ${jsonStr.substring(0, 100)}...` }) }]
                                }
                            });
                            return;
                        }
                    }
                }
            }
        } catch (err) {
            clearTimeout(timeout);
            console.error(`[GATEWAY] Orchestration Error for ${toolName}:`, err.message);
            reject(err);
        }
    });
}

const mcpToolsDefinitions = [
    {
        type: "function",
        function: {
            name: "get_context",
            description: "Gets the context for how to use & access podcast episode data. Always run this first.",
            parameters: { type: "object", properties: {}, required: [] }
        }
    },
    {
        type: "function",
        function: {
            name: "get_tool_statistics",
            description: "Get statistics about episodes in the database (total episodes, topics, chunks, etc.).",
            parameters: { type: "object", properties: {}, required: [] }
        }
    },
    {
        type: "function",
        function: {
            name: "find_episodes_by_people",
            description: "Search for episodes that feature specific people (hosts, guests, or listeners).",
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string", description: "The name or partial name of the person to search for." }
                },
                required: ["question"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "find_episodes_by_concept",
            description: "Search for episodes that discuss specific concepts or ideas.",
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string" }
                },
                required: ["question"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "find_episodes_by_topic",
            description: "Search for episodes that contain specific topics or keywords.",
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string" }
                },
                required: ["question"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "find_episodes_by_technology",
            description: "Search for episodes that discuss specific technologies or tools.",
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string" }
                },
                required: ["question"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "find_episodes_by_reference",
            description: "Find episodes with reference links containing a specific string.",
            parameters: {
                type: "object",
                properties: {
                    reference_string: { type: "string" }
                },
                required: ["reference_string"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "find_episodes_by_mentions",
            description: "Find episodes mentioning a search term in their reference links.",
            parameters: {
                type: "object",
                properties: {
                    search_terms: { type: "string" }
                },
                required: ["search_terms"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "search_episodes_gds_by_question_tool",
            description: "Advanced semantic search combining vector search with Graph Data Science (GDS). Use this for any complex questions.",
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string" },
                    k: { type: "integer", default: 5 },
                    limit: { type: "integer", default: 10 }
                },
                required: ["question"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "search_episodes_by_question_tool",
            description: "Search for relevant episodes using vector similarity search on chunk embeddings. Returns actual transcript text (chunks). Use this for summarization, detailed questions, or specific quotes.",
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string" },
                    k: { type: "integer", default: 5 }
                },
                required: ["question"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_people_by_episode_tool",
            description: "Find all people (hosts, guests, etc.) associated with a specific episode. Use this when you have an episode and need to know who the guest or host is.",
            parameters: {
                type: "object",
                properties: {
                    episode_name: { type: "string" }
                },
                required: ["episode_name"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "hybrid_discovery_tool",
            description: "Advanced Native Hybrid Search (GraphRAG). Finds relevant chunks via vector search and automatically enriches them with Episode metadata and Participant names (Hosts/Guests) from the graph. Use this for general content questions.",
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string", description: "The semantic query or question to search for." },
                    k: { type: "integer", default: 5 }
                },
                required: ["question"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "run_cypher_query",
            description: "Execute a raw Cypher query against the Neo4j graph. Use this for surgical precision, complex joins, or counting nodes (e.g., 'How many episodes?'). Always include 'WHERE n.tenant_id = $tenant_id'.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "The Cypher query string." }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_node_details",
            description: "Fetch all properties and labels for a specific node by its 'name'. Use this to 'enrich' your knowledge of an entity once you have its name from a search.",
            parameters: {
                type: "object",
                properties: {
                    node_name: { type: "string", description: "The 'name' property of the node." }
                },
                required: ["node_name"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "search_enterprise_graph",
            description: "Search for entities across the Universal Enterprise Graph, explicitly crossing boundaries between domains (Podcast/Resume/Federated). Use this for broad technical discovery or background checks.",
            parameters: {
                type: "object",
                properties: {
                    keyword: { type: "string", description: "The search term to find across the graph (e.g., 'startup', 'Iceberg', 'Kafka')." },
                    domain_intent: { type: "string", enum: ["all", "professional", "podcast", "federated"], default: "all", description: "The domain sandbox to search within." },
                    wants_visual_map: { type: "boolean", description: "Set to true if the user asks for a map, graph, overview, or visual landscape." }
                },
                required: ["keyword"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_cluster_context",
            description: "Fetch the semantic neighbors and relationships for a specific node to expand the graph view. Use this for DIRECTED AUTONOMY to proactively discover related context.",
            parameters: {
                type: "object",
                properties: {
                    node_name: { type: "string", description: "The 'name' property of the seed node." },
                    depth: { type: "integer", default: 1, description: "Traverse distance (1 or 2)." }
                },
                required: ["node_name"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "explore_graph_schema",
            description: "Introspect the Neo4j database to find exactly what Node Labels and Relationships exist. Call this tool whenever you don't know the exact schema needed to write a Cypher query.",
            parameters: {
                type: "object",
                properties: {}
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_episodes_with_cast",
            description: "List all available podcast episodes along with their hosts and guests. Use this for broad discovery of the podcast catalog and identifying participants.",
            parameters: { type: "object", properties: {}, required: [] }
        }
    },
    {
        type: "function",
        function: {
            name: "query_relevant_chunks_hybrid_tool",
            description: "High-Fidelity search for specific context or 'deep' knowledge within podcast transcripts. Use this when the user asks content questions (e.g. 'What did X say about Y?'). It combines keyword precision with conceptual depth.",
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string", description: "The natural language question or topic to search for." },
                    top_k: { type: "integer", default: 10, description: "Number of candidate chunks to retrieve for fusion." }
                },
                required: ["question"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "connect_knowledge_on_demand",
            description: `Discover virtual cross-domain knowledge bridges for a specific node WITHOUT writing to Neo4j. Finds the shortest weighted path from the source node to each candidate node in the target domain — every relationship type is eligible (no relationship-type whitelist), so the source can be a ThoughtLeadership piece, a Company, a Person, a Project, etc. Path weight penalizes traversal through high-degree hub nodes, so prefer a specific, well-connected source (e.g. a ThoughtLeadership node from search_enterprise_graph) over a broad one (e.g. a Company) when one is available — the bridge is more likely to rank near the top of the results. source_node_name accepts a partial/paraphrased name (CONTAINS fallback), not just an exact match. If the user's question names a specific target (a project, system, or company by name — e.g. "...to the zero-trust architecture of Cortex-Drive"), pass that name as target_node_name so it's guaranteed to appear in the results even if it wouldn't otherwise rank near the top. Returns session-only ghost links rendered as GOLD DASHED connections in the graph.`,
            parameters: {
                type: "object",
                properties: {
                    source_node_name: { type: "string", description: "The name of the source node to find bridges from." },
                    source_node_id: { type: "string", description: "The node_id (UUID, preferred) or elementId of the source node (optional, use with source_node_name)." },
                    target_domain: { type: "string", enum: ["podcast", "professional", "all"], default: "all", description: "The domain to search for bridge targets in." },
                    min_anchors: { type: "integer", default: 1, description: "Accepted for backward compatibility; no longer used (bridges are single weighted paths, not anchor-count matches)." },
                    limit: { type: "integer", default: BRIDGE_DEFAULT_LIMIT, description: `Max number of bridge targets to return. Default ${BRIDGE_DEFAULT_LIMIT} (env-var configurable), capped at ${BRIDGE_MAX_LIMIT}.` },
                    target_node_name: { type: "string", description: "If the user's question names a specific target node (a project, system, or company by name), pass its name here so it's guaranteed to be included in the results." }
                },
                required: ["source_node_name"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "infer_context_on_demand",
            description: `Explain WHY a node matters by reciting its structural position in the graph — which relationships it participates in, the named entities on the other end (with types and dates), and how central it is. Use when a node has no authored narrative or description, or when the user asks "why does this matter", "why did this come up", "what is this connected to". Returns FACTS ONLY, no interpretation: cite context_summary and phrase it naturally, but state nothing not present in the result. Reads only — writes nothing to Neo4j and renders nothing new on the graph. Distinct from connect_knowledge_on_demand: that tool answers cross-domain "how does A relate to B" (multi-hop, gold dashed bridge lines); this tool answers single-node "what is A and why is it here" (1-hop, renders nothing new).`,
            parameters: {
                type: "object",
                properties: {
                    node_name: { type: "string", description: "The name of the node to explain." },
                    node_id:   { type: "string", description: "The node_id or element_id of the node (optional, use with node_name)." },
                    query_context: { type: "string", description: "The user's original question, verbatim." }
                },
                required: ["node_name"]
            }
        }
    }
];

/**
 * HR Security Policy: Whitelist of labels safe for Guest/Trial traversal.
 */
const HR_SAFE_LABELS = [
    'Category', 'Project', 'Role', 'Hackathon', 'ThoughtLeadership', 
    'Achievement', 'Outcome', 'Company', 'Person', 'Education', 
    'Certification', 'OpenSource', 'SocialLearning', 'Publication'
];

/**
 * Security Middleware to enforce HR-Safe boundaries for Guest users.
 */
const securityMiddleware = (req, res, next) => {
    const userId = req.headers['x-user-id'];
    const isGuest = userId === 'trial-user';

    if (isGuest) {
        req.securityPrompt = "\n" + gatewaySecurityPrompt;
    }
    next();
};

// --- Conversation History Endpoints ---
// Private to the creating user — gated by a plain user_sub match, not routed through
// Permify (this is personal chat transcript data, not a shareable knowledge-graph node).
// Delete is soft delete (status='deleted' + deleted_at), matching share_grants/
// role_assignments/invitations elsewhere in this schema. See migration 008 and
// documents/architecture/security-and-auth-architecture-diagram-2026-07-27.md.

/**
 * Best-effort persistence of one chat turn. Never throws into the caller — a Cloud SQL
 * write failure must not prevent the chat response from reaching the user. Call without
 * awaiting; callers attach a .catch() for logging only.
 */
async function persistConversationTurn({ tenantId, userId, conversationId, userContent, assistantContent, domainSignal, graphSnapshot }) {
    if (!conversationId || !userId || !tenantId) return;
    await db.query(
        `INSERT INTO conversations (conversation_id, org_id, user_sub, title)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (conversation_id) DO NOTHING`,
        [conversationId, tenantId, userId, (userContent || '').slice(0, 60)]
    );
    await db.query(
        `INSERT INTO conversation_messages (conversation_id, role, content)
         VALUES ($1, 'user', $2), ($1, 'assistant', $3)`,
        [conversationId, userContent || '', assistantContent || '']
    );
    await db.query(
        `UPDATE conversations
         SET updated_at = now(), domain_signal = $2, latest_graph_snapshot = $3
         WHERE conversation_id = $1 AND status = 'active'`,
        [conversationId, domainSignal || null, graphSnapshot ? JSON.stringify(graphSnapshot) : null]
    );
}

app.get('/api/conversations', authMiddleware, async (req, res) => {
    const tenantId = req.headers['x-tenant-id'];
    const userId = req.headers['x-user-id'];
    try {
        const { rows } = await db.query(
            `SELECT c.conversation_id, c.title, c.updated_at,
                    (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = c.conversation_id)::int AS message_count,
                    (SELECT m.content FROM conversation_messages m
                     WHERE m.conversation_id = c.conversation_id AND m.role = 'user'
                     ORDER BY m.created_at DESC LIMIT 1) AS last_question
             FROM conversations c
             WHERE c.user_sub = $1 AND c.org_id = $2 AND c.status = 'active'
             ORDER BY c.updated_at DESC`,
            [userId, tenantId]
        );
        res.json(rows);
    } catch (err) {
        console.error('[/api/conversations]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/conversations/:id', authMiddleware, async (req, res) => {
    const userId = req.headers['x-user-id'];
    try {
        const { rows: convRows } = await db.query(
            `SELECT conversation_id, title, domain_signal, latest_graph_snapshot, created_at, updated_at
             FROM conversations
             WHERE conversation_id = $1 AND user_sub = $2 AND status = 'active'`,
            [req.params.id, userId]
        );
        if (convRows.length === 0) return res.status(404).json({ error: 'Conversation not found' });

        const { rows: messages } = await db.query(
            `SELECT role, content, created_at
             FROM conversation_messages
             WHERE conversation_id = $1
             ORDER BY created_at ASC`,
            [req.params.id]
        );
        res.json({ ...convRows[0], messages });
    } catch (err) {
        console.error('[/api/conversations/:id]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/conversations/:id', authMiddleware, async (req, res) => {
    const userId = req.headers['x-user-id'];
    try {
        const { rowCount } = await db.query(
            `UPDATE conversations SET status = 'deleted', deleted_at = now()
             WHERE conversation_id = $1 AND user_sub = $2 AND status = 'active'`,
            [req.params.id, userId]
        );
        if (rowCount === 0) return res.status(404).json({ error: 'Conversation not found' });
        res.json({ ok: true });
    } catch (err) {
        console.error('[/api/conversations/:id delete]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * SSE Endpoint for the Frontend
 * This is the "Brain" of the system.
 */
app.get('/sse', guestTokenMiddleware, authMiddleware, async (req, res) => {
    const { query, conversationId } = req.query;
    const tenantId = req.headers['x-tenant-id'];
    const userId = req.headers['x-user-id'] || 'trial-user';

    if (!query) return res.status(400).send({ error: "Missing 'query' parameter" });

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };

    let isAborted = false;
    res.on('close', () => {
        // Only abort if the response hasn't been written yet — req.on('close') fires
        // prematurely when the HTTP client half-closes (sends FIN after request body)
        // while still waiting for the response. This guard prevents false aborts.
        if (!res.writableEnded) {
            console.log(`[SSE] Client disconnected before response. Aborting orchestration...`);
            isAborted = true;
        }
    });

    try {
        console.log(`[SSE] Starting orchestration for: ${query}`);

        // Seed Redis permission cache for this user before the orchestration loop starts.
        // MCP server reads from Redis on each tool call — no allowed_ids in headers.
        const { allowedIds, permVersion: _ssePV } = await resolveAndCachePermissions(userId, tenantId);
        const accessScope = allowedIds !== null && allowedIds.length === 0 ? 'restricted' : 'normal';
        console.log(`[FGA/SSE] access_scope=${accessScope} allowed_ids_count=${allowedIds !== null ? allowedIds.length : 'legacy'}`);

        let baseSystemPrompt = gatewaySystemPrompt.replace('{req_securityPrompt_replacement_token}', req.securityPrompt || '');
        if (accessScope === 'restricted') {
            baseSystemPrompt = 'NOTE: This query is executing with restricted node access. ' +
                'If you cannot find data, explicitly state that access is unavailable. ' +
                'Do not synthesize from prior knowledge.\n\n' + baseSystemPrompt;
        }
        const systemPrompt = baseSystemPrompt;
        let messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: query }
        ];

        let loopCount = 0;
        const MAX_LOOPS = 5;
        let graphNodes = [];
        let graphLinks = [];
        const sseSeenUrls = new Set(); // accumulate tool-result URLs for grounding audit
        let lastAuditedContent = ''; // last non-empty assistant text, for conversation-history persistence

        while (loopCount < MAX_LOOPS && !isAborted) {
            loopCount++;

            const response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: messages,
                tools: mcpToolsDefinitions,
                tool_choice: "auto",
            });

            const assistantMessage = response.choices[0].message;
            messages.push(assistantMessage);

            if (assistantMessage.content) {
                const audited = auditResponseUrls(assistantMessage.content, sseSeenUrls);
                lastAuditedContent = audited;
                sendEvent('chat_response', { content: audited });
            }

            if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                for (const toolCall of assistantMessage.tool_calls) {
                    const toolName = toolCall.function.name;
                    const toolArgs = JSON.parse(toolCall.function.arguments);
                    
                    console.log(`[SSE LOOP ${loopCount}] Executing ${toolName}`);
                    
                    try {
                        const mcpData = await callMcpTool(tenantId, toolName, toolArgs, userId, req.headers['x-schema-readable'] === 'true', req.headers);

                        // Extract text for LLM
                        let toolContent = JSON.stringify(mcpData);
                        if (mcpData.result && mcpData.result.content && mcpData.result.content[0]) {
                            toolContent = mcpData.result.content[0].text;
                        }

                        // GRAPH UPDATE LOGIC: If the tool returned nodes, update the UI
                        try {
                            const parsed = JSON.parse(toolContent);
                            // Accumulate tool-result URLs for grounding audit (AP-15).
                            extractToolUrls(parsed).forEach(u => sseSeenUrls.add(u));
                            let newNodesRaw = [];
                            let newLinksRaw = [];

                            if (parsed.nodes) {
                                newNodesRaw = parsed.nodes;
                                newLinksRaw = parsed.links || [];
                            } else if (Array.isArray(parsed)) {
                                // Handle flat array or array of {details: ...}
                                newNodesRaw = parsed.map(item => item.details || item);
                            }

                            if (newNodesRaw.length > 0) {
                                // Transform to UI format
                                const uiNodes = newNodesRaw.map(n => ({
                                    id: n.element_id || n.id || n.name,
                                    node_id: n.node_id,
                                    name: n.display_name || n.name,
                                    type: n.labels ? n.labels[0] : (n.type || 'Unknown'),
                                    isBackbone: n.is_backbone || false,
                                    isBentoEligible: n.is_bento_eligible || true
                                }));
                                
                                graphNodes = [...graphNodes, ...uiNodes];
                                // Dedup nodes by id
                                graphNodes = Array.from(new Map(graphNodes.map(n => [n.id, n])).values());

                                if (newLinksRaw.length > 0) {
                                    const uiLinks = newLinksRaw.map(l => ({
                                        source: l.source,
                                        target: l.target,
                                        type: l.type
                                    }));
                                    graphLinks = [...graphLinks, ...uiLinks];
                                    // Dedup links
                                    graphLinks = Array.from(new Map(graphLinks.map(l => [`${l.source}-${l.target}-${l.type}`, l])).values());
                                }

                                sendEvent('graph_update', { graph: { nodes: graphNodes, links: graphLinks } });
                            }
                        } catch (e) {
                            // Result wasn't a graph, just ignore
                        }

                        messages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            name: toolName,
                            content: buildLlmToolContent(toolName, toolContent)
                        });

                    } catch (err) {
                        console.error(`[GATEWAY] Tool call failed — ${toolName}:`, err.message);
                        messages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            name: toolName,
                            content: `Error: ${err.message}`
                        });
                    }
                }
                continue;
            } else {
                break;
            }
        }

        console.log(`[SSE] Finished orchestration.`);
        // Best-effort conversation history persistence — never blocks the response.
        // domainSignal is not classified on this endpoint (only /query calls classifyDomain());
        // persisted as null here rather than guessed.
        persistConversationTurn({
            tenantId, userId, conversationId,
            userContent: query,
            assistantContent: lastAuditedContent,
            domainSignal: null,
            graphSnapshot: graphNodes.length > 0 ? { nodes: graphNodes, links: graphLinks } : null
        }).catch(err => console.error('[CONV_HISTORY] persist failed (non-fatal):', err.message));
        res.end();

    } catch (err) {
        console.error("[SSE] Error:", err);
        sendEvent('error', { message: err.message });
        res.end();
    }
});


/**
 * Non-streaming Orchestration Endpoint
 * Used by the Dashboard for backward compatibility.
 */
app.post('/query', authMiddleware, async (req, res) => {
    const { question, history, forceRefresh, conversationId } = req.body;
    const tenantId = req.headers['x-tenant-id'];
    const userId = req.headers['x-user-id'] || 'trial-user';

    if (!question) return res.status(400).send({ error: "Missing 'question' in body" });

    let isAborted = false;
    res.on('close', () => {
        // Only abort if the response hasn't been written yet — req.on('close') fires
        // prematurely when the HTTP client half-closes (sends FIN after request body)
        // while still waiting for the response. This guard prevents false aborts.
        if (!res.writableEnded) {
            console.log(`[QUERY] Client disconnected before response. Aborting orchestration...`);
            isAborted = true;
        }
    });

    try {
        console.log(`[QUERY] Starting orchestration for: ${question}`);

        // Cache lookup — keyed per tenant AND user so permission-scoped responses are not shared.
        const cacheKey = crypto.createHash('sha256')
            .update(`${tenantId}:${userId}:${question.toLowerCase().trim()}`)
            .digest('hex');
        if (!forceRefresh) {
            const cached = semanticCache.get(cacheKey);
            if (cached) {
                console.log(`[QUERY] Cache hit — key ${cacheKey.slice(0, 8)}…`);
                return res.send(cached);
            }
        }

        // Seed Redis permission cache — MCP server reads from Redis per tool call.
        const { allowedIds, permVersion: _queryPV } = await resolveAndCachePermissions(userId, tenantId);
        const accessScope = allowedIds !== null && allowedIds.length === 0 ? 'restricted' : 'normal';
        console.log(`[FGA/QUERY] access_scope=${accessScope} allowed_ids_count=${allowedIds !== null ? allowedIds.length : 'legacy'} user=${userId}`);

        const domainSignal = await classifyDomain(question, openai);
        console.log(`[QUERY] domain_signal=${domainSignal}`);

        const domainInstruction = `\n\nCURRENT QUERY DOMAIN CONTEXT: ${domainSignal}\n` +
            `Respect this classification. ` +
            `For 'podcast': call query_relevant_chunks_hybrid_tool + search_enterprise_graph(domain_intent="podcast") — do NOT call get_cluster_context. ` +
            `For 'career': You MUST call search_enterprise_graph(domain_intent="professional", keyword=<specific topic from user query>) before answering — this is REQUIRED for ALL career queries including publications, projects, roles, companies, certifications, and conferences. Early stop is NOT allowed for career domain. Answering from prior knowledge without a tool call is a grounding violation. Do NOT call get_cluster_context. The backbone graph is auto-injected. ` +
            `For 'cross_domain': follow Tier 7 — search_enterprise_graph first to find ThoughtLeadership node names, then connect_knowledge_on_demand per node.`;

        const restrictionNote = accessScope === 'restricted'
            ? 'NOTE: This query is executing with restricted node access. If you cannot find data, explicitly state that access is unavailable. Do not synthesize from prior knowledge.\n\n'
            : '';
        const systemPrompt = restrictionNote + gatewaySystemPrompt.replace('{req_securityPrompt_replacement_token}', req.securityPrompt || '') + domainInstruction;
        let messages = [
            { role: "system", content: systemPrompt },
            ...(history || []),
            { role: "user", content: question }
        ];

        let loopCount = 0;
        const MAX_LOOPS = 5;

        // Accumulate graph data from ALL tool calls so every tool's nodes/links reach the UI.
        // Previously only the last tool's result was forwarded (Gap #1 fix).
        const accumulatedGraph = { nodes: [], links: [], virtual_links: [] };
        const seenNodeIds = new Set();
        const seenLinkKeys = new Set();
        const querySeenUrls = new Set(); // accumulate tool-result URLs for grounding audit (AP-15)
        let q2RankedNodes = null; // ranked node list captured from search_enterprise_graph for Q2 override
        let isTargetedCareer = false; // true when domainSignal=career but keyword ≠ "Sangeetha" (targeted lookup, not broad map)

        const mergeGraphData = (parsed) => {
            if (!parsed || typeof parsed !== 'object') return;
            const inNodes = parsed.nodes || (Array.isArray(parsed) ? parsed : []);
            const inLinks = parsed.links || [];
            const inVirtual = parsed.virtual_links || [];

            inNodes.forEach(n => {
                const id = n.element_id || n.id || n.name;
                if (id && !seenNodeIds.has(id)) {
                    seenNodeIds.add(id);
                    accumulatedGraph.nodes.push(n);
                }
            });
            [...inLinks, ...inVirtual].forEach(l => {
                const key = `${l.source}-${l.target}-${l.type || ''}`;
                if (l.source && l.target && !seenLinkKeys.has(key)) {
                    seenLinkKeys.add(key);
                    if (inVirtual.includes(l) || l.type === 'VIRTUAL_BRIDGE') {
                        accumulatedGraph.virtual_links.push(l);
                    } else {
                        accumulatedGraph.links.push(l);
                    }
                }
            });
        };

        while (loopCount < MAX_LOOPS && !isAborted) {
            loopCount++;

            const response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: messages,
                tools: mcpToolsDefinitions,
                tool_choice: "auto",
            });

            const assistantMessage = response.choices[0].message;
            messages.push(assistantMessage);

            if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                for (const toolCall of assistantMessage.tool_calls) {
                    const toolName = toolCall.function.name;
                    const toolArgs = JSON.parse(toolCall.function.arguments);

                    // Career domain: wants_visual_map=true returns backbone-only skeleton nodes
                    // (Category groupers), not Company/Role/Project content nodes. The Q2 writer
                    // needs content nodes; backbone visualization is handled by the auto-inject below.
                    if (domainSignal === 'career' && toolName === 'search_enterprise_graph' && toolArgs.wants_visual_map) {
                        toolArgs.wants_visual_map = false;
                        console.log('[QUERY] Career override: wants_visual_map→false for Q2 content fetch');
                    }

                    // Cross-domain bridge query-aware ranking (2026-07-23), and node-context
                    // inference query-aware ranking (2026-08-03): always supply the user's
                    // original question as query_context, overriding anything the LLM passed.
                    // Deterministic — doesn't depend on the LLM remembering to pass it, same
                    // rationale as the wants_visual_map override above (AP-20 pattern).
                    if (toolName === 'connect_knowledge_on_demand' || toolName === 'infer_context_on_demand') {
                        toolArgs.query_context = question;
                    }

                    console.log(`[QUERY LOOP ${loopCount}] Executing ${toolName}`, JSON.stringify(toolArgs));

                    try {
                        const mcpData = await callMcpTool(tenantId, toolName, toolArgs, userId, req.headers['x-schema-readable'] === 'true', req.headers);

                        let toolContent = JSON.stringify(mcpData);
                        if (mcpData.result && mcpData.result.content && mcpData.result.content[0]) {
                            toolContent = mcpData.result.content[0].text;
                        }

                        // Accumulate graph data from every tool that returns nodes/links
                        try {
                            const parsed = JSON.parse(toolContent);
                            mergeGraphData(parsed);
                            // Accumulate tool-result URLs for grounding audit (AP-15).
                            extractToolUrls(parsed).forEach(u => querySeenUrls.add(u));
                            // Domain guard: inclusion filter — only keep nodes in this domain's manifest.
                            // AP-3: manifest-driven, not exclusion lists. cross_domain passes all through.
                            const _allowedForDomain = DOMAIN_ALLOWED_TYPES[domainSignal];
                            if (_allowedForDomain) {
                                accumulatedGraph.nodes = accumulatedGraph.nodes.filter(n => _allowedForDomain.has(n.type));
                                // Also filter out-of-domain nodes from the LLM-facing summary.
                                // buildLlmToolContent reads parsed.nodes — without this, the LLM sees
                                // e.g. "Data Engineering Podcast (Podcast)" in a career-domain query.
                                if (parsed.nodes) {
                                    parsed.nodes = parsed.nodes.filter(n => _allowedForDomain.has(n.type));
                                    toolContent = JSON.stringify(parsed);
                                }
                            }
                            // Orphaned-Person filter (career domain only).
                            // Person is a shared label — podcast guests/hosts and career people both use it.
                            // Podcast guests reach career search results via [*0..2] taxonomy expansion
                            // through shared SYSTEM Concept/Technology nodes, but their podcast-domain
                            // edges (HOSTS, GUEST_ON, INTERVIEWED_BY → Episode) are stripped by the
                            // neighbor label filter (Episode not in career authorized labels), leaving
                            // them with zero edges. Sangeetha always has career-domain edges (HELD_ROLE,
                            // CURRENTLY_BUILDING, etc. → Role/Company/Project). Remove edgeless Person
                            // nodes — they are podcast guests that leaked through the taxonomy expansion.
                            if (domainSignal === 'career') {
                                const personNodes = accumulatedGraph.nodes.filter(n => n.type === 'Person');
                                if (personNodes.length > 0) {
                                    const linkedIds = new Set(
                                        accumulatedGraph.links.flatMap(l => [l.source, l.target])
                                    );
                                    const before = accumulatedGraph.nodes.length;
                                    accumulatedGraph.nodes = accumulatedGraph.nodes.filter(n =>
                                        n.type !== 'Person' || linkedIds.has(n.id || n.element_id)
                                    );
                                    const removed = before - accumulatedGraph.nodes.length;
                                    if (removed > 0) console.log(`[DOMAIN] Removed ${removed} orphaned Person node(s) (podcast guests) from career graph`);
                                }
                            }
                            // Capture ranked nodes for Q2 gateway response override.
                            // Q2 writer is for BROAD career map queries only (keyword="Sangeetha Ramadurai").
                            // Targeted career queries (keyword="InfoQ", "Cortex-Drive", etc.) must let
                            // the LLM answer directly from the specific tool result — firing Q2 for them
                            // produces the same generic 6-section career narrative regardless of the question.
                            // get_cluster_context is always Q2-eligible (backbone tool, only called for maps).
                            const isQ2Tool = (toolName === 'search_enterprise_graph' || toolName === 'get_cluster_context');
                            const isBroadCareerKeyword = toolName !== 'search_enterprise_graph' ||
                                (toolArgs.keyword || '').toLowerCase().includes('sangeetha');
                            if (isQ2Tool && !isBroadCareerKeyword && domainSignal === 'career') {
                                isTargetedCareer = true;
                            }
                            if (isQ2Tool && isBroadCareerKeyword && domainSignal === 'career' && parsed.nodes) {
                                const seenK = new Map();
                                parsed.nodes.forEach(n => {
                                    const key = `${n.name}::${n.type}`;
                                    if (!seenK.has(key) || (!seenK.get(key).description && n.description)) seenK.set(key, n);
                                });
                                q2RankedNodes = Array.from(seenK.values()).sort((a, b) => (b.temporal_boost || 0) - (a.temporal_boost || 0));
                            }
                        } catch (e) { /* non-graph tool result, skip */ }

                        messages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            name: toolName,
                            content: buildLlmToolContent(toolName, toolContent)
                        });

                    } catch (err) {
                        console.error(`[GATEWAY] Tool call failed — ${toolName}:`, err.message);
                        messages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            name: toolName,
                            content: `Error: ${err.message}`
                        });
                    }
                }
                continue;
            } else {
                // For career queries: auto-inject the backbone from get_cluster_context so the
                // graph visualizer still shows Sangeetha + Category backbone even though the LLM
                // didn't call the tool (per Q2 instructions to call only search_enterprise_graph).
                if (domainSignal === 'career' && accumulatedGraph.nodes.length > 0) {
                    try {
                        const backboneMcp = await callMcpTool(tenantId, 'get_cluster_context', {
                            node_name: 'Sangeetha Ramadurai',
                            backbone_only: true,
                            depth: 1,
                            domain: 'professional'
                        }, userId, false, {});
                        const backboneText = backboneMcp?.result?.content?.[0]?.text;
                        if (backboneText) {
                            const backboneParsed = JSON.parse(backboneText);
                            mergeGraphData(backboneParsed);
                            console.log('[QUERY] Auto-injected career backbone nodes:', backboneParsed.nodes?.length);
                        }
                    } catch (e) {
                        console.warn('[QUERY] Career backbone auto-inject failed (non-fatal):', e.message);
                    }
                }
                // Targeted career graph curation.
                // search_enterprise_graph returns 30-40 nodes via 2-hop taxonomy expansion.
                // Sending all of them with backboneOnly=false causes graph explosion.
                // For targeted queries (keyword ≠ "Sangeetha Ramadurai") we curate raw_data
                // to: answer node + its direct 1-hop neighbors + backbone (Person + Category).
                // The frontend renders this curated set (~5-10 nodes) without explosion.
                // The answer node carries highlighted:true so it renders with a visual cue.
                if (isTargetedCareer) {
                    const ANSWER_TYPE_PRIORITY = ['ThoughtLeadership', 'Publication', 'Project', 'Startup', 'Company', 'Hackathon', 'Certification'];
                    let answerNode = null;
                    for (const t of ANSWER_TYPE_PRIORITY) {
                        answerNode = accumulatedGraph.nodes.find(n => n.type === t);
                        if (answerNode) break;
                    }
                    if (answerNode) {
                        const answerId = answerNode.element_id || answerNode.id || answerNode.name;
                        // Collect IDs of nodes directly connected to the answer node (1 hop only)
                        const keep = new Set([answerId]);
                        accumulatedGraph.links.forEach(l => {
                            if (l.source === answerId) keep.add(l.target);
                            if (l.target === answerId) keep.add(l.source);
                        });
                        // Always keep backbone nodes (Person with name, Category) regardless of hop count.
                        // Person nodes with null/empty names are podcast co-authors or phantom references —
                        // they must not be kept here; the orphaned Person filter handles them separately.
                        accumulatedGraph.nodes.forEach(n => {
                            if (n.type === 'Category') {
                                keep.add(n.element_id || n.id || n.name);
                            } else if (n.type === 'Person' && n.name) {
                                keep.add(n.element_id || n.id || n.name);
                            }
                        });
                        // Filter to curated set; also strip noise types and null-named nodes.
                        const GRAPH_NOISE_TYPES = new Set(['Year', 'PreparatoryNote', 'Chunk', 'Source', '__MetaContext__']);
                        accumulatedGraph.nodes = accumulatedGraph.nodes.filter(n =>
                            keep.has(n.element_id || n.id || n.name) &&
                            !GRAPH_NOISE_TYPES.has(n.type) &&
                            n.name != null  // never send null-named nodes to the canvas
                        );
                        // Recompute kept IDs after noise removal, then filter links against actual nodes.
                        const finalIds = new Set(accumulatedGraph.nodes.map(n => n.element_id || n.id || n.name));
                        accumulatedGraph.links = accumulatedGraph.links.filter(l =>
                            finalIds.has(l.source) && finalIds.has(l.target)
                        );
                        // Mark the answer node for visual highlight in the graph
                        answerNode.highlighted = true;
                        console.log(`[QUERY] Targeted career graph: curated to ${accumulatedGraph.nodes.length} nodes (answer: ${answerNode.name})`);
                        console.log(`[QUERY] Curated nodes: ${accumulatedGraph.nodes.map(n => `${n.name}(${n.type})`).join(' | ')}`);
                    }
                }

                // Q2 Option A: section-based assembly. Gateway owns structure; writer calls own prose.
                // Six sections: Currently Building / Career Timeline / What She Built /
                // Thought Leadership / Hackathons / Education.
                // Writer calls: currently building items + top-1 past project (max 3 parallel).
                // Falls back to Option B (buildCareerMapResponse) if writer calls fail.
                let finalAnswer = assistantMessage.content;
                if (domainSignal === 'career' && q2RankedNodes && q2RankedNodes.length > 0) {
                    const contentNodes = q2RankedNodes.filter(n => CAREER_CHAT_NODE_TYPES.has(n.type));
                    if (contentNodes.length > 0) {
                        try {
                            const { currentlyBuilding, companies, projects, thoughtLeadership, hackathons, education } = groupNodesForQ2(contentNodes);

                            // Writer targets: all currently-building items + top-1 past project (capped at 3).
                            const writerTargets = [
                                ...currentlyBuilding,
                                ...(projects.length > 0 ? [projects[0]] : [])
                            ].filter(isWriterEligible).slice(0, 3);

                            // Pre-fetch PreparatoryNote narratives in parallel, then run writer calls.
                            const enriched = await Promise.all(writerTargets.map(async n => {
                                const bentoNarrative = await fetchNodeNarratives(n, tenantId, userId, req.headers['x-guest-share-anchor'] || '');
                                return bentoNarrative ? { ...n, text: bentoNarrative } : n;
                            }));
                            const writerResults = await Promise.all(enriched.map(n => buildQ2WriterCall(n, openai)));
                            const writerMap = new Map(enriched.map((n, i) => [n.name, writerResults[i]]));
                            console.log('[QUERY] Q2 Option A writer calls completed:', writerTargets.length, 'items total:', contentNodes.length);

                            const lines = ['## Institutional Memory Map'];

                            // --- Career Timeline: active ventures first, then past employers ---
                            if (currentlyBuilding.length > 0 || companies.length > 0) {
                                lines.push('', '---', '', '### Career Timeline');
                                currentlyBuilding.forEach(n => {
                                    const tl = nodeTimeline(n);
                                    const role = n.role ? ` · ${n.role}` : '';
                                    lines.push(`#### ${n.name}${role}${tl ? ` [${tl}]` : ''}`);
                                    lines.push('');
                                });
                                companies.forEach(n => {
                                    const tl = nodeTimeline(n);
                                    const role = n.role ? ` · ${n.role}` : '';
                                    lines.push(`#### ${n.name}${role}${tl ? ` [${tl}]` : ''}`);
                                    lines.push('');
                                });
                            }

                            // --- What She Built ---
                            if (projects.length > 0) {
                                lines.push('', '---', '', '### What She Built');
                                projects.forEach((n, i) => {
                                    const tl = nodeTimeline(n);
                                    lines.push(`#### ${n.name}${tl ? ` [${tl}]` : ''}`);
                                    if (i === 0) {
                                        const enrichedNode = enriched.find(e => e.name === n.name) || n;
                                        const rawNarrative = sanitizeNarrative(enrichedNode.text);
                                        // Guard: reject bento narratives that contain ### headers (structured docs)
                                        // to prevent section headings from leaking into prose output.
                                        const safeNarrative = rawNarrative && !rawNarrative.includes('###') ? rawNarrative : null;
                                        const prose = writerMap.get(n.name) || safeNarrative || '';
                                        const desc = prose || (n.description?.length > 10 ? n.description : '');
                                        if (desc) { lines.push(''); lines.push(desc); }
                                    } else if (n.description?.length > 10) {
                                        lines.push(''); lines.push(n.description);
                                    }
                                    nodeLinks(n).forEach(url => lines.push(`- ${url}`));
                                    lines.push('');
                                });
                            }

                            // --- Thought Leadership & Publications ---
                            if (thoughtLeadership.length > 0) {
                                lines.push('', '---', '', '### Thought Leadership & Publications');
                                thoughtLeadership.forEach(n => {
                                    const tl = nodeTimeline(n);
                                    lines.push(`#### ${n.name}${tl ? ` [${tl}]` : ''}`);
                                    if (n.description?.length > 10) { lines.push(''); lines.push(n.description); }
                                    nodeLinks(n).forEach(url => lines.push(`- ${url}`));
                                    lines.push('');
                                });
                            }

                            // --- Hackathons & Contributions ---
                            if (hackathons.length > 0) {
                                lines.push('', '---', '', '### Hackathons & Contributions');
                                hackathons.forEach(n => {
                                    const tl = nodeTimeline(n);
                                    lines.push(`- **${n.name}**${tl ? ` [${tl}]` : ''}`);
                                });
                            }

                            // --- Education & Certifications ---
                            if (education.length > 0) {
                                lines.push('', '---', '', '### Education & Certifications');
                                education.forEach(n => {
                                    const yr = n.year || n.endYear || n.startYear || '';
                                    lines.push(`- ${yr ? `[${yr}] ` : ''}**${n.name}**`);
                                });
                            }

                            finalAnswer = lines.join('\n');
                        } catch (e) {
                            console.warn('[QUERY] Q2 Option A failed, falling back to Option B:', e.message);
                            const fallback = buildCareerMapResponse(q2RankedNodes);
                            if (fallback) finalAnswer = fallback;
                        }
                    }
                }
                // Audit response for hallucinated URLs before sending.
                const auditedAnswer = auditResponseUrls(finalAnswer, querySeenUrls);

                // cross_domain: only bridge participants should reach the frontend.
                // When a bridge IS found, prune to virtual_link endpoints only.
                // When no bridge is found, clear entirely — the career/podcast backbone from
                // the intermediate search_enterprise_graph call must not pollute the canvas.
                if (domainSignal === 'cross_domain') {
                    if (accumulatedGraph.virtual_links.length > 0) {
                        const bridgeIds = new Set();
                        accumulatedGraph.virtual_links.forEach(l => {
                            if (l.source) bridgeIds.add(l.source);
                            if (l.target) bridgeIds.add(l.target);
                        });
                        accumulatedGraph.nodes = accumulatedGraph.nodes.filter(n => {
                            const id = n.element_id || n.id || n.name;
                            return bridgeIds.has(id);
                        });
                        accumulatedGraph.links = accumulatedGraph.links.filter(l =>
                            bridgeIds.has(l.source) && bridgeIds.has(l.target)
                        );
                    } else {
                        // No virtual bridge found — clear accumulated nodes so the canvas
                        // stays empty and matches the "no bridge" chat response.
                        accumulatedGraph.nodes = [];
                        accumulatedGraph.links = [];
                    }
                }

                const hasGraph = accumulatedGraph.nodes.length > 0;
                const responsePayload = {
                    answer: auditedAnswer,
                    raw_data: hasGraph ? JSON.stringify(accumulatedGraph) : null,
                    domain_signal: domainSignal,
                    is_targeted_career: isTargetedCareer,
                    access_scope: accessScope
                };
                // Cache the response for repeated identical questions (per-tenant, 24h TTL).
                if (auditedAnswer) {
                    semanticCache.set(cacheKey, responsePayload);
                    console.log(`[QUERY] Response cached — key ${cacheKey.slice(0, 8)}…`);
                }
                // Best-effort conversation history persistence — never blocks the response.
                persistConversationTurn({
                    tenantId, userId, conversationId,
                    userContent: question,
                    assistantContent: auditedAnswer,
                    domainSignal,
                    graphSnapshot: hasGraph ? accumulatedGraph : null
                }).catch(err => console.error('[CONV_HISTORY] persist failed (non-fatal):', err.message));
                return res.send(responsePayload);
            }
        }

        res.status(500).send({ error: "Maximum orchestration loops reached" });

    } catch (err) {
        console.error("[QUERY] Error:", err);
        res.status(500).send({ error: err.message });
    }
});


const bentoServerUrl = process.env.BENTO_SERVER_URL || 'http://localhost:8000';

// Bento Proxy (Fast Hydration)
const bentoProxy = createProxyMiddleware({
    target: bentoServerUrl,
    changeOrigin: true,
    pathRewrite: {
        '^/api': '',
    },
    onProxyReq: (proxyReq, req, res) => {
        if (req.headers['x-tenant-id']) proxyReq.setHeader('x-tenant-id', req.headers['x-tenant-id']);
        if (req.headers['x-user-id']) proxyReq.setHeader('x-user-id', req.headers['x-user-id']);
        // express.json() consumes the raw body stream before the proxy runs.
        // Re-write req.body onto the proxy request so the Bento server receives it.
        if (req.body && Object.keys(req.body).length > 0) {
            const bodyData = JSON.stringify(req.body);
            proxyReq.setHeader('Content-Type', 'application/json');
            proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
            proxyReq.write(bodyData);
        }
    }
});

// MCP Proxy (Standard Tools/SSE)
const mcpProxy = createProxyMiddleware({
    target: mcpServerUrl,
    changeOrigin: true,
    pathRewrite: {
        '^/api': '',
    },
    onProxyReq: (proxyReq, req, res) => {
        if (req.headers['x-tenant-id']) proxyReq.setHeader('x-tenant-id', req.headers['x-tenant-id']);
        if (req.headers['x-user-id']) proxyReq.setHeader('x-user-id', req.headers['x-user-id']);
    },
    ws: true,
});

// Direct MCP tool endpoints for frontend progressive disclosure.
// These MUST come before the mcpProxy catch-all — the SSE server has no REST routes.
const mcpToolEndpoint = (toolName) => async (req, res) => {
    const tenantId = req.headers['x-tenant-id'];
    const userId = req.headers['x-user-id'] || 'trial-user';
    try {
        const mcpData = await callMcpTool(tenantId, toolName, req.body, userId, req.headers['x-schema-readable'] === 'true', req.headers);
        let toolContent = JSON.stringify(mcpData);
        if (mcpData.result && mcpData.result.content && mcpData.result.content[0]) {
            toolContent = mcpData.result.content[0].text;
        }
        res.json({ content: [{ type: 'text', text: toolContent }] });
    } catch (err) {
        console.error(`[/api/${toolName}] ${err.message}`);
        res.status(500).json({ error: err.message });
    }
};

app.post('/api/get_cluster_context', authMiddleware, mcpToolEndpoint('get_cluster_context'));
app.post('/api/expand_node_topology', authMiddleware, mcpToolEndpoint('expand_node_topology'));
app.post('/api/connect_knowledge_on_demand', authMiddleware, mcpToolEndpoint('connect_knowledge_on_demand'));
app.post('/api/infer_context_on_demand', authMiddleware, mcpToolEndpoint('infer_context_on_demand'));

// Smart Routing — /api/get_node_details uses a direct fetch (not proxy) because
// app.use() strips the full mount path before the middleware sees req.url, so
// pathRewrite: {'^/api': ''} would match '/' → forward to bento root → 404.
app.post('/api/get_node_details', authMiddleware, async (req, res) => {
    const tenantId = req.headers['x-tenant-id'];
    const userId = req.headers['x-user-id'] || '';
    const guestShareAnchor = req.headers['x-guest-share-anchor'] || '';
    try {
        const bentoOidcToken = await getCloudRunToken(bentoServerUrl);
        const bentoResponse = await fetch(`${bentoServerUrl}/get_node_details`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-tenant-id': tenantId || '',
                'x-user-id': userId,
                ...(guestShareAnchor ? { 'x-guest-share-anchor': guestShareAnchor } : {}),
                ...(bentoOidcToken ? { Authorization: bentoOidcToken } : {}),
            },
            body: JSON.stringify(req.body),
            signal: AbortSignal.timeout(8000)
        });
        if (!bentoResponse.ok) {
            const text = await bentoResponse.text();
            return res.status(bentoResponse.status).send(text);
        }
        const data = await bentoResponse.json();
        res.json(data);
    } catch (err) {
        console.error('[/api/get_node_details]', err.message);
        res.status(500).json({ error: err.message });
    }
});
app.use('/api', authMiddleware, mcpProxy);

app.listen(port, () => {
    console.log(`Cortex Gateway listening at http://localhost:${port}`);
    console.log(`Smart Routing Active:`);
    console.log(`  -> /api/get_node_details -> ${bentoServerUrl}`);
    console.log(`  -> /api/* -> ${mcpServerUrl}`);
});
