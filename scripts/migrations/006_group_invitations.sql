-- Migration 006: Group invitations for pending members
-- Stores invitations for people who don't have a CortexDrive account yet.
-- Activated by the existing pull model / Clerk webhook in activatePendingGrants().
-- 2026-07-07

CREATE TABLE IF NOT EXISTS group_invitations (
    invitation_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id       UUID NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
    pending_email  TEXT NOT NULL,
    invited_by     TEXT NOT NULL,       -- Clerk user sub of the inviter
    invited_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'accepted', 'cancelled')),
    accepted_at    TIMESTAMPTZ,
    UNIQUE (group_id, pending_email)
);

CREATE INDEX IF NOT EXISTS group_invitations_email_idx
    ON group_invitations (pending_email) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS group_invitations_group_idx
    ON group_invitations (group_id) WHERE status = 'pending';
