# Authentication & Multi-Tenancy Design Records - 260303.1715

## Context
Project Synapse needs a robust way to isolate data between users (tenants) in a Neo4j graph database. The solution must be enterprise-ready, cost-effective for an early startup, and support retroactive data tagging for existing "brownfield" data.

## Decision 1: Identity Provider (Clerk)
**Status**: Accepted
**Rationale**: 
- Clerk provides a generous free tier (10k MAUs, 100 Orgs).
- Native support for Next.js and secure JWT handling.
- "Organizations" feature allows for natural B2B mapping.

## Decision 2: Tenant Identification Strategy
**Status**: Changed (Iterative)
- **Iteration 1**: HMAC-SHA256 hashing of `user_id`.
    - *Pros*: Stateless, no database lookup.
    - *Cons*: Hard to manage manually, "resetting" risk if salt is lost.
- **Iteration 2**: Clerk Organizations (`org_id`).
    - *Pros*: Stable IDs managed by IdP, professional UI for admins, supports team collaboration natively.
    - *Cons*: Minor manual dashboard setup required for initial onboarding.

## Decision 3: Retroactive Onboarding
**Status**: Accepted
**Process**: 
1. Create Organization in Clerk.
2. Run Neo4j migration to set `tenant_id = org_id` on existing nodes.
3. Invite user (e.g., via Gmail) to the Clerk Org.
4. System automatically matches the signed JWT claim to the Neo4j discriminator.

## Security Implications
- Data isolation is enforced at the database level via a `tenant_id` property on all nodes.
- The `cortex-model` server will reject requests without a valid `tenant_id` context.
- The API Gateway is responsible for validating the Clerk JWT before forwarding the request.
