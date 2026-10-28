# Cortex-Drive — Architecture Guardrails for Claude Code

Read at every session start. Non-negotiable rules, file ownership, and active
anti-patterns. Before writing any code, verify it does not violate any rule below.
Full AP incident narratives: `documents/architecture/anti-pattern-catalog.md`.

---

## Project Overview

Cortex-Drive is a zero-trust, multi-domain knowledge graph system connecting a podcast
episode graph (transcripts, topics, guests) with a professional resume graph (projects,
companies, thought leadership) in Neo4j. Gateway: Node.js. MCP server: Python/FastMCP.
UI: Next.js.

**Current domains:** `podcast`, `career`, `cross_domain`

---

## Architecture Invariants — Non-Negotiable Rules

### 1. No Hardcoding — Every Repeated Value Must Be a Named Constant

Any value that appears in logic — string list, type name, port, threshold — must be a
named constant. Python constants: `schema_guard.py` (schema primitives) or
`domain_registry.py` (domain logic). JS constants: `cortex-gateway/config/*.json` or
module-level `const`. Never inline in a function body.

### 2. Single Source of Truth for Domain and Schema Definitions

- `schema_guard.py` — all raw node label lists, relationship type lists, `TRAVERSAL_RELATIONSHIPS`
- `domain_registry.py` — `DOMAIN_MANIFESTS`, `get_authorized_labels(domain_intent)`
- `cortex-gateway/config/domain_manifests.json` — JS mirror of domain_registry.py; must stay in sync

Never define node type lists, relationship type lists, or domain manifests inline in
`index.js`, `expert_tools.py`, or `dashboard/page.tsx`.

### 3. Domain Filtering Must Be Inclusion-Based, Not Exclusion-Based

Cypher MATCH in `search_enterprise_graph` must be built from `get_authorized_labels(domain_intent)`.
`DISCOVERY_LABELS` is the full union — for schema documentation only, never for query filtering.

### 4. Cypher Parameter Discipline — No Orphaned Parameters

Every parameter passed to `_exec_query()` must have a `$param_name` reference inside
the query string. After any Cypher change: grep the query string for every parameter.
Orphaned parameters are silently ignored — they produce wrong results without errors.

### 5. Zero-Write Rule for Virtual Bridges

`connect_knowledge_on_demand` bridges are session-only. `VIRTUAL_BRIDGE` links exist
only in `accumulatedGraph.virtual_links`. No `MERGE`, `CREATE`, or `SET` may touch
virtual/bridge relationship types in Neo4j.

### 6. Graph Tool Results Must Never Enter the LLM Message Loop in Full

Graph tools return large JSON. Full payload → `mergeGraphData()` → `accumulatedGraph`
(visualization). Compact summary → `buildLlmToolContent()` → LLM messages. These are
two separate consumers. Never push raw `toolContent` from a graph tool to `messages`.

### 7. Domain Guard Is a Safety Net, Not Primary Logic

The gateway guard (filtering `accumulatedGraph.nodes` by domain signal) is a last-resort
backstop. Primary domain filtering happens at the Cypher level. If the gateway guard is
the only thing stopping contamination, fix the Cypher.

### 8. Intent Classification Before LLM Call

`classifyDomain()` in `cortex-gateway/utils/intent_classifier.js` runs before the LLM
call. The LLM must not be the first system deciding domain. `domain_signal` is injected
into the system prompt and returned in the response JSON.

### 9. Visibility Tiers: PUBLIC, Built-in SYSTEM, Organization, Private

Hierarchy: Platform → Organization (= tenant = Clerk org) → (future) Workspace → Groups → Users.
- `PUBLIC` — visible to everyone (all orgs, invited users, guest links); platform-owner content only,
  incl. the founder's career graph (moved 2026-10-26, `scripts/migrate_career_graph_public.py`).
- `SYSTEM` — curated built-in vocabulary only (`schema_guard.SEED_BUILTIN_VOCABULARY_LABELS`), read-only for
  orgs; never customer data. Only seed scripts write it, and only for nodes they just created.
