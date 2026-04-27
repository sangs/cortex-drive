# Cortex-Drive — Architecture Guardrails for Claude Code

This file is read automatically at every session start. It encodes non-negotiable architectural rules, anti-patterns from past incidents, file ownership, and canonical test expectations. Before writing any code, verify it does not violate any rule below.

---

## Project Overview

Cortex-Drive is a zero-trust, multi-domain knowledge graph system. It connects a podcast episode graph (transcripts, topics, guests) with a professional resume graph (projects, companies, thought leadership) in Neo4j. Queries are routed through a gateway (Node.js) to an MCP server (Python/FastAPI) and rendered as an interactive graph + chat UI (Next.js).

**Current domains:** `podcast`, `career`, `cross_domain`  
**Canonical test queries:** Q1, Q2, Q3 — see section below.

---

## Architecture Invariants — Non-Negotiable Rules

### 1. No Hardcoding — Every Repeated Value Must Be a Named Constant

**Any value that appears in logic — a list of strings, a type name, a port number, a threshold — must be defined as a named constant and imported wherever it is used. Inline literals are never acceptable.**

- Python constants belong in `schema_guard.py` (schema primitives) or `domain_registry.py` (domain logic). Import from there — do not re-declare.
- JS/TS constants belong in `cortex-gateway/config/*.json` files loaded at startup, or as `const` at the top of the module — never inline in a function body.
- If you find yourself writing the same string or array in two places, stop. Extract it first.

This rule subsumes AP-3 and AP-9. Every past incident where a hardcoded list drifted or was missed during an update traces back to this violation.

### 2. Single Source of Truth for Domain and Schema Definitions

`src/mcp_server/schema_guard.py` owns all raw schema primitives:
- `CORTEX_DRIVE_NODES`, `PROJECT_GRAPH_NODES` — node label lists per domain
- `CORTEX_DRIVE_RELATIONSHIPS`, `PROJECT_GRAPH_RELATIONSHIPS` — relationship type lists per domain
- `TRAVERSAL_RELATIONSHIPS` — permitted set for neighbor-traversal Cypher queries (`_fragment_neighbor_aggregation`, `expand_node_topology`)

`src/mcp_server/domain_registry.py` owns all domain logic built on top of those primitives:
- `DOMAIN_MANIFESTS` — per-domain node type sets (imports from `schema_guard.py`)
- `get_authorized_labels(domain_intent)` — returns the inclusion list for a given domain

`cortex-gateway/config/domain_manifests.json` mirrors `domain_registry.py` for the JS gateway — must stay in sync whenever `schema_guard.py` or `domain_registry.py` changes.

**Never define node type lists, relationship type lists, or domain manifests inline in application code** — not in `index.js`, not in `expert_tools.py`, not in `dashboard/page.tsx`.

### 3. Domain Filtering Must Be Inclusion-Based, Not Exclusion-Based

Exclusion lists (`CAREER_EXCLUSIVE_TYPES`, `PODCAST_EXCLUSIVE_TYPES`) do not scale. With N domains, exclusion requires N(N-1) lists updated in lockstep. Inclusion requires N manifests.

**Correct pattern:** For a podcast query, match only `{node_types from DOMAIN_MANIFESTS["podcast"]}`.  
**Wrong pattern:** Match everything, then filter out career types.

The Cypher MATCH clause in `search_enterprise_graph` must be built from `get_authorized_labels(domain_intent)`, not from `DISCOVERY_LABELS` (which is the full union and is for schema documentation only).

### 4. Cypher Parameter Discipline — No Orphaned Parameters

Every parameter passed to `driver.execute_query()` must be referenced by `$param_name` inside the Cypher query string. Orphaned parameters are silently ignored by Neo4j — they do not cause errors and produce wrong results.

**Before closing any Cypher change:** grep the query string for every parameter name passed in the `execute_query` call.

### 5. Zero-Write Rule for Virtual Bridges

Cross-domain bridges discovered by `connect_knowledge_on_demand` are **session-only**. Nothing is written to Neo4j. Virtual links (`VIRTUAL_BRIDGE` type) exist only in `accumulatedGraph.virtual_links` and are cleared on page refresh.

No `MERGE`, `CREATE`, or `SET` statements may touch bridge/virtual relationship types in Neo4j. If a Cypher query touches these types, it is a bug.

### 6. Graph Tool Results Must Never Enter the LLM Message Loop in Full

Graph tools (`search_enterprise_graph`, `get_cluster_context`, `connect_knowledge_on_demand`) return large JSON payloads. The full payload goes to `accumulatedGraph` for visualization. A compact summary (node names + count) goes to the LLM via `buildLlmToolContent()`.

