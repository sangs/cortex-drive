const express = require('express');
const fs = require('fs');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { classifyDomain } = require('./utils/intent_classifier');

// Inclusion-based domain manifests (AP-3: single source of truth in config/domain_manifests.json).
const _domainManifestsRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'domain_manifests.json'), 'utf-8'));
const DOMAIN_ALLOWED_TYPES = {
    podcast: new Set(_domainManifestsRaw.podcast.node_types),
    career: new Set(_domainManifestsRaw.career.node_types),
};

// Tools that return large graph payloads — LLM only needs a compact summary.
// Full graph data is already accumulated in accumulatedGraph before truncation.
const GRAPH_HEAVY_TOOLS = new Set(['search_enterprise_graph', 'get_cluster_context', 'connect_knowledge_on_demand']);
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
async function fetchNodeNarratives(node, tenantId, userId) {
    const bentoBase = process.env.BENTO_SERVER_URL || 'http://localhost:8000';
    try {
        const bentoOidcToken = await getCloudRunToken(bentoBase);
        const res = await fetch(`${bentoBase}/get_node_details`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-tenant-id': tenantId,
                'x-user-id': userId || '',
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
const cors = require('cors');
const OpenAI = require('openai');
const NodeCache = require('node-cache');
require('dotenv').config();

// Initialize Semantic Cache (24h default TTL, check every 1h)
const semanticCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

// Ensure fetch is available globally (for orchestration)
if (!global.fetch) {
    global.fetch = require('node-fetch');
}

// --- OpenFGA Authorization Client ---
const { OpenFgaClient, CredentialsMethod } = require('@openfga/sdk');

let _fgaClient = null;
function getFgaClient() {
    if (_fgaClient) return _fgaClient;
    const storeId = process.env.OPENFGA_STORE_ID;
    if (!storeId) return null; // OpenFGA not configured — legacy mode
    _fgaClient = new OpenFgaClient({
        apiUrl: process.env.OPENFGA_API_URL || 'http://localhost:8082',
        storeId,
        authorizationModelId: process.env.OPENFGA_MODEL_ID,
    });
    return _fgaClient;
}

/**
 * Returns the list of node elementIds the user can see via OpenFGA.
 * Returns null when OpenFGA is not configured (triggers legacy tenant_id mode in MCP).
 */
async function getAllowedNodeIds(userId, agentSessionId = null) {
    const fga = getFgaClient();
    if (!fga) return null; // legacy mode — MCP uses tenant_id fallback

    const principal = agentSessionId ? `agent:${agentSessionId}` : `user:${userId}`;
    try {
        const resp = await fga.listObjects({
            user: principal,
            relation: 'can_view',
            type: 'node',
            context: { current_time: new Date().toISOString() },
        });
        // Decode OpenFGA object IDs back to Neo4j elementId format: '.' → ':'
        const ids = (resp.objects || []).map(o => o.replace('node:', '').replace(/\./g, ':'));
        console.log(`[FGA] ${principal} can_view ${ids.length} nodes`);
        return ids;
    } catch (err) {
        console.warn('[FGA] listObjects failed (non-fatal):', err.message);
        return null; // fall back to legacy mode on FGA errors
    }
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
app.use(express.json()); // Handle JSON bodies for /query

const port = process.env.PORT || 4000;
const mcpServerUrl = process.env.MCP_SERVER_URL || 'http://localhost:8080';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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
 */
const guestTokenMiddleware = (req, res, next) => {
    const token = req.query.share || req.headers['x-share-token'];
    
    if (token) {
        const verified = verifyShareToken(token);
        if (verified) {
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

/**
 * Endpoints
 */
app.get('/api/share', authMiddleware, (req, res) => {
    const { nodeId } = req.query;
    const tenantId = req.headers['x-tenant-id'];
    
    if (!nodeId) return res.status(400).send({ error: "Missing 'nodeId' for sharing" });
    
    const token = signShareToken(tenantId, nodeId);
    const shareUrl = `${req.protocol}://${req.get('host')}/discovery?share=${token}`;
    
    res.send({ 
        token, 
        shareUrl,
        expiresIn: '30 days',
        note: "This URL grants stateless 'read-only' access to the specified graph island."
    });
});

// --- OpenFGA Share Endpoints ---
// These are no-ops when OpenFGA is not configured (OPENFGA_STORE_ID unset).

app.post('/api/share/tenant-wide', authMiddleware, async (req, res) => {
    const { elementId } = req.body;
    const tenantId = req.headers['x-tenant-id'];
    if (!elementId) return res.status(400).json({ error: 'elementId required' });
    const fga = getFgaClient();
    if (!fga) return res.status(503).json({ error: 'OpenFGA not configured' });
    try {
        const { makeNodeTenantWide } = require('./utils/openfga_gateway');
        await makeNodeTenantWide(fga, elementId, tenantId);
        res.json({ ok: true });
    } catch (err) {
        console.error('[/api/share/tenant-wide]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/share/user', authMiddleware, async (req, res) => {
    const { elementId, targetSub, expiresAt } = req.body;
    if (!elementId || !targetSub) return res.status(400).json({ error: 'elementId and targetSub required' });
    const fga = getFgaClient();
    if (!fga) return res.status(503).json({ error: 'OpenFGA not configured' });
    try {
        const { shareNodeWithUser } = require('./utils/openfga_gateway');
        await shareNodeWithUser(fga, elementId, targetSub, expiresAt || null);
        res.json({ ok: true });
    } catch (err) {
        console.error('[/api/share/user]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/share/group', authMiddleware, async (req, res) => {
    const { elementId, groupId, expiresAt } = req.body;
    if (!elementId || !groupId) return res.status(400).json({ error: 'elementId and groupId required' });
    const fga = getFgaClient();
    if (!fga) return res.status(503).json({ error: 'OpenFGA not configured' });
    try {
        const { shareNodeWithGroup } = require('./utils/openfga_gateway');
        await shareNodeWithGroup(fga, elementId, groupId, expiresAt || null);
        res.json({ ok: true });
    } catch (err) {
        console.error('[/api/share/group]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/share/revoke', authMiddleware, async (req, res) => {
    const { elementId, subject, relation } = req.body;
    if (!elementId || !subject || !relation) return res.status(400).json({ error: 'elementId, subject, relation required' });
    const fga = getFgaClient();
    if (!fga) return res.status(503).json({ error: 'OpenFGA not configured' });
    try {
        const { revokeNodeAccess } = require('./utils/openfga_gateway');
        await revokeNodeAccess(fga, elementId, subject, relation);
        res.json({ ok: true });
    } catch (err) {
        console.error('[/api/share/revoke]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/share/access/:elementId', authMiddleware, async (req, res) => {
    const { elementId } = req.params;
    const fga = getFgaClient();
    if (!fga) return res.status(503).json({ error: 'OpenFGA not configured' });
    try {
        const { listNodeAccess } = require('./utils/openfga_gateway');
        const access = await listNodeAccess(fga, elementId);
        res.json(access);
    } catch (err) {
        console.error('[/api/share/access]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- LLM Orchestration Section ---

async function callMcpTool(tenantId, toolName, toolArgs, userId = '', schemaReadable = false, reqHeaders = {}, allowedIds = null) {
    console.log(`[GATEWAY] Calling MCP tool ${toolName} for tenant ${tenantId}, user ${userId}`);

    const toolCallId = Math.floor(Math.random() * 1000000);
    const initId = Math.floor(Math.random() * 1000000);

    // Build shared MCP headers — include OIDC token and allowed_ids for production
    const oidcToken = await getCloudRunToken(mcpServerUrl);
    const mcpHeaders = {
        "x-tenant-id": tenantId,
        "x-user-id": userId,
        "x-schema-readable": schemaReadable ? "true" : "false",
        "x-guest-share-anchor": reqHeaders['x-guest-share-anchor'] || '',
        ...(allowedIds !== null ? { "x-allowed-ids": JSON.stringify(allowedIds) } : {}),
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
            description: "Discover virtual cross-domain knowledge bridges for a specific ThoughtLeadership node WITHOUT writing to Neo4j. Finds nodes in another domain that share Technology, Topic, or Concept anchors. Uses Taxonomy Expansion (IS_A/SUB_TOPIC_OF) to resolve semantic gaps (e.g., 'AI Agent' -> 'AI'). Returns session-only ghost links rendered as GOLD DASHED connections in the graph. source_node_name MUST be a ThoughtLeadership node name obtained from search_enterprise_graph — never a Company, Role, Person, or paraphrased name.",
            parameters: {
                type: "object",
                properties: {
                    source_node_name: { type: "string", description: "The name of the source node to find bridges from." },
                    source_node_id: { type: "string", description: "The element_id of the source node (optional, use with source_node_name)." },
                    target_domain: { type: "string", enum: ["podcast", "professional", "all"], default: "all", description: "The domain to search for bridge targets in." },
                    min_anchors: { type: "integer", default: 1, description: "Minimum shared anchor count for a bridge to qualify." },
                    limit: { type: "integer", default: 5, description: "Max number of bridge targets to return." }
                },
                required: ["source_node_name"]
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

/**
 * SSE Endpoint for the Frontend
 * This is the "Brain" of the system.
 */
app.get('/sse', guestTokenMiddleware, authMiddleware, async (req, res) => {
    const { query } = req.query;
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

        // OpenFGA: compute allowed node IDs before any MCP call
        const allowedIds = await getAllowedNodeIds(userId);
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
                sendEvent('chat_response', { content: audited });
            }

            if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                for (const toolCall of assistantMessage.tool_calls) {
                    const toolName = toolCall.function.name;
                    const toolArgs = JSON.parse(toolCall.function.arguments);
                    
                    console.log(`[SSE LOOP ${loopCount}] Executing ${toolName}`);
                    
                    try {
                        const mcpData = await callMcpTool(tenantId, toolName, toolArgs, userId, req.headers['x-schema-readable'] === 'true', req.headers, allowedIds);

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
    const { question, history, forceRefresh } = req.body;
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

        // Cache lookup — keyed per tenant so tenants never share cached responses.
        const cacheKey = crypto.createHash('sha256')
            .update(`${tenantId}:${question.toLowerCase().trim()}`)
            .digest('hex');
        if (!forceRefresh) {
            const cached = semanticCache.get(cacheKey);
            if (cached) {
                console.log(`[QUERY] Cache hit — key ${cacheKey.slice(0, 8)}…`);
                return res.send(cached);
            }
        }

        // OpenFGA: compute allowed node IDs before any MCP call
        const allowedIds = await getAllowedNodeIds(userId);
        const accessScope = allowedIds !== null && allowedIds.length === 0 ? 'restricted' : 'normal';
        console.log(`[FGA/QUERY] access_scope=${accessScope} allowed_ids_count=${allowedIds !== null ? allowedIds.length : 'legacy'} user=${userId}`);

        const domainSignal = classifyDomain(question);
        console.log(`[QUERY] domain_signal=${domainSignal}`);

        const domainInstruction = `\n\nCURRENT QUERY DOMAIN CONTEXT: ${domainSignal}\n` +
            `Respect this classification. ` +
            `For 'podcast': call query_relevant_chunks_hybrid_tool + search_enterprise_graph(domain_intent="podcast") — do NOT call get_cluster_context. ` +
            `For 'career': call ONLY search_enterprise_graph(domain_intent="professional") — do NOT call get_cluster_context. The backbone graph is auto-injected. ` +
            `For 'cross_domain': follow Tier 7 — search_enterprise_graph first to find ThoughtLeadership node names, then connect_knowledge_on_demand per node. ` +
            `For 'unknown': use your judgment.`;

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

                    console.log(`[QUERY LOOP ${loopCount}] Executing ${toolName}`, JSON.stringify(toolArgs));

                    try {
                        const mcpData = await callMcpTool(tenantId, toolName, toolArgs, userId, req.headers['x-schema-readable'] === 'true', req.headers, allowedIds);

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
                            // Capture ranked nodes for Q2 gateway response override.
                            // Must be captured AFTER domain filter so only career nodes are included.
                            // Backstop: also capture from get_cluster_context in case the LLM ignores
                            // the Q2 instruction and calls the wrong tool — prevents silent fallback to
                            // generic hallucinated answer.
                            const isQ2Tool = (toolName === 'search_enterprise_graph' || toolName === 'get_cluster_context');
                            if (isQ2Tool && domainSignal === 'career' && parsed.nodes) {
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
                        }, userId, false, {}, allowedIds);
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
                                const bentoNarrative = await fetchNodeNarratives(n, tenantId, userId);
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
                    access_scope: accessScope
                };
                // Cache the response for repeated identical questions (per-tenant, 24h TTL).
                if (auditedAnswer) {
                    semanticCache.set(cacheKey, responsePayload);
                    console.log(`[QUERY] Response cached — key ${cacheKey.slice(0, 8)}…`);
                }
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

// Smart Routing — /api/get_node_details uses a direct fetch (not proxy) because
// app.use() strips the full mount path before the middleware sees req.url, so
// pathRewrite: {'^/api': ''} would match '/' → forward to bento root → 404.
app.post('/api/get_node_details', authMiddleware, async (req, res) => {
    const tenantId = req.headers['x-tenant-id'];
    const userId = req.headers['x-user-id'] || '';
    try {
        const bentoResponse = await fetch(`${bentoServerUrl}/get_node_details`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-tenant-id': tenantId || '',
                'x-user-id': userId
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
