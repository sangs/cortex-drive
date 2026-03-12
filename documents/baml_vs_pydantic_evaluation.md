# Evaluation: BAML vs. Pydantic for CortexModel Ingestion

This report evaluates **BAML** (Boundary AI Markup Language) against our current **Pydantic**-based approach for structured LLM data extraction in the CortexModel project.

## 1. Overview

| Feature | BAML (Boundary ML) | Pydantic (with Instructor) |
| :--- | :--- | :--- |
| **Core Nature** | Domain-Specific Language (DSL) | Python Library / Native Type Hints |
| **Approach** | Contract-First (Generates Client Code) | Integration-First (Patches LLM Clients) |
| **Parsing** | Schema-Aligned Parsing (SAP) | Runtime Validation + Retries |
| **Tooling** | VS Code Playground + Build Step | Native Python Debugger + No Build Step |
| **Language** | Multi-lang (Python, TS, Go, etc.) | Python-centric |

---

## 2. BAML: Pros & Cons

### Pros
- **Superior Reliability (SAP)**: BAML's Schema-Aligned Parsing can fix malformed JSON (missing brackets, quotes) without re-calling the LLM. This makes small models (GPT-4o-mini, local models) behave like much larger ones.
- **Token Efficiency**: BAML uses a significantly more compressed representation of schema than JSON Schema, saving 20-50% on prompt tokens.
- **Developer Experience**: The dedicated VS Code playground allows you to see exactly what the LLM receives and outputs in real-time, side-by-side with your code.
- **Prompt Functions**: Treats prompts as real functions with inputs and outputs, keeping them out of your application logic files.

### Cons
- **Learning Curve**: You must learn a new (albeit simple) syntax for `.baml` files.
- **Build Process**: Requires a compiler step to generate the Python client.
- **Tooling Dependency**: Relies on the Boundary ML VS Code extension for the best experience.

---

## 3. Pydantic (Current): Pros & Cons

### Pros
- **Zero Friction**: No new language to learn; it's just Python.
- **Ecosystem Integration**: Works perfectly with FastAPI, PydanticAI, and our current `expert_tools.py`.
- **Transparency**: No hidden code generation; what you see in `schema_guard.py` is exactly what validates the data.

### Cons
- **Brittle Parsing**: If an LLM misses a closing bracket or comma, Pydantic validation fails, requiring a costly retry (`n` additional API calls).
- **Prompt Bloat**: Large schemas (like our Episode -> Topic -> Technology hierarchy) consume significant tokens just to describe the structure in the prompt.

---

## 4. Strategic Recommendation for CortexModel

### Current State (Stay with Pydantic)
Maintain the **Pydantic Schema Guard** for the immediate Phase 1 (Local File Ingestion). Since the transcript data is currently trusted and structured, the overhead of BAML isn't strictly necessary yet.

### Future State (Switch to BAML)
We should transition to **BAML** specifically for the **Scenario 4 (Media Links)** and **Scenario 2/3 (Raw Web Scrapes)** where we encounter high-noise data. 
- **Reasoning**: When we ask an LLM to "extract the graph from this 40-minute transcript," the output will be huge. BAML's **Schema-Aligned Parsing** will save us from thousands of failed 400 Bad Request errors that occur when long JSON outputs are truncated or slightly malformed.

### Decision matrix
- **If you Value Speed of Implementation**: Stick with **Pydantic**.
- **If you Value Cost & Reliability (Scale)**: Move to **BAML**.

**Would you like me to try converting just the `EpisodeNode` search to BAML as a proof-of-concept?**
