-- Migration 005: pending grant support
-- Enables sharing with users who don't have a Cortex-Drive / Clerk account yet.
-- On sign-up (webhook) or first login (pull model), pending grants are activated:
--   pending_email is cleared, subject is set, Permify tuples are written.

ALTER TABLE share_grants
    ADD COLUMN IF NOT EXISTS pending_email TEXT,    -- set when recipient has no Clerk account at share time
    ADD COLUMN IF NOT EXISTS user_email    TEXT;    -- stored email once grant is activated (for display)

-- Extend status to allow 'pending'
ALTER TABLE share_grants DROP CONSTRAINT IF EXISTS share_grants_status_check;
ALTER TABLE share_grants ADD CONSTRAINT share_grants_status_check
    CHECK (status IN ('pending', 'active', 'revoked', 'expired'));

-- Efficient lookup for pull model resolution and webhook activation
CREATE INDEX IF NOT EXISTS share_grants_pending_email_idx
    ON share_grants (pending_email) WHERE status = 'pending';
