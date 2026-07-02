# Authorization Reference Architecture — CortexDrive
**Created:** 2026-06-29
**Last updated:** 2026-07-02 — Group sharing and graph island sharing decisions added
**Relates to:**
- `permission-resolution-caching-architecture-2026-06-23.md` — Redis caching layer design
- `zanzibar-authorization-architecture-2026-04-28.md` — original Zanzibar migration plan
- `daily_log-2026-06-26.md` — composition relationship and depth-aware sharing discussion
- `daily_log-2026-06-29.md` — dense graph scalability and audit table discussion

---

## Purpose

This document consolidates every external system, paper, and architecture that CortexDrive's
authorization design has studied, adopted from, or deliberately departed from. It is the
single reference for "why did we design it this way?" across the permission system.

Every section answers two questions:
1. What does this system do that was relevant to CortexDrive?
2. What did CortexDrive adopt, adapt, or explicitly reject from it?

---

## CortexDrive Authorization — The Three-Level Model

Before the references, the settled model. Every design decision below maps to one of these
three levels.

```
┌────────────────────────────────────────────────────────────────────────┐
│  LEVEL 1 — System Tuple Log (OpenFGA internal, Cloud SQL)             │
│  What:  Every raw tuple write/delete with timestamp                   │
│  Who:   OpenFGA service (you never write to this directly)            │
│  Query: "Did tuple X exist at time T?"                                │
│  TTL:   Permanent (Cloud SQL durability)                              │
│  Table: openfga DB → `tuple`, `changelog`                             │
├────────────────────────────────────────────────────────────────────────┤
│  LEVEL 2 — Application Grant Record (CortexDrive, Cloud SQL)          │
│  What:  The grant decision: who shared what with whom, at what depth, │
│         which nodes were covered, who approved it, when it was        │
│         revoked and by whom                                           │
│  Who:   CortexDrive gateway writes on every share/revoke event       │
│  Query: "Who gave user X access to node Y, and what was the scope?" │
│  TTL:   Permanent (immutable audit record)                            │
│  Table: cortexdrive_app DB → `share_grants`                           │
├────────────────────────────────────────────────────────────────────────┤
│  LEVEL 3 — Runtime Permission Cache (Redis, Upstash)                  │
│  What:  Pre-materialized flat list of node UUIDs the user can see,   │
│         derived from OpenFGA listObjects()                            │
│  Who:   Gateway/MCP populates on miss; invalidated on grant/revoke   │
│  Query: "What can user X see right now, without calling OpenFGA?"    │
│  TTL:   300s (or invalidated by perm_version counter change)         │
│  Key:   perm:{userId}                                                 │
└────────────────────────────────────────────────────────────────────────┘
```

**The critical distinction between Level 1 and Level 2:**
Level 1 answers WHAT changed in the permission system at the tuple level.
Level 2 answers WHY it changed — who made the decision, what the intended scope was,
and what nodes were covered at the time of the grant. These two questions have different
consumers: Level 1 is for system debugging; Level 2 is for product-level audit UI
(the Manage Access tab, the share history panel, compliance exports).

Level 3 is a performance layer only. It is never the source of truth. If Redis is
flushed, the system falls back to Level 1 (OpenFGA) with no data loss.

---

## The Two Cloud SQL Stores

Both live in the same Cloud SQL instance (`cortex-openfga-db`) for operational simplicity,
but in separate databases to maintain clear ownership boundaries.

### Store A: `openfga` database (OpenFGA-managed)

| Property | Value |
|---|---|
| Owner | OpenFGA service — never touch directly |
| Primary table | `tuple` — one row per (user, relation, object) |
| Secondary table | `changelog` — every write/delete with ULID timestamp |
| Read path | OpenFGA SDK `Check()`, `ListObjects()`, `Read()` |
| Write path | OpenFGA SDK `Write()` — never raw SQL |
| Purpose | Live authorization state — the single source of truth for "can user X see node Y right now?" |
| Durability | Cloud SQL persistent disk — permanent |

Do not add CortexDrive application tables to the `openfga` database. OpenFGA's schema
can change on version upgrades and any custom tables would be at risk.

### Store B: `cortexdrive_app` database (CortexDrive-managed)

| Property | Value |
|---|---|
| Owner | CortexDrive gateway |
| Primary table | `share_grants` — one row per grant decision |
| Read path | Standard SQL via gateway API endpoints |
| Write path | Gateway writes on `POST /api/share/*` and `DELETE /api/share/revoke` |
| Purpose | Grant provenance and audit history — the source of truth for "who decided this, when, and what was the full scope?" |
| Durability | Cloud SQL persistent disk — permanent |

