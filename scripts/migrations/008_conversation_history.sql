-- Migration 008: Conversation History — persist, list, view, delete
-- 2026-07-28
--
-- New tables only, no changes to existing schema:
--   conversations         = one row per chat session (title, last-known domain,
--                            latest graph snapshot, lifecycle status)
--   conversation_messages = one row per user/assistant turn within a conversation
--
-- Privacy: conversations are private to the creating user (user_sub), gated by a
-- plain WHERE predicate in application queries — not routed through Permify, since
-- this is personal session data with exactly one legitimate viewer, not a shareable
-- knowledge-graph node. See documents/architecture/security-and-auth-architecture-diagram-2026-07-27.md.
--
-- Delete is soft delete (status='deleted' + deleted_at), matching every other
-- lifecycle table in this schema (share_grants, role_assignments, invitations).

BEGIN;

-- ============================================================
-- NEW TABLE: conversations
-- One row per chat session. latest_graph_snapshot mirrors the
-- graph_share_links.graph_snapshot JSONB pattern (migration 004) —
-- final-state only, not a per-turn history (that's the separate,
-- out-of-scope "replay" feature noted in daily_log-2026-04-28.md).
-- ============================================================

CREATE TABLE IF NOT EXISTS conversations (
    conversation_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                  TEXT        NOT NULL,
    user_sub                TEXT        NOT NULL,
    title                   TEXT,
    domain_signal           TEXT,
    latest_graph_snapshot   JSONB,
    status                  TEXT        NOT NULL DEFAULT 'active'
                                        CHECK (status IN ('active', 'deleted')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS conversations_user_status_idx
    ON conversations (user_sub, status, updated_at DESC);


-- ============================================================
-- NEW TABLE: conversation_messages
-- content for assistant rows must be the post-auditResponseUrls()
-- text — never the pre-audit text — so a reopened historical
-- conversation can never resurface a link the grounding audit
-- stripped at the time it was generated.
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_messages (
    message_id       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id  UUID        NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    role             TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
    content          TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_messages_conv_idx
    ON conversation_messages (conversation_id, created_at);


-- ============================================================
-- VERIFY (informational counts printed to psql output)
-- ============================================================

DO $$
DECLARE
    conv_count INT;
    msg_count  INT;
BEGIN
    SELECT COUNT(*) INTO conv_count FROM conversations;
    SELECT COUNT(*) INTO msg_count  FROM conversation_messages;
    RAISE NOTICE '[008] Migration complete — conversations: %, conversation_messages: %',
        conv_count, msg_count;
END $$;

COMMIT;