**Never pass raw `toolContent` from a graph tool directly to `messages.push({role: "tool", content: toolContent})`.**

### 7. Domain Guard Is a Safety Net, Not Primary Logic

The gateway domain guard in `index.js` (filtering `accumulatedGraph.nodes` by domain signal) is a last-resort backstop. Primary domain filtering happens at the Cypher level (`expert_tools.py`). If the gateway guard is the only thing preventing career nodes from appearing in a podcast query, that is a sign the Cypher is wrong — fix the Cypher, not just the guard.

### 8. Intent Classification Before LLM Call

Domain signal must be determined by `classifyDomain()` in `lib/intent_classifier.js` **before** the LLM call. The LLM must not be the first (or only) system deciding what domain a query belongs to.

`domain_signal` is injected into the system prompt as `domain_context` and returned in the response JSON. The frontend consumes it via `domainToBackbone()` — no guessing from node types.

---

## File Ownership Map

| Concern | Authoritative File | Do Not Duplicate In |
|---|---|---|
| Domain node type lists | `src/mcp_server/domain_registry.py` | `index.js`, `expert_tools.py` (inline), `dashboard/page.tsx` |
| Raw node label constants | `src/mcp_server/schema_guard.py` | Anywhere else |
| Relationship type lists (traversal whitelist) | `src/mcp_server/schema_guard.py` (`TRAVERSAL_RELATIONSHIPS`) | Inline arrays in `expert_tools.py` or anywhere else |
| Gateway domain manifest (JS) | `cortex-gateway/config/domain_manifests.json` | Inline sets in `index.js` |
| Intent classification patterns | `cortex-gateway/config/intent_registry.json` + `lib/intent_classifier.js` | System prompt tiers |
| System prompt | `prompts/gateway_system_assistant.md` | Inline strings in `index.js` |
| Architecture decisions | `documents/architecture/` | Code comments |
| Anti-pattern catalog + lessons | `documents/daily_log-*.md` + this file | Nowhere — rules extracted to this file |

---

## Service Map

| Service | Port | Entry point | Start command (from project root) |
|---|---|---|---|
| MCP server (SSE) | 8080 | `src/mcp_server/cortex_os_mentalmodel_server_sse.py` | `.venv/bin/python src/mcp_server/cortex_os_mentalmodel_server_sse.py` |
| Bento server (HTTP) | 8000 | `src/mcp_server/cortex_os_mentalmodel_http_server.py` | `.venv/bin/python src/mcp_server/cortex_os_mentalmodel_http_server.py` |
| Gateway | 4000 | `cortex-gateway/index.js` | `cd cortex-gateway && node index.js` |
| Frontend | 3000 | `cortex-chat-ui/` | `cd cortex-chat-ui && rm -rf .next && npx next dev` |

Use `tests/manage_all.sh` for full restart. Use `tests/cleanup/kill_all.sh` to stop everything.  
Always use `.venv/bin/python` — never `python3` (system Python lacks project dependencies).  
Always `rm -rf .next` before starting the frontend — stale Turbopack cache causes crashes.

---

## Canonical Test Queries

These three queries define correct system behavior. Every code change must be verified against all three before declaring complete.

### Q1 — "Find episodes discussing graph databases, AI"
- **Chat:** Episode Synthesis — title, guest, key technical quotes from transcript chunks. No hallucination.
- **Graph:** Podcast backbone + Episode nodes only. Zero career nodes (Company, Role, ThoughtLeadership, Hackathon, Category named after career domains). Topics/Guests hidden until double-click on Episode.
- **Domain signal:** `podcast`

### Q2 — "Show career map of Sangeetha Ramadurai"
- **Chat:** Career narrative descending chronological. All entities included (no selective filtering). Reference links listed.
- **Graph:** Sangeetha Person node at center. Grouper nodes: Companies(N), Thought Leadership(N), Hackathons(N), Education(N). Individual items hidden until double-click. Static converged layout — not oscillating.
- **Domain signal:** `career`

### Q3 — "How did Sangeetha's thought leadership influence the design of Cortex-Drive?"
- **Chat:** Names specific ThoughtLeadership nodes. Cites `bridge_summary` verbatim. Explains shared concept anchors. States these are session-only virtual connections.
- **Graph:** Thought Leadership grouper + Concept/Technology anchor nodes + Cortex-Drive Project node. Gold dashed lines (VIRTUAL_BRIDGE) connecting them. Gold dashes survive grouper double-click (virtual links rewired to children).
- **Domain signal:** `cross_domain`

