const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createClerkClient, verifyToken } = require('@clerk/backend');
const cors = require('cors');
const OpenAI = require('openai');
require('dotenv').config();

// Ensure fetch is available globally (for orchestration)
if (!global.fetch) {
    global.fetch = require('node-fetch');
}

const app = express();
app.use(express.json()); // Handle JSON bodies for /query

const port = process.env.PORT || 3000;
const mcpServerUrl = process.env.MCP_SERVER_URL || 'http://localhost:8080';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

app.use(cors());

// Health check
app.get('/health', (req, res) => res.send({ status: 'ok' }));

// Auth Middleware
const authMiddleware = async (req, res, next) => {
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

// --- LLM Orchestration Section ---

async function callMcpTool(tenantId, toolName, toolArgs, userId = '', schemaReadable = false) {
    console.log(`[GATEWAY] Calling MCP tool ${toolName} for tenant ${tenantId}, user ${userId}`);
    
    const toolCallId = Math.floor(Math.random() * 1000000);
    const initId = Math.floor(Math.random() * 1000000);
    
    const sseResponse = await fetch(`${mcpServerUrl}/sse`, {
        headers: { 
            "x-tenant-id": tenantId, 
            "x-user-id": userId,
            "x-schema-readable": schemaReadable ? "true" : "false"
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
                    'x-schema-readable': schemaReadable ? "true" : "false"
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
            name: "search_resume_graph",
            description: "Search for entities across Sangeetha's Interactive Resume Graph. Use this whenever the user asks about professional background, projects, publications, startups, hackathons, certifications, or companies.",
            parameters: {
                type: "object",
                properties: {
                    keyword: { type: "string", description: "The search term to find across professional entities (e.g., 'startup', 'clerk', 'hackathon')." }
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
        req.securityPrompt = `\n[SECURITY POLICY] You are in HR-GUEST MODE. 
- Access is restricted to Public Professional Data only.
- DO NOT attempt to use 'run_cypher_query' or 'explore_graph_schema'.
- Use 'search_resume_graph' for all professional inquiries.
- ALL private STAR/Preparatory data is firewalled and inaccessible to you in this mode.`;
    }
    next();
};

app.post('/query', authMiddleware, securityMiddleware, async (req, res) => {
    const { question, history = [] } = req.body;
    const tenantId = req.headers['x-tenant-id'];
    const userId = req.headers['x-user-id'] || 'trial-user';
    console.log(`[QUERY] Processing question from User ${userId} for Tenant: ${tenantId}`);

    if (!question) {
        return res.status(400).send({ error: "Missing 'question' in request body" });
    }

    try {
        // Prepare current context messages
        const systemPrompt = `You are the Cortex Brain Assistant. You are a Graph Agent with four tiers of reasoning:
${req.securityPrompt || ''}

TIERED REASONING STRATEGY:
1. TIER 1 (ATOMIC PRECISION): 
   - FOR COUNTS: Use 'get_tool_statistics' for high-level numbers.
   - FOR PODCAST LISTS: Use 'get_episodes_with_cast' to list all episodes, hosts, and guests.
   - FOR OTHER LISTS: Use 'run_cypher_query' to fetch lists of specific nodes.
   - FOR FOLLOW-UPS: Use 'get_node_details("Entity Name")' once you have an entity name from a previous turn.
2. TIER 2 (HIGH-FIDELITY HYBRID SEARCH): When the user asks for specific knowledge, quotes, or deep insights from the podcast transcripts (e.g., "What was said about...", "How is X described?"). ALWAYS USE 'query_relevant_chunks_hybrid_tool' for these queries as it uses both keywords and concepts.
3. TIER 3 (GRAPH DISCOVERY): When exploring broad conceptual neighbors or looking for recommendations. USE 'search_episodes_gds_by_question_tool'.
4. TIER 4 (CAREER & RESUME): When the user asks about Sangeetha's professional background, resume, projects, startups, hackathons, certifications, companies, or publications. USE 'search_resume_graph'.
5. DIRECTED AUTONOMY (PROACTIVE EXPANSION): 
   - When the user identifies a core entity (Project, Episode, Person, Technology), do NOT just provide the text answer. 
   - Proactively call 'get_cluster_context(node_name)' to discover and render its local "solar system" of neighbors in the graph visualizer. 
   - Goal: The graph should grow autonomously based on the conversation context.

GRAPH SCHEMA AND ONTOLOGY:
You MUST dynamically discover the schema!
- If you need to map out podcast histories, open source projects, books, or any domain you are unsure of, use the \`explore_graph_schema()\` tool FIRST to fetch the active Neo4j ontology.
- Rely on that tool's output to construct perfect, hallucination-free Cypher queries.

CYPHER RULES:
- When using 'run_cypher_query', always include 'WHERE n.tenant_id = $tenant_id' in your patterns.
- Enumeration: If the user asks "What are the available episodes?" or "List the guests," you MUST enumerate them, not just give a count.
- Resolve all pronouns (this, they, that episode) by looking at conversation history.
- Formatting: Provide professional, markdown-formatted responses. Use **bold** for key terms and entity names. 
- REFERENCE LINKS: Every tool result (like 'search_resume_graph' or 'get_node_details') contains 'links', 'ReferenceLinks', or 'url' fields. You MUST explicitly include ALL of these as clickable Markdown links (e.g., [Link Text](https://...)) in your response for every entity mentioned. 
- FORMAT: For each project or role, provide its resources as a clear, bulleted list. Do NOT pick a "primary" link; list the entire collection.
- VISUAL TRIGGER: If the user asks for a "map", "graph", "overview", or "landscape" of a professional background or career, you MUST call 'get_cluster_context(node_name="Sangeetha Ramadurai")' in addition to the search tools. This ensures the Enterprise Graph visualizer is triggered for the user.
- PROFESSIONAL IMPACT: The 'text' field provided by the tools contains high-fidelity narrative context. You MUST include this information as the "Professional Impact" or "Why" for each project, ensuring the user gets the full context of the work.
- Chronology: Always list professional and academic milestones in **descending chronological order** (Newest first). Do NOT re-sort tool results alphabetically or oldest-first. Respect the order returned by the discovery tools.
- PRIVACY: When summarizing professional narratives, do NOT use the term 'STAR' or 'Preparatory Note.' Present the content as seamless professional experience.
- EXHAUSTIVENESS: When a discovery tool (like 'search_resume_graph') returns multiple professional entities (Hackathons, Projects, Roles), you MUST include and acknowledge ALL of them in your summary.
- NO HALLUCINATION: If a tool result is empty or shows "Metadata pending", report that honestly. Do not fill gaps with pre-trained knowledge about similar company names.
`;

        let currentMessages = [
            { role: "system", content: systemPrompt },
            ...history.map(m => {
                const msg = { role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
                if (m.tool_calls) msg.tool_calls = m.tool_calls;
                if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
                if (m.name) msg.name = m.name;
                return msg;
            }),
            { role: "user", content: question }
        ];

        let loopCount = 0;
        const MAX_LOOPS = 5;
        let aggregatedResults = [];
        let toolUsed = null;

        while (loopCount < MAX_LOOPS) {
            loopCount++;
            
            const response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: currentMessages,
                tools: mcpToolsDefinitions,
                tool_choice: "auto",
            });

            const assistantMessage = response.choices[0].message;
            currentMessages.push(assistantMessage);

            if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                console.log(`[LOOP ${loopCount}] calling ${assistantMessage.tool_calls.length} tools`);
                
                // Execute ALL tool calls in the message
                for (const toolCall of assistantMessage.tool_calls) {
                    const toolName = toolCall.function.name;
                    const toolArgs = JSON.parse(toolCall.function.arguments);
                    toolUsed = toolName; // Track last for UI simplicity

                    console.log(`  -> ${toolName} with args:`, toolArgs);
                    
                    try {
                        const mcpData = await callMcpTool(tenantId, toolName, toolArgs, userId, req.headers['x-schema-readable'] === 'true');
                        
                        // Extract text content
                        let toolContent = JSON.stringify(mcpData);
                        if (mcpData.result && mcpData.result.content && mcpData.result.content[0]) {
                            toolContent = mcpData.result.content[0].text;
                        }
                        
                        // PHASE 1: Reranking Consensus Layer for Hybrid Search
                        if (toolName === 'query_relevant_chunks_hybrid_tool') {
                            console.log(`[GATEWAY] Performing Reranking on Hybrid Search results...`);
                            const rawChunks = JSON.parse(toolContent);
                            
                            if (Array.isArray(rawChunks) && rawChunks.length > 0) {
                                const rerankPrompt = `You are a Search Reranker. Given the User Query and a list of Candidate Chunks, score each chunk from 0 to 10 based on how well it answers the query.
                                
Query: "${question}"

Candidates:
${rawChunks.map((c, i) => `[${i}] ${c.text.substring(0, 500)}`).join('\n\n')}

Return ONLY a JSON array of indices sorted by relevance, e.g. [2, 0, 1]. Only include indices for chunks with a score > 7.`;

                                const rerankResponse = await openai.chat.completions.create({
                                    model: "gpt-4o-mini",
                                    messages: [{ role: "system", content: rerankPrompt }],
                                    response_format: { type: "json_object" }
                                });
                                
                                const rerankData = JSON.parse(rerankResponse.choices[0].message.content);
                                const sortedIndices = Object.values(rerankData)[0]; // Extract the array
                                
                                if (Array.isArray(sortedIndices)) {
                                    const rerankedChunks = sortedIndices.map(idx => rawChunks[idx]).filter(Boolean);
                                    console.log(`[GATEWAY] Reranking complete. Selected ${rerankedChunks.length} high-fidelity chunks.`);
                                    toolContent = JSON.stringify(rerankedChunks);
                                }
                            }
                        }
                        
                        // AGGREGATION: Collect results for UI high-resolution rendering
                        aggregatedResults.push(toolContent);

                        currentMessages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            name: toolName,
                            content: toolContent
                        });
                    } catch (toolError) {
                        console.error(`Tool ${toolName} failed:`, toolError.message);
                        currentMessages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            name: toolName,
                            content: `Error calling tool: ${toolError.message}`
                        });
                    }
                }
                continue; // LLM might want to call more tools
            } else {
                // Final synthesis complete
                return res.send({ 
                    answer: assistantMessage.content, 
                    tool_used: toolUsed,
                    raw_data: JSON.stringify(aggregatedResults) 
                });
            }
        }

        return res.status(500).send({ error: "Maximum orchestration loops reached" });

    } catch (err) {
        console.error("LLM Query failed:", err);
        res.status(500).send({ error: "Internal server error during LLM orchestration", details: err.message });
    }
});

// Proxy middleware (retained for backward compatibility or direct SSE access)
const mcpProxy = createProxyMiddleware({
    target: mcpServerUrl,
    changeOrigin: true,
    pathRewrite: {
        '^/api': '',
    },
    onProxyReq: (proxyReq, req, res) => {
        if (req.headers['x-tenant-id']) {
            proxyReq.setHeader('x-tenant-id', req.headers['x-tenant-id']);
        }
    },
    ws: true,
});

// Apply auth to all /api routes
app.use('/api', authMiddleware, mcpProxy);

app.listen(port, () => {
    console.log(`Cortex Gateway listening at http://localhost:${port}`);
    console.log(`Proxying to MCP Server at ${mcpServerUrl}`);
    console.log(`Orchestration endpoint available at POST /query`);
});
