'use strict';
/**
 * OIDC token for Cloud Run service-to-service calls (AP-18: Bento is IAM-locked). One helper for the gateway, the
 * offboarding sweep and the daily maintenance job. Returns null outside production (local runs need none).
 */
async function getCloudRunToken(targetUrl, env = process.env) {
    if (env.NODE_ENV !== 'production') return null;
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

module.exports = { getCloudRunToken };
