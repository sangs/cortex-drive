const express = require('express');
const fs = require('fs');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');

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

app.use(cors());

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
            
            // Prioritize: 1. Org from token, 2. Default Org from env, 3. User sub from token
            const tenantId = decoded.org_id || process.env.TENANT_ID || decoded.sub;
            console.log(`[AUTH] Resolved Tenant ID: ${tenantId} (Primary: ${!!decoded.org_id}, Fallback: ${!decoded.org_id})`);
            
            req.headers['x-tenant-id'] = tenantId;
            // Forward the individual user ID so the MCP server can identify the owner
            req.headers['x-user-id'] = decoded.sub || '';
            
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
            req.headers['x-user-id'] = 'trial-user';  // Trial users are never owners
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

// --- LLM Orchestration Section ---

async function callMcpTool(tenantId, toolName, toolArgs, userId = '', schemaReadable = false, reqHeaders = {}) {
    console.log(`[GATEWAY] Calling MCP tool ${toolName} for tenant ${tenantId}, user ${userId}`);
    
    const toolCallId = Math.floor(Math.random() * 1000000);
    const initId = Math.floor(Math.random() * 1000000);
    
    const sseResponse = await fetch(`${mcpServerUrl}/sse`, {
        headers: { 
            "x-tenant-id": tenantId, 
            "x-user-id": userId,
            "x-schema-readable": schemaReadable ? "true" : "false",
            "x-guest-share-anchor": reqHeaders['x-guest-share-anchor'] || ''
        }
    });

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
                headers: { 
                    'Content-Type': 'application/json', 
                    'x-tenant-id': tenantId, 
                    'x-user-id': userId,
                    'x-schema-readable': schemaReadable ? "true" : "false",
                    'x-guest-share-anchor': reqHeaders['x-guest-share-anchor'] || ''
                },
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
    req.on('close', () => {
        console.log(`[SSE] Client disconnected. Aborting orchestration...`);
        isAborted = true;
    });

    try {
        console.log(`[SSE] Starting orchestration for: ${query}`);
        
        const systemPrompt = gatewaySystemPrompt.replace('{req_securityPrompt_replacement_token}', req.securityPrompt || '');
        let messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: query }
        ];

        let loopCount = 0;
        const MAX_LOOPS = 5;
        let graphNodes = [];
        let graphLinks = [];

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
                sendEvent('chat_response', { content: assistantMessage.content });
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
                            content: toolContent
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
    const { question, history, forceRefresh, is_contextual_fusion_on } = req.body;
    const tenantId = req.headers['x-tenant-id'];
    const userId = req.headers['x-user-id'] || 'trial-user';

    if (!question) return res.status(400).send({ error: "Missing 'question' in body" });

    let isAborted = false;
    req.on('close', () => {
        console.log(`[QUERY] Client disconnected. Aborting orchestration...`);
        isAborted = true;
    });

    try {
        console.log(`[QUERY] Starting orchestration for: ${question}`);
        
        const systemPrompt = gatewaySystemPrompt.replace('{req_securityPrompt_replacement_token}', req.securityPrompt || '');
        let messages = [
            { role: "system", content: systemPrompt },
            ...(history || []),
            { role: "user", content: question }
        ];

        let loopCount = 0;
        const MAX_LOOPS = 5;
        let lastToolData = null;

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
                    
                    console.log(`[QUERY LOOP ${loopCount}] Executing ${toolName}`);
                    
                    try {
                        const mcpData = await callMcpTool(tenantId, toolName, toolArgs, userId, req.headers['x-schema-readable'] === 'true', req.headers);
                        lastToolData = mcpData;

                        let toolContent = JSON.stringify(mcpData);
                        if (mcpData.result && mcpData.result.content && mcpData.result.content[0]) {
                            toolContent = mcpData.result.content[0].text;
                        }

                        messages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            name: toolName,
                            content: toolContent
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
                // No more tool calls, return the final answer
                return res.send({
                    answer: assistantMessage.content,
                    raw_data: lastToolData ? (lastToolData.result?.content?.[0]?.text || JSON.stringify(lastToolData)) : null
                });
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

// Smart Routing
app.use('/api/get_node_details', authMiddleware, bentoProxy);
app.use('/api', authMiddleware, mcpProxy);

app.listen(port, () => {
    console.log(`Cortex Gateway listening at http://localhost:${port}`);
    console.log(`Smart Routing Active:`);
    console.log(`  -> /api/get_node_details -> ${bentoServerUrl}`);
    console.log(`  -> /api/* -> ${mcpServerUrl}`);
});
