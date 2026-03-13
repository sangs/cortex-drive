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
            
            req.headers['x-tenant-id'] = tenantId;
            delete req.headers['authorization'];
            console.log('JWT Auth verified for tenant:', tenantId);
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
            console.log('Public Trial Access granted for tenant:', TRIAL_TENANT_ID);
            return next();
        } else {
            return res.status(401).send({ error: 'Unauthorized: Invalid API Key' });
        }
    }

    return res.status(401).send({ error: 'Unauthorized: Authentication required (JWT or API Key)' });
};

// --- LLM Orchestration Section ---

async function callMcpTool(tenantId, toolName, toolArgs) {
    console.log(`[GATEWAY] Calling MCP tool ${toolName} for tenant ${tenantId}`);
    
    const toolCallId = Math.floor(Math.random() * 1000000);
    const initId = Math.floor(Math.random() * 1000000);
    
    const sseResponse = await fetch(`${mcpServerUrl}/sse`, {
        headers: { "x-tenant-id": tenantId }
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
                headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
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
    }
];

app.post('/query', authMiddleware, async (req, res) => {
    const { question, history = [] } = req.body;
    const tenantId = req.headers['x-tenant-id'];

    if (!question) {
        return res.status(400).send({ error: "Missing 'question' in request body" });
    }

    try {
        // Prepare current context messages
        let currentMessages = [
            { 
                role: "system", 
                content: `You are the Cortex Brain Assistant. You are a Graph Agent with three tiers of reasoning:

TIERED REASONING STRATEGY:
1. TIER 1 (ATOMIC PRECISION): 
   - FOR COUNTS: Use 'get_tool_statistics' for high-level numbers.
   - FOR LISTS/ENUMERATION: Use 'run_cypher_query' to fetch lists of specific nodes (e.g., 'MATCH (e:Episode) RETURN e.name').
   - FOR FOLLOW-UPS: Use 'get_node_details("Entity Name")' once you have an entity name from a previous turn.
2. TIER 2 (HYBRID DISCOVERY): When the question is content-based ("What was said...") and you are discovering new information. USE 'hybrid_discovery_tool'. 
3. TIER 3 (SEMANTIC EXPLORATION): When exploring broad conceptual neighbors or looking for recommendations. USE 'search_episodes_gds_by_question_tool'.

CYPHER RULES:
- When using 'run_cypher_query', always include 'WHERE n.tenant_id = $tenant_id' in your patterns.
- Enumeration: If the user asks "What are the available episodes?" or "List the guests," you MUST enumerate them, not just give a count.
- Resolve all pronouns (this, they, that episode) by looking at conversation history.
- Formatting: Provide professional, markdown-formatted responses. Use **bold** for key terms and entity names.`
            },
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
        let lastToolResult = null;
        let toolUsed = null;

        while (loopCount < MAX_LOOPS) {
            loopCount++;
            
            const response = await openai.chat.completions.create({
                model: "gpt-4-turbo-preview",
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
                        const mcpData = await callMcpTool(tenantId, toolName, toolArgs);
                        
                        // Extract text content
                        let toolContent = JSON.stringify(mcpData);
                        if (mcpData.result && mcpData.result.content && mcpData.result.content[0]) {
                            toolContent = mcpData.result.content[0].text;
                        }
                        lastToolResult = toolContent;

                        currentMessages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            name: toolName,
                            content: toolContent
                        });
                    } catch (toolErr) {
                        console.error(`Tool ${toolName} failed:`, toolErr.message);
                        currentMessages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            name: toolName,
                            content: `Error calling tool: ${toolErr.message}`
                        });
                    }
                }
                continue; // LLM might want to call more tools
            } else {
                // Final synthesis complete
                return res.send({ 
                    answer: assistantMessage.content, 
                    tool_used: toolUsed,
                    raw_data: lastToolResult 
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