- Org tenant — everything an organization creates: **Private** by default (owner + explicit shares),
  **Organization**-wide only via Permify `tenant_viewer @org#member`. Ingestion never MERGEs into SYSTEM/PUBLIC.
- SYSTEM/PUBLIC nodes are not shareable (409). Check: `scripts/neo4j_diagnostics/check_invariant9_violations.py`.
Design: `documents/architecture/visibility-tiers-design-2026-10-23.md`.

### 10. Post-Commit Query Verification Is a Hard Gate

After any commit touching `expert_tools.py`, `index.js`, `dashboard/page.tsx`, or any
`scripts/seed_*.py` / `scripts/bootstrap_*.py` — run one query per domain pattern
(single-domain retrieval, identity map, cross-domain bridge) and verify correctness
before pushing. This is not optional.

### 11. LLM Responses Must Be Grounded in Tool Results Only

Every fact, entity name, date, role title, and URL in an LLM response must be
traceable to a node, chunk, or field returned by a tool call in that turn. The LLM
must not generate, infer, or construct URLs from training data. If no data exists for
a question, the response must say "No data found in Cortex-Drive for X" — not a
training-data answer.

Enforcement is three-layer:
1. **System prompt** (`prompts/gateway_system_assistant.md`) — primary gate; REFERENCE
   LINKS rule requires verbatim tool-result URLs only; ZERO HALLUCINATION covers all
   tool results.
2. **Gateway post-response audit** (`cortex-gateway/index.js` `auditResponseUrls()`) —
   deterministic backstop; strips any URL not in the per-turn `seenUrls` set; logs
   every stripped URL as `[GROUNDING]`; cannot be overridden by prompt injection.
3. **This invariant** — code review gate; any PR weakening layers 1 or 2 must be
   rejected.

### 12. IcePanel Model Is a Pre-Change Check for High-Risk Paths, Not Optional Reading

Before proposing or implementing a change that touches any of the following, read the
corresponding Flow in `documents/architecture/icepanel-diagrams.md` and the relevant
objects/connections in `documents/architecture/icepanel/landscape-2026-09-21.yaml` first:

- Query round-trip (tool-calling loop, `search_enterprise_graph`, the `buildLlmToolContent()`/
  `mergeGraphData()` split) → Flow 1. Check before touching Invariant 6/AP-4.
- `connect_knowledge_on_demand` / bridge-relationship code → Flow 2. Check before touching
  Invariant 5 (zero-write).
- Conversation history reopen (`openHistoricalConversation`, `executeQuery`) → Flow 3a/3b.
- `classifyDomain()`'s `confident` branch or `domainInstruction` construction → Flow 4.
- `/api/get_node_details` or any Gateway→Bento call site → Flow 5a/5b. Check before touching
  AP-18.

This doesn't replace the invariants above — those stay the enforced rule. The diagrams are the
fastest way to see whether a proposed change is about to cross one of those lines *before*
writing code. If a change alters one of these paths, update the corresponding YAML
objects/connections and Flow step table in the same change — an unsynced diagram is worse than
no diagram.

### 13. Every Feature Is Designed for Every User Type and Visibility Tier

User types: platform owner, organization admin, organization member, external collaborator,
guest link. Reference: `documents/security/user-roles-and-access-model.md` (people) with
`documents/architecture/visibility-tiers-design-2026-10-23.md` (content); access = type × tier.
- Every feature design fills in the reference's §7 table: behaviour, enforcement point and a test
  for each user type, plus which tier its content lands in and what happens on revoke/removal.
  A design without it is not approved.
- Access decisions are deterministic code (Permify, tier rules, gateway/MCP checks), never an LLM
  or a prompt. Agents act on behalf of a user and never above that user's access.
- New hierarchy levels (groups, workspaces) are added as new Permify relations and new table
  columns, never by rewriting existing checks.

---

## File Ownership Map

