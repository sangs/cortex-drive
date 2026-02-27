const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createClerkClient } = require('@clerk/backend');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const mcpServerUrl = process.env.MCP_SERVER_URL || 'http://localhost:8080';

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
            // Fall through to API key check
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

// Proxy middleware
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
});
