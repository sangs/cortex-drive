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
function configured() { return !!process.env.PERMIFY_API_URL; }

// Fetch a fresh GCP OIDC token for cortex-permify (--no-allow-unauthenticated).
// Static PERMIFY_API_TOKEN env var takes precedence (local dev / override).
// Returns null in local dev (NODE_ENV !== 'production') so no auth header is sent.
async function _getToken() {
  if (process.env.PERMIFY_API_TOKEN) return `Bearer ${process.env.PERMIFY_API_TOKEN}`;
  if (process.env.NODE_ENV !== 'production') return null;
  try {
    const { GoogleAuth } = require('google-auth-library');
    const url = baseUrl();
    const client = await new GoogleAuth().getIdTokenClient(url);
    const h = await client.getRequestHeaders(url);
    return h.Authorization;
  } catch (e) {
    console.warn('[OIDC/Permify] token fetch failed:', e.message);
    return null;
  }
}

async function _post(path, body) {
  const url = `${baseUrl()}/v1/tenants/${tenant()}${path}`;
  const token = await _getToken();
  const h = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
  const resp = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
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
  return _post('/relationships/write', { metadata: { schema_version: '' }, tuples: [tuple] });
}

/**
 * Make a node visible to every member of the tenant org: ONE tenant_viewer tuple (subject org#member),
 * exactly as permify_utils.make_tenant_wide writes it. Replaces the OpenFGA write the Share dialog's
 * "whole organization" toggle used until 2026-10-21 (OpenFGA decommission, S2-37), which nothing read.
 */
async function makeNodeTenantWide(nodeId, tenantOrgId) {
  return _post('/relationships/write', { metadata: { schema_version: '' }, tuples: [{
    entity:   { type: 'node', id: nodeId },
    relation: 'tenant_viewer',
    subject:  { type: 'org', id: tenantOrgId, relation: 'member' },
  }] });
}

/**
 * Delete filters (S2-39, proven against Permify v1.7.1 on 2026-10-23):
 * /relationships/delete takes ONE `filter` whose entity/subject use `ids` LISTS. Permify silently
 * ignores unknown keys, so a singular `id` widens the delete to every tuple of that type (removing
 * one group member removed them all). /data/delete with `{tuples}` is rejected (400). Build every
 * delete with exactTupleFilter(), which refuses a missing id instead of widening.
 */
function exactTupleFilter(entityType, entityId, relation, subject) {
  if (!entityId || !relation || !subject || !subject.type || !subject.id) {
    throw new Error(`refusing an unscoped Permify delete (${entityType}:${entityId}#${relation})`);
  }
  const subjectFilter = { type: subject.type, ids: [String(subject.id)] };
  if (subject.relation) subjectFilter.relation = subject.relation;
  return { entity: { type: entityType, ids: [String(entityId)] }, relation, subject: subjectFilter };
}

/**
 * Permify subject for a share audience member (role_assignments row). Users are stored as the
 * bare Clerk id (`user_…`); before S2-39 that bare id was passed to a parser expecting "user:…",
 * which threw, and the throw was swallowed.
 */
function audienceSubject(assigneeType, assigneeId) {
  return assigneeType === 'group'
    ? { type: 'group', id: assigneeId, relation: 'member' }
    : { type: 'user', id: assigneeId };
}

/** Delete ONE access tuple on a node (revoke). Never delete parent tuples. Throws on failure. */
async function revokeNodeAccess(nodeId, subject, relation = 'shared_viewer') {
  return _post('/relationships/delete', { filter: exactTupleFilter('node', nodeId, relation, subject) });
}

/** Undo makeNodeTenantWide: remove the node's tenant_viewer tuple for the org (S2-40). */
async function removeNodeTenantWide(nodeId, tenantOrgId) {
  return revokeNodeAccess(nodeId, { type: 'org', id: tenantOrgId, relation: 'member' }, 'tenant_viewer');
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
    // tuple_filter {} matches no tuples but is required; attribute_filter needs `ids` + `attributes`.
    if (!nodeId) throw new Error('refusing an unscoped Permify attribute delete');
    return _post('/data/delete', {
      tuple_filter:     {},
      attribute_filter: { entity: { type: 'node', ids: [String(nodeId)] }, attributes: ['is_private'] },
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
  return data.entity_ids || [];
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

/** Write ONE shared_viewer tuple on a node for a group (group#member pattern). */
async function shareNodeWithGroup(nodeId, groupId, expiresAt = null) {
  const tuple = {
    entity:   { type: 'node', id: nodeId },
    relation: 'shared_viewer',
    subject:  { type: 'group', id: groupId, relation: 'member' },
  };
  if (expiresAt) tuple.required_conditions = { expires_at: expiresAt };
  return _post('/relationships/write', { metadata: { schema_version: '' }, tuples: [tuple] });
}

/** Add a user to a group in Permify (group:groupId#member @user:userSub). */
async function addGroupMember(groupId, userSub) {
  return _post('/relationships/write', {
    metadata: { schema_version: '' },
    tuples: [{
      entity:   { type: 'group', id: groupId },
      relation: 'member',
      subject:  { type: 'user', id: userSub },
    }],
  });
}

/** Remove a user from a group in Permify. */
async function removeGroupMember(groupId, userSub) {
  return _post('/relationships/delete', {
    filter: exactTupleFilter('group', groupId, 'member', { type: 'user', id: userSub }),
  });
}

/**
 * Organization membership tuples (org:<orgId>#member|admin @user). Written ONLY by
 * utils/org_membership_sync.js, which derives them from Clerk (S2-46, 2026-10-28).
 */
async function writeOrgRelation(orgId, relation, userId) {
  return _post('/relationships/write', {
    metadata: { schema_version: '' },
    tuples: [{ entity: { type: 'org', id: orgId }, relation, subject: { type: 'user', id: userId } }],
  });
}

async function deleteOrgRelation(orgId, relation, userId) {
  return _post('/relationships/delete', {
    filter: exactTupleFilter('org', orgId, relation, { type: 'user', id: userId }),
  });
}

/** Every org#member / org#admin tuple of one org, as [{ relation, userId }]. Pages through. */
async function listOrgRelations(orgId) {
  if (!orgId) throw new Error('refusing an unscoped org relationship read');
  const out = [];
  let token = '';
  do {
    const data = await _post('/data/relationships/read', {
      metadata:         { schema_version: '', snap_token: '' },
      filter:           { entity: { type: 'org', ids: [String(orgId)] }, relation: '' },
      page_size:        100,
      continuous_token: token,
    });
    for (const t of data.tuples || []) {
      if (t.subject && t.subject.type === 'user') out.push({ relation: t.relation, userId: t.subject.id });
    }
    token = data.continuous_token || '';
  } while (token);
  return out;
}

module.exports = {
  configured,
  writeOrgRelation,
  deleteOrgRelation,
  listOrgRelations,
  makeNodeTenantWide,
  removeNodeTenantWide,
  audienceSubject,
  exactTupleFilter,
  shareNodeWithUser,
  shareNodeWithGroup,
  addGroupMember,
  removeGroupMember,
  revokeNodeAccess,
  writePrivacyAttribute,
  checkPermission,
  listViewableNodeIds,
  listNodeAccess,
};
