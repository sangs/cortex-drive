-- Migration 011: content_gaps (cross-domain discovery design 2026-11-09 §4.5, 2026-11-12).
-- What people ask that Cortex-Drive cannot answer from their organization's knowledge: "no data" for a recognised
-- topic, out-of-scope requests, and clarifying questions. Feeds an admin "content gaps" report.
-- Stores a normalised question pattern (lowercased, numbers masked, URLs/emails removed, ≤ 200 chars) and the topics
-- the asker named — never names of content the asker cannot open. Org admins see their own organization; the platform
-- owner sees counts per organization, not question text. Retention: rows older than 180 days may be deleted.

CREATE TABLE IF NOT EXISTS content_gaps (
    gap_id            BIGSERIAL    PRIMARY KEY,
    org_id            TEXT         NOT NULL,
    user_type         TEXT,
    kind              TEXT         NOT NULL CHECK (kind IN ('no_data', 'out_of_scope', 'clarify')),
    question_pattern  TEXT         NOT NULL,
    topics            TEXT[]       NOT NULL DEFAULT '{}',
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS content_gaps_org_time ON content_gaps (org_id, created_at DESC);