| Concern | Authoritative File | Do Not Duplicate In |
|---|---|---|
| Domain node type lists | `src/mcp_server/domain_registry.py` | `index.js`, `expert_tools.py`, `dashboard/page.tsx` |
| Raw node label constants | `src/mcp_server/schema_guard.py` | Anywhere else |
| Traversal relationship whitelist | `src/mcp_server/schema_guard.py` (`TRAVERSAL_RELATIONSHIPS`) | Inline in any traversal method |
| Gateway domain manifest (JS) | `cortex-gateway/config/domain_manifests.json` | Inline sets in `index.js` |
| Intent classification patterns | `cortex-gateway/config/intent_registry.json` + `utils/intent_classifier.js` | System prompt |
| Routing name catalog (Phase E names, persons, bridges) | `src/mcp_server/entity_catalog.py` (builder) + `domain_registry.ROUTING_NAME_LABELS`; gateway cache `utils/entity_catalog.js` | `scripts/generate_entity_catalog.py` (thin caller only), inline label lists |
| System prompt | `prompts/gateway_system_assistant.md` | Inline strings in `index.js` |
| Architecture decisions | `documents/architecture/` | Code comments |
| Anti-pattern full narratives | `documents/architecture/anti-pattern-catalog.md` | This file (one-liners only here) |
| Security / GACL decisions | `documents/security/` | Code comments |
| User types and what each may do (Invariant 13) | `documents/security/user-roles-and-access-model.md` | Feature designs (they link and fill §7, never redefine roles) |
| Sprint / pending work | `documents/daily_logs/daily_log-<date>.md` | This file |
| Features and guardrails (demo, pitch, architecture reference) | `documents/cortex-drive-reference.md`; update it in the same change that adds or changes a feature or guardrail | Pitch decks, demo scripts |
| IcePanel diagram index (C4 model + Flows) | `documents/architecture/icepanel-diagrams.md` | IcePanel UI (Flows only — model is YAML-sourced from `documents/architecture/icepanel/landscape-2026-09-21.yaml`) |

---

## Service Map

| Service | Port | Entry point | Start command |
|---|---|---|---|
| MCP server (SSE) | 8080 | `src/mcp_server/cortex_os_mentalmodel_server_sse.py` | `.venv/bin/python src/mcp_server/cortex_os_mentalmodel_server_sse.py` |
| Bento server (HTTP) | 8000 | `src/mcp_server/cortex_os_mentalmodel_http_server.py` | `.venv/bin/python src/mcp_server/cortex_os_mentalmodel_http_server.py` |
| Gateway | 4000 | `cortex-gateway/index.js` | `cd cortex-gateway && node index.js` |
| Frontend | 3000 | `cortex-chat-ui/` | `cd cortex-chat-ui && rm -rf .next && npx next dev` |

Full restart: `tests/manage_all.sh`. Stop all: `tests/cleanup/kill_all.sh`.
Always use `.venv/bin/python` — never `python3`.
Always `rm -rf .next` before starting the frontend.

---

## Query Correctness Contract

These are the three query **patterns** that must work correctly for any user query.
The example strings are illustrative — any query of the same pattern must produce
the same quality of result.

| Pattern | Example query | Expected chat | Expected graph | Domain signal |
|---|---|---|---|---|
| **Single-domain retrieval** (podcast) | "Find episodes discussing graph databases" | Episode synthesis — titles, guests, grounded quotes. No hallucination. | Podcast backbone + Episode nodes only. Zero career nodes. | `podcast` |
| **Identity map** (career) | "Show career map of Sangeetha Ramadurai" | Chronological career narrative. All entities, no selective filtering. | Person anchor at center. Grouper nodes for Companies/TL/Hackathons/Education. Static layout. | `career` |
| **Cross-domain bridge** | "How did Sangeetha's thought leadership influence Cortex-Drive?" | Names specific TL nodes. Cites bridge_summary. States session-only virtual connections. | TL grouper + Concept/Tech anchors + Cortex-Drive Project. Gold dashed VIRTUAL_BRIDGE edges. | `cross_domain` |

**Graph correctness invariants across all patterns:**
- No cross-domain node contamination (career nodes in podcast result = bug at Cypher level)
- No duplicate nodes by `name::type` in the LLM summary
- No blank canvas when query returns data
- SYSTEM-tenant nodes visible only if `Technology`, `Concept`, `Topic`, or `Category`

