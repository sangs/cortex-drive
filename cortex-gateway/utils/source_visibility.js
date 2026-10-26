'use strict';
/**
 * Visibility chosen when adding a source (S2-44 phase 3 / M5-11, 2026-10-26). Mirrors schema_guard.py
 * SOURCE_VISIBILITIES. Who may choose:
 *   private      → anyone allowed to add sources (default)
 *   organization → the owner or an organization admin (Clerk org:admin → x-schema-readable, gateway-set)
 *   public       → the platform owner only
 * The MCP tools check the same rule again (the /api proxy carries the MCP protocol).
 */
const SOURCE_VISIBILITIES = ['private', 'organization', 'public'];
const SOURCE_VISIBILITY_DEFAULT = 'private';

function createVisibilityGuard({ isOwner }) {
    return (req, res, next) => {
        const raw = req.body && req.body.visibility;
        const visibility = String(raw === undefined || raw === null || raw === '' ? SOURCE_VISIBILITY_DEFAULT : raw).toLowerCase();
        if (!SOURCE_VISIBILITIES.includes(visibility)) {
            return res.status(400).json({ error: `visibility must be one of ${SOURCE_VISIBILITIES.join(', ')}` });
        }
        const owner = isOwner(req.headers['x-user-id'] || '');
        const orgAdmin = req.headers['x-schema-readable'] === 'true';
        if (visibility === 'public' && !owner) {
            return res.status(403).json({ error: 'Only the platform owner can add a public source.' });
        }
        if (visibility === 'organization' && !owner && !orgAdmin) {
            return res.status(403).json({ error: 'Only an organization admin can add an organization-wide source.' });
        }
        req.body = { ...(req.body || {}), visibility };
        return next();
    };
}

module.exports = { SOURCE_VISIBILITIES, SOURCE_VISIBILITY_DEFAULT, createVisibilityGuard };