**`share_grants` schema (updated 2026-07-02 to include group and graph-island support):**
```sql
CREATE TABLE share_grants (
    grant_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    root_node_id    TEXT NOT NULL,
    subject         TEXT NOT NULL,           -- Permify subject: "user:{sub}" or "group:{group_id}#member"
    subject_type    TEXT NOT NULL DEFAULT 'user'
                    CHECK (subject_type IN ('user', 'group')),
    group_id        UUID REFERENCES groups(group_id),  -- set when subject_type = 'group'
    grant_type      TEXT NOT NULL DEFAULT 'node'
                    CHECK (grant_type IN ('node', 'graph_island')),
    relation        TEXT NOT NULL DEFAULT 'shared_viewer',
    depth           INTEGER NOT NULL DEFAULT 0,
    composition_rels TEXT[] NOT NULL,
    child_node_ids  TEXT[] NOT NULL,         -- all node UUIDs covered by this grant
    issued_by       TEXT NOT NULL,
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    revoked_by      TEXT,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'revoked', 'expired'))
);
CREATE INDEX ON share_grants (root_node_id, status);
CREATE INDEX ON share_grants (subject, status);
CREATE INDEX ON share_grants (group_id, status);
CREATE INDEX ON share_grants (issued_by);
```

**`groups` and `group_members` schema (new, 2026-07-02):**
```sql
CREATE TABLE groups (
    group_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          TEXT NOT NULL,           -- Clerk org_id or the tenant that created the group
    name            TEXT NOT NULL,           -- display name: "HR Recruiters", "Hiring Managers"
    slug            TEXT NOT NULL,           -- url-safe identifier: "hr-recruiters"
    description     TEXT,
    created_by      TEXT NOT NULL,           -- Clerk user sub
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, slug)
);

CREATE TABLE group_members (
    group_id        UUID NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
    user_sub        TEXT NOT NULL,           -- Clerk user sub; may be from a different org (cross-org)
    user_org_id     TEXT,                    -- the org the user belongs to (may differ from groups.org_id)
    added_by        TEXT NOT NULL,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_sub)
);
CREATE INDEX ON group_members (user_sub);    -- "which groups is this user in?" lookup
```

**Why `child_node_ids[]` is stored explicitly:** When a grant at depth 2 covers 47 nodes,
the `share_grants` record stores all 47 UUIDs. This enables atomic batch revocation
without re-running the BFS traversal. If the graph has changed since the grant was made
(nodes added or removed), the UUID list still precisely identifies every Permify tuple
that was written by this grant — no ambiguity, no orphaned tuples.

---

## Enterprise Systems Consulted

---

### 1. Google Zanzibar (2019)