---

## Anti-Pattern Catalog (Quick Reference)

One-line rules. Full incident details: `documents/architecture/anti-pattern-catalog.md`.

- **AP-1** — Build Cypher MATCH from `get_authorized_labels(domain_intent)`, not `DISCOVERY_LABELS`
- **AP-2** — Every `$param` passed to `_exec_query` must appear in the query string; grep to verify
- **AP-3** — Domain type sets belong in the registry; never inline in `index.js` or any application code
- **AP-4** — Graph tool results: compact summary to LLM via `buildLlmToolContent`, full payload to `accumulatedGraph`
- **AP-5** — When removing a function parameter, grep all callers immediately; use named-object params for ≥3 args
- **AP-6** — Kill/restart scripts must match what `lsof` reports; verify port and process name against the live system
- **AP-7** — Before adding a label to a domain's node_set, ask: does this concept exist in this domain?
- **AP-8** — Frontend restart: kill port 3000 → `rm -rf .next` → `npx next dev`; never skip the cache clear
- **AP-9** — Relationship type lists live in `schema_guard.py` as `TRAVERSAL_RELATIONSHIPS`; never inline
- **AP-10** — Helpers that must run on all output (affordance flags, normalization) must be called before every return path
- **AP-11** — `get_cluster_context` neighbor hop must block SYSTEM non-primitives; apply the same WHERE guard as `_fragment_neighbor_aggregation`
- **AP-12** — Post-commit: run one query per domain pattern before pushing; this is a hard gate
- **AP-13** — Before running any seeder, query the live graph for name collisions: `MATCH (n {name: "<target>"}) RETURN labels(n), n.tenant_id`
- **AP-14** — SYSTEM is curated built-in vocabulary only, never customer data; career nodes are org-tenant except the founder's career graph, which is PUBLIC (decision 2026-10-26, S2-44); seed scripts stamp tiers only on nodes they just created (`tenant_id IS NULL`), never with an unscoped `MATCH (n) SET n.tenant_id`; `buildLlmToolContent` deduplicates by `name::type` as permanent contract
- **AP-15** — Every URL in a response must appear verbatim in a tool result from that turn; `auditResponseUrls()` strips violations; `[GROUNDING]` in gateway console = hallucinated URL
- **AP-16** — Tool shortcuts that return backbone-only results must be gated on an explicit signal (`wants_visual_map=True`), never on keyword content; keyword content is unpredictable and will eventually match the wrong condition
- **AP-17** — Use `res.on('close')` with `!res.writableEnded` to detect client disconnect; `req.on('close')` fires on TCP half-close (client done sending) and is a false positive during long-running async handlers
- **AP-18** — Only use `createProxyMiddleware` for SSE/WebSocket/streaming routes; for plain JSON endpoints use a direct `fetch`. `app.use('/full/path', proxy)` strips the mount path before the proxy sees `req.url` — `pathRewrite` must match the stripped remainder, not the full path
- **AP-19** — Any Cypher anchor MATCH using `CONTAINS` or fuzzy predicates must also exclude bridge-label types (`AND NOT n:{bridge_labels}`); a bridge-label node selected as anchor blocks all traversal paths via the path filter, silently returning only the anchor itself
- **AP-20** — For `domainSignal=career`, always force `wants_visual_map=false` on `search_enterprise_graph` before calling the MCP tool; `wants_visual_map=true` returns backbone Category nodes only, which starves the Q2 writer (it needs Company/Role/Project types), silently falling back to hallucinated LLM text while the graph renders correctly from the auto-inject
- **AP-21** — `classifyDomain()` must never return `'unknown'`; the safe default is `'career'` because this graph is about one person and unmatched queries are almost always career-intent. `unknown` bypasses the domain guard and causes graph explosion. Extend the career regex pattern rather than accepting unknown as a valid signal
- **AP-22** — The `/query` response cache is an allowlist: cache only `isCacheableResponse()` successes (non-empty answer, no tool failure, graph data present). MCP tools report failures in-band as `{"error": ...}` rather than throwing — `isToolErrorResult()` must count those as failures. Never cache "no data"/"no bridge" answers; override with `forceRefresh` or `POST /api/cache/invalidate`. The cache lives in Redis (`qcache:{tenant}:…`) so invalidation is fleet-wide — never move it back in-process
- **AP-23** — Identity headers (`x-user-id`, `x-tenant-id`, `x-raw-user-id`, `x-schema-readable`, `x-guest-share-anchor`) are set only by gateway middleware; `stripClientIdentityHeaders()` removes client-sent values before auth. "Verified guest" is `req.guestAuth`, never a header check. Any new trusted header must be added to `GATEWAY_ASSIGNED_HEADERS`
- **AP-24** — No credential may have an in-code default, appear in the frontend bundle, or map to the owner's user/tenant. Trial `x-api-key` access is off unless `PUBLIC_TRIAL_API_KEY`/`_USER_ID`/`_TENANT_ID` are all set (never the owner's in production). Runbook: `documents/security/trial-key-and-query-cache-redis-rollout-2026-09-29.md`
- **AP-25** — Grounding rules must be enforced deterministically, not just prompted: if ≥1 data tool ran and none returned evidence (nodes surviving the domain guard, bridges, or non-error non-empty text), the gateway replaces the answer with "No data found in Cortex-Drive for …". For a confident single-domain signal the gateway rewrites `search_enterprise_graph` `domain_intent` "all"/missing to that domain (AP-20 pattern) — never let the domain guard be the primary filter
- **AP-26** — LLM-callable raw query tools must be read-only (database-enforced READ access mode), owner-only, and never in the chat or guest tool lists; guest restrictions are enforced in code (`cortex-gateway/utils/tool_policy.js` allowlist + per-call check), never by prompt alone. `run_cypher_query` was LLM- and guest-callable with write access until S2-20 (2026-10-20)
- **AP-27** — Identity overrides are explicit allowlists, never `X || real_id`: only `OWNER_USER_ID` + `OWNER_CLERK_SUBS` map to the owner (`utils/identity.js`). Tenant-wide visibility (`tenant_id` fallback in `_get_security_clause`) is owner-only; every other user sees strictly the Permify allowlist and nothing when Permify fails. Share/group routes carry an ownership check (`utils/share_authz.js`). Until S2-42 (2026-10-23) every signed-in user was the owner
- **AP-29** — In single-domain search, shared-type nodes (Concept, Technology, Person, Topic, ReferenceLink) qualify only if SYSTEM/PUBLIC or linked to a label exclusive to that domain. Exclusive labels are computed by `domain_registry.get_exclusive_labels()` from the manifests — never hand-list them (M5-4, 2026-10-27)
- **AP-30** — Routing data obeys the same visibility as answers: a catalog name may route a question only if the asker can open that node (`buildRoutingLookups()`: owner, SYSTEM/PUBLIC, or Permify allowlist). Any code path that adds or removes a source must `INCR entcat_version:{tenant}` (`entity_catalog.bump_version`); the gateway refetches the catalog from Bento on change (S2-60, 2026-10-27)
- **AP-28** — Authorization-store deletes go through exact-match builders (`exactTupleFilter` / `_exact_tuple_filter`; Permify filters take `ids` lists and silently ignore unknown keys, which widens a delete) and are tested against the real Permify image (`tests/integration/verify_permify_deletes_live.js`). Never swallow an authorization write/delete error

---

## Key Architecture Documents

Full index with status (Active / Historical / Superseded): **`documents/INDEX.md`**

Most-referenced active docs:
- `documents/architecture/anti-pattern-catalog.md` — full AP incident records
- `documents/architecture/query-behavior-specification.md` — query pattern logic, virtual_links pipeline
- `documents/security/permission-resolution-caching-architecture-2026-06-23.md` — Redis permission caching (historical OpenFGA design; authorization is Permify-only since the 2026-10-21 OpenFGA decommission: `documents/architecture/openfga-decommission-2026-10-21.md`)
- `documents/daily_logs/` — session logs; most recent contains current sprint items
