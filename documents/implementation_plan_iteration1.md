# Non-Plain-Text Tenant ID Implementation Plan (Iteration 1)

This plan outlines how to transition from plain-text `tenant_id` headers to cryptographically derived, stable, and opaque tenant identifiers tied to authenticated users (Clerk) using HMAC-SHA256.

> [!NOTE]
> This iteration was replaced by the Clerk Organizations approach in Iteration 2 to leverage enterprise-grade management features.

## User Review Required

> [!IMPORTANT]
> This change introduces a `TENANT_SECRET_SALT` environment variable. This secret must be kept consistent across deployments to ensure users retain access to their specific data in Neo4j. If the salt changes, all derived `tenant_id`s will change, effectively "resetting" user data access.

## Proposed Changes

### Core Logic
#### [NEW] [auth_utils.py](file:///Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/auth_utils.py)
Create a utility to generate stable, opaque tenant IDs using `HMAC-SHA256`.
- **Function**: `generate_tenant_id(user_id: str) -> str`
- **Mechanism**: Hashes the Clerk `user_id` with a server-side secret salt.

---

### Server Integration
#### [MODIFY] [cortex_os_mentalmodel_server_sse.py](file:///Users/sangeethar/workspace/AI-Workspace/cortex-model-project/cortex-model/cortex_os_mentalmodel_server_sse.py)
Update the `TenantMiddleware` to support deriving the `tenant_id` from an authenticated context.
- Update `dispatch` to look for a `X-User-Id` header (simulating a validated JWT `sub` claim from the Gateway).
- Use `auth_utils.generate_tenant_id` to set the `tenant_id_var`.

---

### Verification Plan

### Automated Tests
- **Unit Test**: Create `tests/test_auth_utils.py` to verify that `generate_tenant_id` is deterministic and produces hex strings.
- **Integration Test**: Update `test_sse_server.py` to use the new `X-User-Id` header and verify the server accepts it.

### Manual Verification
1. Set a temporary `TENANT_SECRET_SALT`.
2. Send a request with `X-User-Id: user_123`.
3. Verify (via logs or debug) that the `tenant_id` used in the Neo4j query is a SHA256 hash, not "user_123".
