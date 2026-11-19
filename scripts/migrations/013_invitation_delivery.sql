-- Migration 013: invite email delivery status (S2-93, documents/architecture/share-results-and-invite-delivery-design-2026-11-19.md §3.3).
-- Every invite email goes through cortex-gateway/utils/notify_email.js, which reports whether Resend accepted it.
-- The result is stored on the invitation, so the sharer can see "Sent" / "Email failed" and resend.
-- Additive and backward compatible: nullable columns (NULL = not attempted since this migration); the view keeps its
-- existing columns in the same order and appends the new ones (CREATE OR REPLACE VIEW allows appending only).

ALTER TABLE invitations ADD COLUMN IF NOT EXISTS email_status TEXT;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS email_provider_id TEXT;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS email_last_attempt_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invitations_email_status_check') THEN
        ALTER TABLE invitations ADD CONSTRAINT invitations_email_status_check
            CHECK (email_status IS NULL OR email_status IN ('sent', 'failed'));
    END IF;
END $$;

CREATE OR REPLACE VIEW pending_invites AS
SELECT
    i.invitation_id,
    i.invitation_type,
    i.resource_id,
    i.invited_email,
    i.invited_by,
    i.invited_at,
    i.expires_at,
    i.status,
    g.name                             AS group_name,
    sg.grant_type,
    array_length(sg.child_node_ids, 1) AS node_count,
    i.email_status,
    i.email_last_attempt_at
FROM invitations i
LEFT JOIN groups g
    ON i.invitation_type = 'group'
    AND g.group_id::text = i.resource_id
LEFT JOIN share_grants sg
    ON i.invitation_type = 'share'
    AND sg.grant_id::text = i.resource_id
WHERE i.status = 'pending';
