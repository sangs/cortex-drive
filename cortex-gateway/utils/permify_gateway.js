'use strict';
/**
 * Permify REST API client for the gateway.
 *
 * Mirrors the functions in src/mcp_server/permify_utils.py for the Node.js layer.
 * Uses node-fetch for HTTP calls — already a gateway dependency.
 *
 * Env vars:
 *   PERMIFY_API_URL   — base URL of cortex-permify Cloud Run service
 *   PERMIFY_TENANT_ID — Permify tenant (default: "cortex-drive")
 *   PERMIFY_MAX_DEPTH — LookupEntity depth (default: 5)
 *   PERMIFY_API_TOKEN — OIDC bearer token for Cloud Run auth
 */

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

function baseUrl()  { return (process.env.PERMIFY_API_URL || 'http://localhost:3476').replace(/\/$/, ''); }
function tenant()   { return process.env.PERMIFY_TENANT_ID || 'cortex-drive'; }
function maxDepth() { return parseInt(process.env.PERMIFY_MAX_DEPTH || '5', 10); }
function headers()  {
  const h = { 'Content-Type': 'application/json' };
  if (process.env.PERMIFY_API_TOKEN) h['Authorization'] = `Bearer ${process.env.PERMIFY_API_TOKEN}`;
  return h;
}
function configured() { return !!process.env.PERMIFY_API_URL; }

async function _post(path, body) {
  const url = `${baseUrl()}/v1/tenants/${tenant()}${path}`;
  const resp = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Permify ${path} → ${resp.status}: ${text}`);
  }
  return resp.json();
}

/** Write ONE shared_viewer tuple on the root node. */
async function shareNodeWithUser(nodeId, targetSub, expiresAt = null) {
  const tuple = {
    entity:   { type: 'node', id: nodeId },
    relation: 'shared_viewer',
    subject:  { type: 'user', id: targetSub },
  };
  if (expiresAt) tuple.required_conditions = { expires_at: expiresAt };
  return _post('/data', { metadata: { schema_version: '' }, tuples: [tuple], attributes: [] });
}

/** Delete a shared_viewer tuple (revoke). Never delete parent tuples. */
async function revokeNodeAccess(nodeId, subject, relation) {
  const [subType, subRest] = subject.split(':');
  const subId  = subRest.split('#')[0];
  const subRel = subRest.includes('#') ? subRest.split('#')[1] : undefined;
  const subObj = { type: subType, id: subId };
  if (subRel) subObj.relation = subRel;
  return _post('/data/delete', {
    tuples: [{ entity: { type: 'node', id: nodeId }, relation, subject: subObj }],
  });
}

/** Write is_private=true attribute on a node. */
async function writePrivacyAttribute(nodeId, isPrivate) {
  if (isPrivate) {
    return _post('/data', {
      metadata:   { schema_version: '' },
      tuples:     [],
      attributes: [{
        entity:    { type: 'node', id: nodeId },
        attribute: 'is_private',
        value:     { '@type': 'type.googleapis.com/base.v1.BooleanValue', data: true },
      }],
    });
  } else {
    return _post('/data/delete', {
      attributes_filter: { entity: { type: 'node', id: nodeId }, attribute: 'is_private' },
    });
  }
}

/** Check if a user has a specific permission on a node. */
async function checkPermission(nodeId, userId, permission = 'can_view') {
  if (!configured()) return false;
  const data = await _post('/permissions/check', {
    metadata:   { depth: maxDepth(), schema_version: '', snap_token: '' },
    entity:     { type: 'node', id: nodeId },
    permission,
    subject:    { type: 'user', id: userId },
    context:    { tuples: [], attributes: [], data: {} },
  });
  return data.can === 'CHECK_RESULT_ALLOWED';
}

/** Return all node UUIDs visible to a user (LookupEntity with depth traversal). */
async function listViewableNodeIds(userId) {
  if (!configured()) return null;
  const data = await _post('/permissions/lookup-entity', {
    metadata:    { depth: maxDepth(), schema_version: '', snap_token: '' },
    entity_type: 'node',
    permission:  'can_view',
    subject:     { type: 'user', id: userId },
    context:     { tuples: [], attributes: [], data: {} },
  });
  return data.entityIds || [];
}

/** Return all relationship tuples for a node. */
async function listNodeAccess(nodeId) {
  if (!configured()) return [];
  const data = await _post('/data/relationships/read', {
    metadata:          { schema_version: '', snap_token: '' },
    filter:            { entity: { type: 'node', ids: [nodeId] }, relation: '' },
    page_size:         100,
    continuous_token:  '',
  });
  return (data.tuples || []).map(t => ({
    subject:  t.subject,
    relation: t.relation,
    entity:   t.entity,
  }));
}

module.exports = {
  configured,
  shareNodeWithUser,
  revokeNodeAccess,
  writePrivacyAttribute,
  checkPermission,
  listViewableNodeIds,
  listNodeAccess,
};
