# CortexDrive: Future Architecture & Feature Proposal

This document outlines the strategic evolution of **CortexDrive** and the **cortex-model**, addressing advanced ingestion, collaboration, and role-based knowledge templates.

## 1. UI Adequacy Assessment
The current UI (v1) provides a strong foundation by visualizing the **Knowledge Graph** and **AI Chat** in a unified dark-mode workspace. 

### What's Addressed:
- **Tenant Context**: The Clerk Org Switcher explicitly handles data isolation.
- **Explainability**: A2UI components (source links, data cards) provide transparency for AI answers.
- **Relational View**: The graph successfully maps the connections within the cortex-model.

### Necessary UI Evolutions:
- **Ingestion Center**: A new dashboard view or "Upload" modal to handle transcript uploads and URL inputs.
- **Progress Tracking**: Real-time visualization of the ingestion pipeline (fetching → transcribing → chunking → embedding).
- **Sharing Modal**: A Google Drive-style interface for managing user access levels (Owner, Editor, Viewer).
- **Template Gallery**: A marketplace or selector for starting a specialized model (e.g., "Architect Mode").

---

## 2. Dynamic Ingestion Architecture
To move from manual server-side scripts to user-driven ingestion, we propose an **Asynchronous Pipeline**.

### Proposed Workflow:
1. **Frontend**: User provides a Podcast URL or uploads a `.txt`/`.pdf`/`.mp3`.
2. **Gateway**: Receives the request and publishes a message to a **Pub/Sub Queue**.
3. **Ingestion Worker (Cloud Run)**: 
   - **Step A: Retrieval**: Uses tools like `yt-dlp` or `web-scrapers` to fetch content.
   - **Step B: Processing**: If audio, runs through **Whisper** or **Gemini Multimodal** for transcription.
   - **Step C: Transformation**: High-precision chunking and OpenAI/Gemini embedding.
   - **Step D: Storage**: Pushes nodes to Neo4j with the user's `tenant_id`.
4. **Real-time Feedback**: Uses **SSE (Server-Sent Events)** to update the UI status ("Processing segment 4/10...").

---

## 3. Collaboration & Sharing Model
Currently, `cortex-model` is strictly isolated by `org_id`. We propose transition to a **Graph-Based Access Control List (ACL)**.

### The "Permission Graph" in Neo4j:
We can model permissions directly within the graph to allow fine-grained sharing:
```cypher
(:User {id: 'user_A'})-[:CAN_READ {since: timestamp()}]->(:CortexModel {id: 'marketing_model'})
```
- **"Private by Default"**: Every node created is tagged with an `OwnerID`.
- **"Sharing"**: Creating a relationship between a target user and a specific model or sub-graph.
- **Middleware Update**: The `TenantMiddleware` will be updated to check `IS_MEMBER_OF` or `HAS_ACCESS_TO` relationships before allowing queries.

---

## 4. Multi-Source Templates & Hybrid Roles
The true power of the `cortex-model` lies in moving beyond podcasts to a **Unified Knowledge Mesh**.

### High-Level Concept: "Cortex Blueprints"
A **Blueprint** is a configuration file (JSON/YAML) that defines the ingestion and reasoning schema for a specific role.

#### Example: "Architect + CTO" Hybrid Template
- **Sources**: 
    - [Confluence] Architecture Decision Records
    - [Obsidian] personal research notes
    - [GitHub] Repository READMEs
    - [Notion] Budget & Roadmap pages
- **Reasoning Schema**: Prioritizes technical trade-offs (Architect) combined with cost/timeline awareness (CTO).

### Personalized Models (`<person-name>-cortex-model`)
Users can "subscribe" to multiple sources that define their personal professional context. The AI assistant then acts as a **Digital Twin**, capable of answering questions with data from these diverse silos:
- *"According to my Notion notes and the Architect blueprints, does this new service fit our cost-to-scale ratio?"*

---

## 5. Strategic Opinion
The current architecture is **perfectly positioned** for this evolution. Because we chose **Neo4j**, adding additional nodes for PDF metadata or Obsidian backlinks doesn't require a schema redesign—it simply grows the graph. 

The immediate next step should be **closing the loop on manual ingestion** by building the Cloud Run background worker, allowing the system to scale beyond pre-processed datasets.
