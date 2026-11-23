-- 015: steward review of transferred content (S2-50 §3b, 2026-11-23).
-- documents/security/offboarding-and-retention-design-2026-11-20.md §3b.
--
-- content_transfers gains the steward's decision: status in_review (new) → reviewed (nothing left to decide), and
-- a list of decisions (keep / delete / purge hidden chats; counts only, never content). Index for "Transferred to you".
-- Additive only: existing rows become in_review.

ALTER TABLE content_transfers ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'in_review';
DO $$ BEGIN
    ALTER TABLE content_transfers ADD CONSTRAINT content_transfers_status_check CHECK (status IN ('in_review', 'reviewed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE content_transfers ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE content_transfers ADD COLUMN IF NOT EXISTS decisions JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS content_transfers_to_sub_idx ON content_transfers (to_sub, created_at DESC);
