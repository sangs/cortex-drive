# Multi-Tenancy Implementation Plan (Iteration 2)

This plan outlines the transition to enterprise-grade multi-tenancy using **Clerk Organizations** and retroactive data tagging in Neo4j.

## User Review Required

> [!IMPORTANT]
> This approach requires manual intervention in the Clerk Dashboard to create Organizations and map users to them before they can access their data.

## Proposed Changes

### 1. External Configuration
- Create Organizations in Clerk Dashboard (e.g., "Seed Org").
- Retrieve the stable `org_id` (e.g., `org_2nb8...`).

### 2. Neo4j Data Migration
#### [MODIFY] Data Tagging Script
Execute a Cypher query to tag existing "brownfield" nodes with the new `org_id`.
```cypher
MATCH (n) 
WHERE n.tenant_id IS NULL OR n.tenant_id = 'test_tenant'
SET n.tenant_id = 'org_NEW_ID_HERE'
```

### 3. Server Implementation
#### [MODIFY] [cortex_os_mentalmodel_server_sse.py](file:///Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/cortex_os_mentalmodel_server_sse.py)
Update `TenantMiddleware` to extract `org_id` from the authenticated request.
- The Middleware will now look for `X-Clerk-Org-Id` header (passed by the Gateway after JWT validation).
- Sets `tenant_id_var` directly to the `org_id`.

#### [MODIFY] [expert_tools.py](file:///Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/expert_tools.py)
Ensure all Cypher queries are updated to use the `tenant_id` discriminator.
- All `MATCH` clauses involving tenant data must include `{tenant_id: $tenant_id}` or `WHERE node.tenant_id = $tenant_id`.

---

### Verification Plan

### Manual Verification
1. Create a test organization in Clerk.
2. Tag a subset of nodes in Neo4j with that Org ID.
3. Invite a Gmail user to that organization in Clerk.
4. Simulate a request with the `X-Clerk-Org-Id` header.
5. Verify the user can only see the tagged data.