---

## Anti-Pattern Catalog

Each entry: what went wrong → concrete rule to apply next time.

### AP-1: Cypher MATCH ignoring domain_intent
**Incident (2026-04-27):** `search_enterprise_graph` always used `DISCOVERY_LABELS` (all node types) in the MATCH clause regardless of `domain_intent`. Career Category nodes ("Professional Experience", "Hackathons") appeared in Q1 podcast graph because they matched keyword "AI" in their descriptions.  
**Rule:** Build the Cypher MATCH label string from `get_authorized_labels(domain_intent)`. The MATCH clause is the first filter — get it right there, not downstream.

### AP-2: Orphaned Cypher parameter
**Incident (2026-04-27):** `$allowed_labels` was passed to `execute_query` but had no corresponding reference in the Cypher query string. Neo4j silently ignored it. Domain filtering appeared to be active but was not.  
**Rule:** After writing any `execute_query` call, grep the query string for every parameter name. If a param has no `$` reference, it is dead and the query is wrong.

### AP-3: Exclusion lists duplicated outside the registry
**Incident (2026-04-27):** `CAREER_EXCLUSIVE_TYPES` and `PODCAST_EXCLUSIVE_TYPES` were defined inline in `cortex-gateway/index.js`. These are manual copies of information that belongs in `domain_registry.py`. They drifted (missing `Category` nodes) causing filter gaps.  
**Rule:** Never define domain type sets outside the registry. JS gateway reads `config/domain_manifests.json`; Python reads `domain_registry.py`. Both derive from `schema_guard.py` constants.

### AP-4: Graph payload in LLM message loop
**Incident (2026-04-27):** Full `toolContent` from `search_enterprise_graph` (tens of thousands of tokens of graph JSON + transcript chunks) was pushed directly to `messages`. Triggered 197k-token TPM error on GPT-4o (limit: 30k).  
**Rule:** Graph tools → `buildLlmToolContent()` (compact summary to LLM) + `mergeGraphData()` (full data to accumulatedGraph). These are two separate consumers of the same tool result.

### AP-5: Dead code parameter surviving in callers
**Incident (2026-04-26):** `isContextualFusion` was removed from `mcp-client.ts::query()` signature but `use-mcp.ts` still passed it as the 4th positional argument. The next parameter (`signal: AbortSignal`) received `false` (boolean), causing a runtime fetch error: "Failed to convert value to AbortSignal".  
**Rule:** When removing a parameter from a function signature, immediately grep all callers in the same change. Use TypeScript named-object parameters (not positional) for functions with ≥3 arguments to make this class of bug a compile error.

### AP-6: Wrong process targeted by kill script
**Incident (2026-04-27):** `tests/cleanup/kill_bento.sh` targeted port 5000 and searched for `bentoml` — a completely different framework from the actual Bento server (`cortex_os_mentalmodel_http_server.py` on port 8000).  
**Rule:** Kill/restart scripts must be verified against the actual running system when the server implementation changes. Port and process name must match what `lsof` reports for the live process.

### AP-7: `ThoughtLeadership` in podcast node_set
**Incident (2026-04-27):** `domain_registry.py` podcast `node_set` included `ThoughtLeadership` because `PROJECT_GRAPH_NODES` (a career-domain constant) was mixed into the podcast manifest. This allowed ThoughtLeadership nodes to pass `get_authorized_labels("podcast")`.  
**Rule:** Before adding a label to a domain's `node_set`, ask: "Does this concept exist in this domain?" ThoughtLeadership is a career/resume artifact. It has no business in podcast graph results.

### AP-8: `npm run dev` instead of `npx next dev` on restart
**Incident (2026-04-26):** Restarting the frontend without clearing `.next` cache caused a Turbopack panic on SST files. The old port was also still held by a zombie process.  
**Rule:** Frontend restart sequence: (1) `kill -9 $(lsof -ti:3000)`, (2) `rm -rf .next`, (3) `npx next dev`. Never skip step 2 after a crash.

