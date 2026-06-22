# Cortex-Drive — Architecture Guardrails for Claude Code

Read at every session start. Non-negotiable rules, file ownership, and active
anti-patterns. Before writing any code, verify it does not violate any rule below.
Full AP incident narratives: `documents/architecture/anti-pattern-catalog.md`.

---

## Project Overview

Cortex-Drive is a zero-trust, multi-domain knowledge graph system connecting a podcast
episode graph (transcripts, topics, guests) with a professional resume graph (projects,
companies, thought leadership) in Neo4j. Gateway: Node.js. MCP server: Python/FastAPI.
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

### 9. SYSTEM Tenant Is for Ontological Primitives Only

`Technology`, `Concept`, `Topic`, `Category` nodes may be SYSTEM-tenant (globally
visible landmarks). `Company`, `Startup`, `Project`, `Role`, `Hackathon`, `Person`
nodes are always org-tenant. Never `MERGE` a career node with `tenant_id = 'SYSTEM'`.

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

---

## File Ownership Map

| Concern | Authoritative File | Do Not Duplicate In |
|---|---|---|
| Domain node type lists | `src/mcp_server/domain_registry.py` | `index.js`, `expert_tools.py`, `dashboard/page.tsx` |
| Raw node label constants | `src/mcp_server/schema_guard.py` | Anywhere else |
| Traversal relationship whitelist | `src/mcp_server/schema_guard.py` (`TRAVERSAL_RELATIONSHIPS`) | Inline in any traversal method |
| Gateway domain manifest (JS) | `cortex-gateway/config/domain_manifests.json` | Inline sets in `index.js` |
| Intent classification patterns | `cortex-gateway/config/intent_registry.json` + `utils/intent_classifier.js` | System prompt |
| System prompt | `prompts/gateway_system_assistant.md` | Inline strings in `index.js` |
| Architecture decisions | `documents/architecture/` | Code comments |
| Anti-pattern full narratives | `documents/architecture/anti-pattern-catalog.md` | This file (one-liners only here) |
| Security / GACL decisions | `documents/security/` | Code comments |
| Sprint / pending work | `documents/daily_logs/daily_log-<date>.md` | This file |

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
- **AP-14** — SYSTEM tier is ontological primitives only; career nodes (Company/Project/Role/Startup) are always org-tenant; `buildLlmToolContent` deduplicates by `name::type` as permanent contract
- **AP-15** — Every URL in a response must appear verbatim in a tool result from that turn; `auditResponseUrls()` strips violations; `[GROUNDING]` in gateway console = hallucinated URL
- **AP-16** — Tool shortcuts that return backbone-only results must be gated on an explicit signal (`wants_visual_map=True`), never on keyword content; keyword content is unpredictable and will eventually match the wrong condition
- **AP-17** — Use `res.on('close')` with `!res.writableEnded` to detect client disconnect; `req.on('close')` fires on TCP half-close (client done sending) and is a false positive during long-running async handlers
- **AP-18** — Only use `createProxyMiddleware` for SSE/WebSocket/streaming routes; for plain JSON endpoints use a direct `fetch`. `app.use('/full/path', proxy)` strips the mount path before the proxy sees `req.url` — `pathRewrite` must match the stripped remainder, not the full path
- **AP-19** — Any Cypher anchor MATCH using `CONTAINS` or fuzzy predicates must also exclude bridge-label types (`AND NOT n:{bridge_labels}`); a bridge-label node selected as anchor blocks all traversal paths via the path filter, silently returning only the anchor itself

---

## Key Architecture Documents

- `documents/architecture/anti-pattern-catalog.md` — full AP incident records (AP-1 through AP-17)
- `documents/architecture/orchestration-loop-incident-2026-05-04.md` — deep-dive: 4-bug chain that caused "Maximum orchestration loops reached"; diagnostic checklist for future loop errors
- `documents/architecture/query-behavior-specification.md` — query pattern logic walkthrough, virtual_links pipeline
- `documents/architecture/intent-classification-research-2026-04-25.md` — intent classifier design
- `documents/architecture/ontology-persistence-vs-virtual-bridges.md` — zero-write rule rationale
- `documents/security/` — all GACL, permission-graph, zero-trust, sharing architecture docs
- `documents/daily_logs/` — session logs; most recent contains current sprint items
