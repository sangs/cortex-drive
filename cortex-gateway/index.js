const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createClerkClient } = require('@clerk/backend');
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

    // 1. Check for Clerk JWT (Primary Auth)
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
            const decoded = await clerkClient.verifyToken(token);
            req.headers['x-tenant-id'] = decoded.sub;
            delete req.headers['authorization'];
            console.log('JWT Auth verified for tenant:', decoded.sub);
            return next();
        } catch (err) {
            console.error('JWT verification failed:', err.message);
        }
    }

    // 2. Check for Public API Key (Alternative Auth for Trials)
    if (apiKey) {
        const PUBLIC_TRIAL_KEY = process.env.PUBLIC_TRIAL_API_KEY || 'cortex_trial_key_2024';
        const TRIAL_TENANT_ID = process.env.PUBLIC_TRIAL_TENANT_ID || 'trial_user_001';

        if (apiKey === PUBLIC_TRIAL_KEY) {
            req.headers['x-tenant-id'] = TRIAL_TENANT_ID;
            console.log('Public Trial Access granted for tenant:', TRIAL_TENANT_ID);
            return next();
        }
    }

    return res.status(401).send({ error: 'Unauthorized: Missing or invalid authentication' });
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
                
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop(); // Keep partial line

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    
                    if (line.startsWith('event: endpoint')) {
                        const nextLine = lines[i + 1] || buffer;
                        if (nextLine && nextLine.startsWith('data: ')) {
                            const relative = nextLine.replace('data: ', '').trim();
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
                            resolve(msg);
                            return; 
                        } catch (e) {
                            console.error("[GATEWAY] Error parsing tool result JSON:", e.message);
                        }
                    }
                }
            }
        } catch (err) {
            console.error("[GATEWAY] SSE loop error:", err.message);
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
    }
];

app.post('/query', authMiddleware, async (req, res) => {
    const { question } = req.body;
    const tenantId = req.headers['x-tenant-id'];

    if (!question) {
        return res.status(400).send({ error: "Missing 'question' in request body" });
    }

    try {
        console.log(`Orchestrating query for tenant ${tenantId}: "${question}"`);

        const response = await openai.chat.completions.create({
            model: "gpt-4-turbo-preview",
            messages: [
                { 
                    role: "system", 
                    content: "You are the Cortex Brain Assistant. You have access to tools that search a knowledge graph of podcast episodes. " +
                             "Always prefer using tools to answer questions. If a tool returns no results, inform the user that no relevant information was found in the episodes. " +
                             "Do not use your internal knowledge to hallucinate episode contents." 
                },
                { role: "user", content: question }
            ],
            tools: mcpToolsDefinitions,
            tool_choice: "auto",
        });

        const message = response.choices[0].message;

        if (message.tool_calls) {
            const toolCall = message.tool_calls[0];
            const toolName = toolCall.function.name;
            const toolArgs = JSON.parse(toolCall.function.arguments);

            console.log(`LLM decided to call: ${toolName} with args:`, toolArgs);

            // Execute tool via session-aware helper
            const mcpData = await callMcpTool(tenantId, toolName, toolArgs);
            console.log(`Tool ${toolName} returned result.`);

            // Extract the actual text content from the MCP response
            let toolContent = JSON.stringify(mcpData);
            if (mcpData.result && mcpData.result.content && mcpData.result.content[0]) {
                toolContent = mcpData.result.content[0].text;
            }
            
            console.log(`[GATEWAY] Passing to LLM (Tool Content): ${toolContent.substring(0, 500)}...`);

            // Final synthesis
            const secondResponse = await openai.chat.completions.create({
                model: "gpt-4-turbo-preview",
                messages: [
                    { role: "user", content: question },
                    message,
                    {
                        role: "tool",
                        tool_call_id: toolCall.id,
                        name: toolName,
                        content: toolContent
                    }
                ]
            });

            return res.send({ 
                answer: secondResponse.choices[0].message.content, 
                tool_used: toolName,
                raw_data: toolContent 
            });
        }

        return res.send({ answer: message.content });
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
