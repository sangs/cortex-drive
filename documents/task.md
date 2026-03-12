# CortexDrive Master Roadmap

This document serves as the single source of truth for project progress and task breakdown.

## Phase 1: CortexModel UI (Completed)
- [x] Create Next.js project and setup core 3-column layout
- [x] Integrate Clerk Authentication
- [x] Implement Knowledge Graph Visualization (Neon style)
- [x] Implement AI Chat Interface with real-time SSE streaming
- [x] Implement A2UI Message Processing (linking Chat to Graph)
- [x] Implement User Profile & Metadata Sidebar

## Phase 2: Ingestion & Schema Integrity (Completed)
- [x] Implement Schema Guard (Pydantic models)
- [x] Verify GDS Tool Impact (Confirmed Safe)
- [x] Tighten Ingestion Schema Enforcement
- [x] Create Core Ingestion Engine (Base Pipeline)
- [x] Implement Local File Ingestion Adapter
- [x] Implement Audit & Cleanup Script (`audit_model.py`)
- [x] Integrate Ingestion Pipeline with Neo4j Upsert logic
- [x] Refine Schema Guardrails (Podcast, Person, ReferenceLink)

## Phase 3: Infrastructure & Gateway (In Progress)
- [ ] Prepare Dockerfile for cortex-model server
- [ ] Deploy to Google Cloud Run
- [ ] Implement Secure Express Gateway
- [ ] Add Progress Tracking for Ingestion Pipeline

## Phase 4: Sharing & Collaboration
- [ ] Implement Sharing Modal (Google Drive style)
- [ ] Develop Permission Logic in Neo4j (ACLs)
- [ ] Create "Shared with Me" view
- [ ] Implement Blueprint Sharing

## Phase 5: Advanced Ingestion
- [ ] Implement File Upload (PDF, TXT, etc.)
- [ ] Implement URL-based Retrieval (Podcasts, Webpages)
- [ ] Expand supported sources (Obsidian, Notion, etc.)
- [ ] Transition to `File` node architecture