**Citation:** Zanzibar: Google's Consistent, Global Authorization System — VLDB 2019.
[research.google/pubs/pub48190](https://research.google/pubs/pub48190/)

**What it does:** Zanzibar is Google's centralized authorization system for all Google
products (Drive, Docs, Calendar, Maps, YouTube). Every access check for every product
goes through it. The core data model is a **relationship tuple**: `(user, relation, object)`.
Permission check = "does a path exist in the tuple graph from user to object via this
relation?" Authorization model = a namespace configuration that defines how relations
compose (computed usersets, tuple-to-userset).

**Key innovations relevant to CortexDrive:**

- **Tuple model**: replaces ACL columns in application databases with a dedicated
  authorization store. Permissions are relationships, not properties.
- **Consistency token (zookie)**: a signed pointer to a Spanner timestamp. Clients pass
  the zookie with their next request; Zanzibar serves a result consistent with that
  snapshot, enabling cache hits without staleness.
- **Hierarchical inheritance via computed usersets**: `can_view = shared_viewer OR can_view from parent`.
  Sharing a folder writes one tuple on the folder; all files inherit via the parent chain.
- **LLM-era relevance**: Zanzibar predates LLM agents but its relation model generalizes
  cleanly. An LLM session becomes `agent:{session_id}` as a first-class subject, issued
  a `shared_viewer` tuple with a `not_expired` condition. Same tuple model, no schema
  changes needed.

**What CortexDrive adopted:**
- The tuple model (via OpenFGA, the open-source Zanzibar implementation)
- `owner`, `tenant_viewer`, `shared_viewer` relations in the OpenFGA authorization model
- `not_expired` condition for time-bounded guest and agent access
- The two-plane separation: authorization state (OpenFGA) is separate from knowledge state (Neo4j)
- The `perm_version:{tenantId}` generation counter as a lightweight zookie equivalent

**What CortexDrive adapted:**
- Zanzibar's zookie is per-user-per-object. CortexDrive's `perm_version` is per-tenant
  (coarser). When any permission in the tenant changes, all users in the tenant get a
  cache miss on the next request. This is intentionally coarser — the tenant population
  is small enough that the thundering herd risk is low.

**What CortexDrive explicitly did NOT adopt:**
- Zanzibar's distributed Spanner backend — Cloud SQL is the backing store (cost and
  operational complexity; Spanner-grade consistency not required at CortexDrive's scale)
- Parent-chain tuple inheritance for composition relationships — deferred to a future
  phase; current sharing is fan-out at write time (Option A, daily_log-2026-06-26.md)

---

### 2. OpenFGA (Auth0/Okta — Zanzibar implementation)

**Reference:** [openfga.dev](https://openfga.dev) |
"Modeling Google Drive" tutorial: [openfga.dev/docs/modeling/examples/google-drive](https://openfga.dev/docs/modeling/examples/google-drive)

**What it is:** OpenFGA is an open-source, faithful Zanzibar implementation maintained
by Auth0 (Okta). It provides the same tuple model and namespace DSL as Zanzibar, with
a REST API and SDKs for Python, JS, Go, Java.

**Okta Fine-Grained Authorization (commercial OpenFGA)** extends this with:
- Managed hosting, SLAs
- An **access events stream** — every API call that modifies tuples generates an audit
  event with `actor`, `action`, `resource`, `timestamp`
- An **access request UI** integration layer (for enterprise approval workflows)

**The Okta audit pattern:** Okta keeps two stores: the tuple store (live permission state)
and the access events stream (who modified permissions and when). Applications that need
"who approved this access?" build their own approval/grant tables on top. This is exactly
the pattern CortexDrive implements with `share_grants` — the tuple store is Level 1
(OpenFGA internal), the grant record is Level 2 (CortexDrive-owned).

**What CortexDrive adopted:**
- OpenFGA as the production authorization backend (deployed on Cloud Run)
- The Python SDK (`openfga_sdk`) in `src/mcp_server/openfga_utils.py`
- The `listObjects(can_view)` pattern as the permission resolution entrypoint
- The `tuple` table in Cloud SQL as the live permission state (Level 1 in the three-level model)
- The audit table pattern (Level 2) inspired by Okta's access events model

---

### 3. Authzed / SpiceDB (commercial Zanzibar, used by Airbnb, Carta, Duolingo)

**Reference:** [authzed.com](https://authzed.com) | [github.com/authzed/spicedb](https://github.com/authzed/spicedb)

**What it does:** SpiceDB is a production-grade open-source Zanzibar implementation with
stronger consistency guarantees than OpenFGA. The commercial product (Authzed) adds
enterprise features including managed hosting, RBAC for the authz service itself, and
a **permission changelog API** (`ReadChangelog`).

**The SpiceDB changelog pattern:**
`ReadChangelog` returns a stream of tuple-level deltas:
- `TUPLE_TOUCH` — a tuple was written
- `TUPLE_DELETE` — a tuple was deleted
Each delta has a `ZedToken` (SpiceDB's consistency token equivalent).

This is a system-level log — raw tuple mutations with no application context. Applications
using SpiceDB (e.g., Klarna for financial authorization, Airbyte for connection-level
access) maintain their own **permission change log** tables to record the business intent
above the tuple level. "User A shared Project X with User B at depth 2" is not in the
SpiceDB changelog — only the individual tuple writes/deletes are.

**How this maps to CortexDrive's three-level model:**
- SpiceDB `ReadChangelog` ≈ Level 1 (OpenFGA `changelog` table in Cloud SQL)
- Application permission change log ≈ Level 2 (`share_grants` table in `cortexdrive_app`)
- Runtime cache ≈ Level 3 (Redis `perm:{userId}`)

**What CortexDrive adopted:**
- The separation between system-level tuple log (Level 1) and application-level grant
  record (Level 2) — this pattern is consistent across SpiceDB, Okta FGA, and Google
  Drive's internal design
- The principle that the tuple store does not record business intent — that is the
  application's responsibility

**What CortexDrive uses instead:** OpenFGA rather than SpiceDB/Authzed. The trade-off:
OpenFGA has weaker consistency semantics (Cloud SQL transactions rather than Spanner-grade
distributed transactions) but is operationally simpler and sufficient for CortexDrive's
current scale. If CortexDrive grows to multi-region or requires sub-millisecond global
consistency, SpiceDB/Authzed would be the migration target.

---

### 4. Permify (open-source Zanzibar, used by Klarna, Directus)

**Reference:** [permify.co](https://permify.co) |
[github.com/Permify/permify](https://github.com/Permify/permify)

**What it does:** Permify is an open-source Zanzibar-compatible authorization service.
Its key differentiator over OpenFGA is an explicit **depth budget** on every permission
check and lookup call:

```
POST /v1/tenants/{tenant_id}/permissions/lookup-entity
{
  "depth": 3,
  "entity_type": "node",
  "permission": "can_view",
  "subject": { "type": "user", "id": "sub" }
}
```

`depth: 0` = direct tuples only. `depth: N` = follow computed userset chains up to N hops.
This is the closest enterprise implementation to the "controllable depth" requirement for
CortexDrive's sharing UI.

**Permify at dense graph scale — scalability consideration:**
For graphs where a single share root has 10,000+ descendants:
- Permify's depth budget prevents runaway recursion but does not change the O(tuples × depth)
  complexity of `listObjects`
- Permify implements a computed userset cache — intermediate `can_view` results for a
  given user × subtree are cached (similar to Zanzibar's zookie-based snapshot cache)
- The first `listObjects` for a newly shared dense subtree is always the expensive call;
  subsequent calls (same user, same subtree, no permission changes) are cache hits
- At very high density (100,000+ nodes per grant subtree), even Permify's caching is
  insufficient — this is where **materialized permission snapshots** (pre-computed
  denormalized ACL fanout tables) become necessary, as used internally at Google

**For CortexDrive:** Permify holds good for the foreseeable scale (hundreds to low thousands
of nodes per tenant per grant). The fan-out at write time approach (Option A, see
daily_log-2026-06-26.md) sidesteps the `listObjects` traversal problem by pre-materializing
the UUID list in the Redis Level 3 cache. If the graph exceeds ~50,000 nodes per tenant,
this decision should be revisited.

**Long-term consideration:** Permify or a Permify-compatible depth-budget pattern is the
right target when CortexDrive adds parent-child tuple inheritance (Option B in
daily_log-2026-06-26.md). OpenFGA does not natively support a depth parameter on
`listObjects`; Permify does.

---

### 5. GitHub (Authz sidecar pattern)

**What CortexDrive adopted from this:**
GitHub deploys a permission sidecar — a co-located cache process alongside each application
service, populated by push from the central Authz service. Each service reads from its
local sidecar (sub-millisecond), not from the central Authz on every request.

For CortexDrive on Cloud Run (no Kubernetes sidecar primitive), the shared Redis cache
plays the sidecar role. It is not co-located per service but is network-proximate
(~0.5–1ms intra-VPC on Google Cloud Memorystore). The result is architecturally
equivalent: centralized permission logic (OpenFGA), distributed cache proximity (Redis).

See `permission-resolution-caching-architecture-2026-06-23.md` §Enterprise Architecture
Comparisons for full detail.

---

### 6. Palantir Foundry (ontology-based security, contrast case)

**Reference:** Palantir engineering documentation on Foundry Ontology security.

**What it does:** Palantir enforces dataset visibility through derived dataset lineage.
When dataset A is derived from dataset B, viewing A requires viewing B. This is
**upward** permission checking: source → derived. Access to a derived output implies
access to its upstream sources must have been pre-authorized.

**Comparison table vs. CortexDrive:**

| Dimension | Palantir Foundry | CortexDrive |
|---|---|---|
| Permission model | Ontology-based role/dataset ACLs | Node-level OpenFGA tuples (`owner`, `tenant_viewer`, `shared_viewer`) |
| Inheritance direction | Upward (source → derived) | Downward (parent → child, via composition rels only) |
| Graph structure assumed | DAG (directed acyclic — dataset lineage) | Polyarchic property graph (same node, multiple parent types) |
| LLM agent as principal | No | Yes — `agent:{sessionId}` tuple (stub built, Phase 4) |
| Audit | Yes (dataset access log) | Level 1 (OpenFGA changelog) + Level 2 (`share_grants`) |
| Cost model | Enterprise ($millions+) | OpenFGA on Cloud Run (~$10/month at CortexDrive's scale) |

**What CortexDrive explicitly did NOT adopt:**
Palantir's upward inheritance direction. CortexDrive sharing flows downward: sharing a
`Project` can cover its owned `Chunk` and `PreparatoryNote` children (composition), but
must never expose the `Company` or `Technology` nodes the Project references (non-composition).
Upward traversal would invert this — a user could gain access to a parent node by being
granted access to a child, which is the wrong direction for privacy.

**What CortexDrive adopted:**
The product-level concept of "ontology-level security" — permission is enforced at the
graph node level, not at the application feature level. No UI feature gate or role check
replaces the graph-level access control. The LLM cannot be prompted into revealing a node
it cannot physically traverse to (the No-Bounce Firewall in `anti-pattern-catalog.md`).

---

### 7. Notion (depth-controllable page inheritance — UX reference)

**What it does:** Notion's permission model provides:
- Every page inherits permissions from its parent workspace/page by default
- Any page can "restrict access" — breaking the inheritance chain at that node
- Share UI explicitly shows which sub-pages will be included before confirming
- Three sharing modes: "This page only" / "This page and all sub-pages" / "Entire workspace"

**What CortexDrive adopted (UX principle):**
The "show before commit, inferred not declared" pattern. When sharing from the graph
view, CortexDrive should infer what would be included (running BFS over composition
relationships), show the user a structured preview (root with subtree expansion), and
require explicit approval before writing any OpenFGA tuples. The user narrows scope,
never expands it beyond what was inferred.

**Where the analogy breaks:** Notion pages are a tree (every page has exactly one parent
workspace or page). CortexDrive is a polyarchic graph — same node can have multiple
parent-type incoming edges. The inference algorithm must classify edges by whether they
are composition or non-composition, not just by whether a parent edge exists.

---

### 8. AWS IAM / AWS Cedar policy language (contrast case)

**What it does:** AWS takes a policy-language approach to authorization. IAM policies
are JSON documents that define allow/deny rules evaluated per-request by each AWS service.
Cedar (open-source, 2023) is AWS's policy language for building authorization systems.

**Why CortexDrive did NOT adopt this approach:**
Policy-language authorization (define rules, evaluate per-request) is appropriate when
the permission model is mostly static and can be expressed in predicates (e.g., "members
of group X can perform action Y on resources tagged Z"). CortexDrive's permission model
is dynamic at the node level — every node can have a different set of authorized viewers,
and authorization must be resolved to a flat UUID list for injection into Neo4j Cypher
queries. A policy language does not give you a list of authorized object IDs; it gives
you a yes/no answer for a specific (user, action, resource) triple. OpenFGA's `listObjects`
is the right primitive; Cedar is not.

**What CortexDrive adopted from AWS:**
The concept of **centralized policy evaluation with distributed caching** (see GitHub
sidecar section above, also `permission-resolution-caching-architecture-2026-06-23.md`).
Not the policy language or evaluation model.

---

### 9. Apache Ranger (path-based depth inheritance — contrast case)

**What it does:** Apache Ranger enforces HDFS access using path prefixes. A grant on
`/data/projects/` gives access to all subdirectories recursively. Depth is unlimited once
the prefix grant exists. Works because HDFS is a tree — every path has exactly one parent.

**Why this does not translate directly to CortexDrive:**
CortexDrive's graph is polyarchic. A `Technology` node is referenced by both `Episode`
nodes (via `COVERS_TECHNOLOGY`) and `Project` nodes (via `USES_TECH`). A path-prefix
grant on a `Technology` node would bleed across domain boundaries. The composition
relationship classification (see `daily_log-2026-06-26.md`) is the CortexDrive answer
to this: only ownership/containment relationships carry depth inheritance, and those rels
are never cross-domain.

**What CortexDrive adopted from Ranger:**
The concept of defining a **named set of relationship types** that carry inheritance
semantics, rather than applying inheritance to all relationship types. In Ranger, this is
the HDFS path separator. In CortexDrive, it will be `COMPOSITION_RELATIONSHIPS` (a
named constant in `schema_guard.py`, distinct from `TRAVERSAL_RELATIONSHIPS`).

---

### 10. Google Drive ACL (early inspiration — now superseded)

**Source:** `documents/cortex-drive-documents/architectural_inspiration_report.md`
(written early 2026, pre-Zanzibar migration)

The early CortexDrive design took Google Drive's ACL model and mapped it directly to
Neo4j: `(User)-[:CAN_ACCESS {role: 'VIEWER'}]->(Node)`. This was the GACL (Graph ACL)
era — authorization lived in the knowledge graph itself.

**Why this was superseded:**
- Mixing authorization state with knowledge state violates separation of concerns. Neo4j
  should be a pure knowledge plane; authorization should live in a dedicated system.
- HAS_ACCESS traversal (`*1..2`) used in Cypher queries for permission filtering is
  O(relationships) and does not scale linearly with the graph.
- No audit trail, no time-bounded access, no agent principal concept.

**The migration:** Zanzibar Phase 2 (completed 2026-06-05) moved all permission resolution
to OpenFGA. The GACL `HAS_ACCESS` and `OWNS` edges in Neo4j are now stale (490 edges
each, tracked in `cortex_master_implementation_tracker.md` Section 5 for cleanup).

---

---

## Group-Based Sharing and Graph Island Sharing — Architecture Decisions (2026-07-02)

This section records the design decisions made on 2026-07-02 for two new sharing
capabilities: (1) sharing with named groups rather than individual users, and
(2) sharing an entire graph island (a full query response) rather than a single node.

---

### Decision 1 — Group Scope: Cross-Org and Cross-Company

**Decision:** A CortexDrive group is not bounded to a single org or company. A group
like `hr-recruiters` created by org A may contain members from org B (a different
company entirely). This is deliberate — enterprise use cases require sharing across
organizational boundaries (e.g., an external recruiter at a staffing agency in a
hiring pipeline group, a board member at a portfolio company in an investor group).

**How this works in Permify:**

The Permify subject for a group share is:
```
entity:  { type: "node", id: "<node-uuid>" }
relation: shared_viewer
subject:  { type: "group", id: "<group-uuid>", relation: "member" }
```

When Permify evaluates `can_view` for a user, it expands `group:<id>#member` to all
users in that group regardless of what org they belong to. The group itself is the
authorization boundary — not the org.

**What stays org-scoped:** Node ownership and tenant isolation. A node is always owned
by one org. Sharing across orgs grants read-only `shared_viewer` access. The owner's
org is never changed, and the sharing user must be the node owner or have explicit
`can_manage` permission to issue cross-org grants.

**Cross-org member storage:** `group_members.user_org_id` records the org the member
belongs to, enabling audit queries like "who from org B has access to org A's content?"
This is a compliance requirement for enterprise customers.

---

### Decision 2 — Group Ownership: CortexDrive-Managed (TODO: External Directory Sync)

**Decision:** Groups are created and managed inside CortexDrive. There is no sync with
external directories (Okta, Azure AD, Google Workspace) at this time.

**Why:** External directory sync adds significant operational complexity: OAuth/SCIM
provisioning, delta sync jobs, conflict resolution when a user is removed from the
external directory but still has active grants. CortexDrive needs to validate product
value before taking on this infrastructure cost.

**TODO:** When the first enterprise customer arrives with an existing identity provider,
add SCIM 2.0 group provisioning as a separate integration layer. SCIM writes to the
`group_members` table (and issues Permify tuples) but does not change the authorization
model. The model is directory-agnostic — a member is a member regardless of how they
were added.

**References for future SCIM work:** Okta SCIM 2.0, Google Cloud Directory Sync,
Azure AD Group Writeback. All support `POST /groups` and `PATCH /groups/{id}/members`
as the provisioning endpoints.

---

### Decision 3 — Graph Island Sharing: Option B (Live Permify Grants, Not Snapshot)

**Decision:** When a user shares a full graph view (all nodes returned by a query),
CortexDrive uses live Permify grants (Option B), not a static snapshot (Option A).

**What "graph island" means:** When a user asks "Show career map of Sangeetha Ramadurai,"
the canvas shows N nodes and M edges — a topologically connected subgraph that answers
the question. This is the "graph island." The user wants to share this entire island with
a person or group.

**Why Option B (live) over Option A (snapshot):**
- Recipients get live data — if a new role is added or a node is updated, they see it
- Authorization is enforced at the Permify level, not by freezing a JSON blob
- Consistent with the existing share model: single-node shares also use live Permify grants
- Snapshots create a maintenance burden (TTL, storage, stale data confusion)

**How it works — root nodes only:**

The critical insight is that the graph island always has one or a small number of **root
nodes** — nodes with no inbound parent edge within the island (the topological roots of
the BFS tree). Sharing the island means writing one `shared_viewer` Permify tuple per
root node. The existing `parent.can_view` chain in Permify propagates access downward to
all descendant nodes automatically.

For the career map example:
- Root: `Person: Sangeetha Ramadurai`
- Island: 342 nodes (all career nodes reachable via composition relationships)
- Permify writes: **1 tuple** — `(node:person-uuid, shared_viewer, group:hr-recruiters#member)`
- All 342 descendant nodes are covered by the existing parent chain
- `share_grants.child_node_ids[]` stores all 342 UUIDs for audit and atomic revocation

For a cross-domain response (1-3 career roots + 1-2 podcast roots):
- Permify writes: 2-5 tuples, one per root node
- All descendant nodes covered by existing parent chains

**Scale properties:** As the graph grows denser (more nodes per island), the number of
Permify writes remains bounded by the number of root nodes in the island — typically
1-5 regardless of island size. This is the design invariant. If a query returns an island
with no clear root (a flat set of unrelated nodes), the gateway writes one tuple per node
in the island — worst case O(N) writes. This is acceptable for the expected N at this
scale (tens to low hundreds of unrelated nodes per query result).

---

### Decision 4 — Graph-Defined Audiences (Future Phase, Not Yet Implemented)

**Status:** Architecture design only. Implementation deferred until group-based sharing
(Decisions 1-3) is stable.

**What it is:**

A **graph-defined audience** is a group whose membership is computed from the knowledge
graph itself via a Cypher query, rather than maintained as an explicit list.

In plain terms: if the knowledge graph already tracks that Alice, Bob, and Carol are
guests on Episode 47, you do not need to create a group, add Alice, add Bob, and add
Carol manually. You define the audience as a Cypher predicate:

```cypher
MATCH (p:Person)-[:GUEST_ON]->(e:Episode {node_id: $episode_node_id})
RETURN p.clerk_sub AS user_sub
```

When someone is shared access using this audience definition:
1. The gateway evaluates the Cypher query at share time to get the current member list
2. For each returned `user_sub`, the gateway issues a Permify tuple (same as a manual group member)
3. Optionally: the audience definition is stored and re-evaluated periodically (live sync)
   so newly added members automatically receive the same access

**Why this is unique to CortexDrive:**

Every other authorization system treats the permission graph and the knowledge graph as
separate systems. A Google Group is maintained separately from Google Drive documents.
An Azure AD group is maintained separately from SharePoint content.

In CortexDrive, the knowledge graph tracks relationships between people and content
(guests on episodes, contributors to projects, colleagues at companies). The **same
relationships that describe the content also define who should have access to it**. A
separate group list would be a redundant copy of information already in the graph.

**Concrete examples:**

| Audience definition | Cypher predicate |
|---|---|
| "Everyone who appeared on any episode in this podcast season" | `MATCH (p:Person)-[:GUEST_ON]->(e:Episode)-[:PART_OF]->(s:Season {node_id: $id}) RETURN p.clerk_sub` |
| "Everyone who contributed to this project" | `MATCH (p:Person)-[:CONTRIBUTED_TO]->(proj:Project {node_id: $id}) RETURN p.clerk_sub` |
| "All colleagues from Sangeetha's time at Company X" | `MATCH (p:Person)-[:WORKED_AT]->(c:Company {node_id: $id}) RETURN p.clerk_sub` |
| "All guests connected to Sangeetha within 2 hops" | `MATCH (p:Person)-[:GUEST_ON|INTERVIEWED_BY*1..2]->(e:Episode)<-[:GUEST_ON|HOSTS]-(sangeetha:Person {name: 'Sangeetha Ramadurai'}) RETURN DISTINCT p.clerk_sub` |

**Implementation approach (when ready):**

A `group_definitions` table stores the Cypher template + parameter bindings. The gateway
evaluates it at share time and at a configurable refresh interval. The actual Permify
tuples are written per-member, same as explicit group membership. The audience definition
is an input layer on top of the same group/member/tuple machinery.

```sql
CREATE TABLE group_definitions (
    group_id        UUID PRIMARY KEY REFERENCES groups(group_id),
    cypher_template TEXT NOT NULL,    -- parameterized Cypher returning user_sub
    param_bindings  JSONB NOT NULL,   -- { "episode_node_id": "<uuid>" }
    refresh_hours   INTEGER DEFAULT 24,
    last_evaluated  TIMESTAMPTZ
);
```

**Guard rails required before building:**

- The Cypher template must be validated against a whitelist of allowed relationship types
  (`TRAVERSAL_RELATIONSHIPS`) to prevent arbitrary graph traversal as a side effect
- Templates must not traverse non-composition relationships that could cross domain
  boundaries (the No-Bounce Firewall applies here too)
- Evaluation is synchronous at share time; periodic refresh is async and non-blocking

---

### How Group Sharing Fits in the Three-Level Model

```
┌─────────────────────────────────────────────────────────────────────────┐
│  LEVEL 1 — Permify Tuples (changed from OpenFGA 2026-07-01)            │
│  Group member: entity={group,G}, relation=member, subject={user,U}      │
│  Node share:   entity={node,N}, relation=shared_viewer,                 │
│                subject={group,G,relation=member}                        │
│  Writes: 1 per group member add/remove; 1 per root node shared          │
│  Reads:  Permify expands group#member at check time (lazy fan-out)      │
├─────────────────────────────────────────────────────────────────────────┤
│  LEVEL 2 — Application Records (cortexdrive_app DB)                     │
│  `groups` table: one row per group (name, slug, org_id, creator)        │
│  `group_members` table: one row per (group, user) pair with cross-org   │
│  `share_grants` table: subject_type='group', group_id set,              │
│                         child_node_ids[] for audit and revocation        │
├─────────────────────────────────────────────────────────────────────────┤
│  LEVEL 3 — Redis Cache (invalidation strategy for groups)               │
│  Key: perm:{user_sub}                                                    │
│  Invalidated when: user is added/removed from any group that has active  │
│  shares (gateway must track group→member mapping for targeted            │
│  invalidation, or invalidate all members of the group on any change)    │
└─────────────────────────────────────────────────────────────────────────┘
```

**Cache invalidation for group membership changes:**

When a user is added to a group that has N active shares, the gateway must invalidate
`perm:{new_member_sub}` so their next request picks up the new access. When a user is
removed, same invalidation clears their stale cache.

The gateway does not need to know which specific nodes are newly accessible — it only
needs to invalidate the user's cache key. Permify recomputes the full list on the next
miss.

**Scalability as groups grow:**

| What grows | Permify writes | Cache impact |
|---|---|---|
| Group size (more members) | 1 tuple per new member | 1 cache key invalidated per add/remove |
| Island size (more nodes shared) | 1 tuple per root node (typically 1-5) | N member cache keys invalidated on share |
| Number of groups | Independent; groups don't interact unless nested | — |
| Number of shares per group | Linear in root nodes per share, not in group size | Member caches invalidated once per new share |

---

## Design Decisions Traceable to These References

| Decision | Source reference | Where implemented |
|---|---|---|
| Tuple model for authorization (not Neo4j ACL relationships) | Zanzibar paper, OpenFGA | `openfga_utils.py`, `permission-resolution-caching-architecture-2026-06-23.md` |
| `listObjects(can_view)` as primary permission resolution | OpenFGA tutorial | `openfga_utils.py:list_viewable_node_ids()` |
| `perm:{userId}` Redis cache with 300s TTL | GitHub sidecar, Zanzibar zookie, Stripe | `cortex-gateway/index.js`, `cortex_os_mentalmodel_server_sse.py` |
| `perm_version:{tenantId}` generation counter | Zanzibar zookie (coarsened) | `cortex-gateway/index.js` |
| `share_grants` table in Cloud SQL (Level 2 audit record) | Okta FGA access events, Authzed/SpiceDB application grant log | Designed; not yet implemented |
| Fan-out at write time for depth-aware sharing (Option A) | Pragmatic: avoids OpenFGA model changes | Designed; not yet implemented |
| Parent-chain userset inheritance (Option B, long-term) | Zanzibar userset model, OpenFGA Google Drive tutorial | Designed; not yet implemented (requires `COMPOSITION_RELATIONSHIPS` first) |
| Depth budget as UI concept (not numeric slider) | Permify depth budget, Notion's 3-mode share UX | Designed for future ShareModal update |
| "Show inferred scope before confirming" share UI | Palantir grant preview, AWS IAM policy simulator, Notion sub-page list | Designed; not yet implemented |
| `COMPOSITION_RELATIONSHIPS` named constant (downward-only) | Apache Ranger named inheritance type, Palantir lineage direction analysis | `schema_guard.py` — to be added |
| No-Bounce Firewall (structural, not policy-based) | Palantir ontology security principle | `expert_tools.py _get_security_clause()`, `anti-pattern-catalog.md` |
| SYSTEM-tenant nodes excluded from grant roots | Invariant 9 in `CLAUDE.md` | `openfga_utils.py`, gated in gateway share endpoints |
| LLM agent as first-class principal with time-bound tuples | Zanzibar userset model generalized | `openfga_utils.py:create_agent_session()` (stub, Phase 4) |
| Cross-org group membership (user_org_id stored per member) | Google Drive cross-domain sharing, Azure AD external identities | `group_members` table — to be implemented |
| Group-based sharing via Permify group#member userset | Google Zanzibar userset rewrite, OpenFGA group modeling tutorial | Permify schema already has `group:* #member` as `shared_viewer` subject type |
| Graph island sharing — live Permify grants over root nodes only | Zanzibar parent-chain inheritance; decision over static snapshot | `share_grants.grant_type = 'graph_island'` — to be implemented |
| TODO: external directory sync via SCIM 2.0 | Okta SCIM, Azure AD Group Writeback, Google Directory Sync | Deferred; no implementation started |
| Graph-defined audiences (Cypher-computed group membership) | No reference system; CortexDrive-novel | `group_definitions` table — Future Phase; see Decision 4 above |

---

## What No Reference System Has (CortexDrive's Novel Contributions)

### 1. LLM Agent as First-Class Authorization Principal

All consulted systems (Zanzibar, OpenFGA, Permify, Palantir) handle human-to-resource
authorization. None treats an LLM agent session as a first-class authorization principal
with:
- Its own tuple (`agent:{sessionId} → shared_viewer → node:{uuid}`)
- A time-bound `not_expired` condition expiring at session end
- Delegation provenance (`delegated_by: user:{humanSub}`)
- A separate audit trail of every node the agent accessed during the session

The human delegates a scoped view of their graph to a Claude session for a bounded time
window. The delegation expires. The knowledge graph is unchanged. Every access event is
logged at Level 2. No other authorization system is built around this use case.

See `documents/discussions/cortex-drive-share-feature.md` §"Phase 4 — agent principals"
for the full design.

### 2. Graph-Defined Audiences

No reference system (Google Groups, Azure AD, Okta, Notion, Slack) can define group
membership via traversal of the content graph. In all existing systems, the permission
graph and the knowledge graph are separate — group membership is maintained independently
of content structure.

In CortexDrive, the same graph that describes the content also describes who should have
access to it. A user who is `GUEST_ON` an episode, `CONTRIBUTED_TO` a project, or
`WORKED_AT` a company is already represented in the graph. A graph-defined audience
turns that existing relationship into an authorization boundary without a separate list.

This is the consequence of designing topology-as-security: the knowledge graph is not
just a source of content — it is simultaneously the source of access policy. This is the
property that makes CortexDrive's authorization model fundamentally different from any
other enterprise knowledge system.

See Decision 4 in the section above ("Group-Based Sharing and Graph Island Sharing —
Architecture Decisions") for the full design and implementation plan.