### AP-9: Hardcoded relationship type list in Cypher traversal methods
**Incident (2026-04-27):** `_fragment_neighbor_aggregation` and `expand_node_topology` each contained an inline Python list/string of permitted relationship types. Adding `HAS_EPISODE` required finding and editing two separate locations. Neither list was the same (one had `MENTIONS`/`COVERS`, the other didn't), so the two methods silently diverged.  
**Rule:** All relationship type lists live in `schema_guard.py` as named constants. Import `TRAVERSAL_RELATIONSHIPS` and serialize with `json.dumps()`. One edit, both methods stay in sync.

### AP-10: Transformation not applied in all return paths of a multi-path function
**Incident (2026-04-27):** `parseDataToGraph` in `dashboard/page.tsx` has two code paths — one for gateway's `{ nodes, links }` format (early `return`) and one for the bento array format. Affordance flag assignment (`isExpandable`, `isBentoEligible`) was only in the lower path. Nodes returned via the early-return path always had `undefined` affordance flags, so badges never rendered and click handlers silently did nothing.  
**Rule:** Any helper that must run on all output (affordance flags, schema normalization, field coercion) must be extracted to a named function and called immediately before **every** return statement — not just the last one. Never assume a shared block at the bottom of a function is "the only exit."

---

## Current Sprint — Pending Implementation (as of 2026-04-27)

Read `documents/daily_log-2026-04-27.md` for full context on each item.

### Priority 1 — Fix Q1 graph contamination (three-layer domain filtering fix)

All three layers must be implemented together and tested as a unit.

**Layer 1a — `src/mcp_server/domain_registry.py`**
- Remove `ThoughtLeadership` from podcast `node_set` (currently inherited from `PROJECT_GRAPH_NODES`)
- Change: `"node_set": CORTEX_DRIVE_NODES + ["Publication", "Community", "Category"]`

**Layer 1b — `src/mcp_server/expert_tools.py` — `search_enterprise_graph` method (~line 1090)**
- Replace `{discovery_labels}` in the Cypher MATCH clause with a domain-specific label string
- Build it from `get_authorized_labels(domain_intent)` — already imported
- `domain_intent="all"` → use `discovery_labels` (unchanged for cross-domain)
- `domain_intent="podcast"` or `"professional"` → use only those domain's authorized labels
- This is an **inclusion** gate — see AP-1 and AP-2 in Anti-Pattern Catalog

**Layer 2 — `src/mcp_server/expert_tools.py` — `_fragment_neighbor_aggregation` method (~line 71)**
- Add one WHERE predicate to the OPTIONAL MATCH:
  `AND ($allowed_labels IS NULL OR any(label IN labels(neighbor) WHERE label IN $allowed_labels))`
- `$allowed_labels` is already passed to `execute_query` at line 1197 but never referenced in Cypher (AP-2)

**Layer 3a — NEW FILE `cortex-gateway/config/domain_manifests.json`**
- Create inclusion manifest: `{ "podcast": { "node_types": [...] }, "career": { "node_types": [...] } }`
- Derive from `domain_registry.py` DOMAIN_MANIFESTS — must stay in sync
- This is the JS gateway's authoritative source for domain types (replaces hardcoded sets)

**Layer 3b — `cortex-gateway/index.js`**
- Load `domain_manifests.json` at startup
- Replace `CAREER_EXCLUSIVE_TYPES` and `PODCAST_EXCLUSIVE_TYPES` hardcoded sets with manifest-driven inclusion filter:
  `accumulatedGraph.nodes = accumulatedGraph.nodes.filter(n => allowedTypes.has(n.type))`
- Delete the two hardcoded `const` declarations at lines 8-9

**After implementing:** restart MCP + Gateway, then test Q1, Q2, Q3. All three must pass before marking done.

### Priority 2 — Implement `connect_knowledge_on_demand` MCP tool (Q3 bridge discovery)

Full plan at: `.claude/plans/explain-fix-6-implement-humming-alpaca.md`

Files to change:
1. `src/mcp_server/expert_tools.py` — add `connect_knowledge_on_demand()` method after `get_cluster_context`
2. `src/mcp_server/cortex_os_mentalmodel_server_sse.py` — register as MCP tool
3. `cortex-gateway/index.js` — add to `mcpToolsDefinitions` array
4. `cortex-chat-ui/app/dashboard/page.tsx` — `handleDiscoverBridge` already calls it; update args

---

## Key Architecture Documents

For deeper context on decisions referenced above:

- `documents/architecture/intent-classification-research-2026-04-25.md` — Intent classifier design, embedding similarity approach, intent registry schema, scalability analysis
- `documents/architecture/query-behavior-specification.md` — Q1/Q2/Q3 expected behavior, logic walkthrough, virtual_links pipeline
- `documents/architecture/ontology-persistence-vs-virtual-bridges.md` — Zero-write rule rationale, Palantir Foundry Virtual Ontology pattern
- `documents/daily_log-2026-04-25.md` — Intent classification implementation decisions
- `documents/daily_log-2026-04-27.md` — Q1 contamination root cause, token limit fix, inclusion vs exclusion decision, constant ownership audit
