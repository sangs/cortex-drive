# Architectural Inspiration: Google Drive & NotebookLM for CortexDrive

This document explores how the design patterns of **Google Drive** (Sharing & Permissions) and **NotebookLM** (Source Integration & Persistence) inspire the future architecture of **CortexDrive**, the **cortex-model**, and **Cortex Blueprints**.

---

## 1. Google Drive: The Sharing & Collaboration Model
Google Drive’s success lies in its granular **Access Control List (ACL)** and the concept of a **Shared File System**. 

### Architectural Inspirations:
- **ACL as a Graph (Backend)**: 
    - *Idea*: In Neo4j, permissions are not just a column; they are **First-Class Relationships**. 
    - *Mapping*: `(:User {id: 'A'})-[:CAN_ACCESS {role: 'EDITOR'}]->(:CortexModel {id: 'M1'})`. 
    - *Benefit*: This allows for complex sharing logic, such as "User A can see the Model, but only the nodes related to 'Architecture', not 'Budget'."
- **Hierarchical Inheritance**:
    - *Idea*: If a user shares a `CortexModel`, the access should cascade to all `Episode`, `Concept`, and `Topic` nodes within it.
- **Sharing Sidebar (Frontend)**:
    - *Idea*: A "Google Drive-style" share button that opens a modal to invite others via email, assigning them roles (Viewer, Editor, Owner).

---

## 2. NotebookLM: Source Centralization & Contextual Grounding
NotebookLM revolutionizes AI interaction by making the **Source** the center of the experience, rather than the chat history.

### Architectural Inspirations:
- **The "Source Shelf" (Frontend)**:
    - *Idea*: A persistent list in the sidebar where users see all ingested items (Podcast URLs, Uploaded PDFs, Pasted Notes).
    - *Context Toggling*: Users can "Toggle ON/OFF" specific sources to control exactly what data the AI uses for a specific answer.
- **Asynchronous Ingestion Pipeline (Backend)**:
    - *Idea*: Use a worker-queue pattern (like Google’s internal infra). When a URL is pasted, the system creates a "Placeholder Node" in Neo4j and kicks off a background task to scrape, transcribe, and embed.
- **Persistent Memory Layer**:
    - *Idea*: Unlike a simple chatbot, CortexDrive is a **Research Environment**. Sources should be indexed once and available forever across different "Blueprints."

---

## 3. CortexDrive: The Synthesized Architecture

### Frontend Design (The "Knowledge Lab")
- **Central Graph**: Interactive neural-style network (from our v1 mockup).
- **Left Sidebar**: "Project Navigator" + "Clerk Org Switcher".
- **Right Sidebar**: "Source Manager" (NotebookLM-style) where you can add new sources (Upload, Link, Paste).
- **Top Bar**: "Blueprint Mode" (e.g., Architect + CTO Hybrid).

### Backend Design (The "Knowledge Mesh")
- **Hybrid Search**: 
    - **Vector Index** (Gemini/OpenAI) for finding the *right* passages.
    - **Neo4j Graph** for finding the *connected* context (e.g., "Find the transcript for this PDF and see which Architect notes mention it").
- **Modular Workers**:
    - `scrapyd` or Cloud Functions for URL fetching.
    - `whisper-worker` for audio-to-text.
    - `graph-transformer` for turning text into Neo4j nodes.

### In-Between (The "Security Gateway")
- **JWT Enrichment**: The Gateway validates the Clerk token and injects the `org_id` and `user_id`.
- **Relationship-Based Enforcement**: Every MCP tool call checked against the permission graph in Neo4j before execution.

---

## 4. Future: Cortex Blueprints
A **Blueprint** is essentially a "Filtered View" of the global Knowledge Mesh tailored for a specific role.
- **Blueprint 1 (Architect)**: Includes Confluence + Podcast Technical Episodes.
- **Blueprint 2 (PM)**: Includes Notion Roadmap + Podcast Business Episodes.
- **Hybrid Role**: A user merges these two into a single **"Architect-PM Cortex Model"** that draws from both graphs simultaneously.
