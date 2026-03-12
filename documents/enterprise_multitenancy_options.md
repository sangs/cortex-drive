# Enterprise Multi-Tenancy Architectural Options

For a production-grade enterprise application, the `tenant_id` assignment should be robust, auditable, and easily manageable. Below are three industry-standard alternatives to the HMAC-derivation approach.

## 1. Identity Provider (IdP) Claims Pattern (Recommended)
In this model, the Identity Provider (e.g., Clerk, Okta, Auth0) is the source of truth for organization membership.

- **Mechanism**: Use Clerk's "Organizations" feature. When a user authenticates, Clerk includes an `org_id` in the JWT as a custom claim.
- **Assignment**: Admin assigns users to "Organizations" via the Clerk Dashboard or API.
- **Pros**: 
    - Offloads management to a specialized service.
    - Supports users belonging to multiple tenants.
    - Decouples authentication from data isolation logic.
- **Cons**: Dependency on Clerk's pricing/tier for Organization features.

## 2. Directory Mapping Service (Control Plane)
A dedicated "Tenant Service" or internal database table maps `user_id` to a `tenant_id` (usually a UUID).

- **Mechanism**: A central SQL table `user_tenant_mapping(user_id, tenant_id)`. The server queries this table on every request (or caches it) to resolve the tenant.
- **Assignment**: A backend "Admin Studio" or CLI tool manages this mapping.
- **Pros**:
    - Extremely flexible; can implement complex logic (e.g., one user mapping to different tenants based on time of day).
    - Can store additional tenant metadata (tier, features enabled).
- **Cons**: Adds a lookup overhead (latency) to every request unless cached.

## 3. Domain/Subdomain Routing Pattern
The tenant is identified by the URL used to access the application (e.g., `acme.synapse.com`).

- **Mechanism**: The Ingress/Gateway extracts the subdomain and resolves it to a `tenant_id` via a lookup table.
- **Assignment**: DNS and Ingress configuration.
- **Pros**:
    - High perceived "enterprise" feel for clients.
    - Simplifies networking-level isolation (e.g., specific IP whitelisting per subdomain).
- **Cons**: Most complex to set up; requires dynamic SSL/TLS certificate management and DNS automation.

## Summary Comparison

| Feature | HMAC (Stateless) | IdP Claims (Clerk) | Mapping Service |
| :--- | :--- | :--- | :--- |
| **Complexity** | Low | Medium | High |
| **Scalability** | Infinite | High | Medium (needs caching) |
| **Auditability** | Poor | Excellent | Excellent |
| **Management** | Hard (Code-only) | Easy (UI Dashboard) | Medium (Needs Admin UI) |

---

> [!TIP]
> **Recommendation for Synapse**: Start with **Option 1 (IdP Claims)** using Clerk Organizations. It provides a professional UI for managing users and ensures that the `tenant_id` is cryptographically signed inside the JWT, preventing any "header spoofing" attacks.
