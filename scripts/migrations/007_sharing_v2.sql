-- Migration 007: Sharing Model V2 — roles, role_assignments, invitations
-- 2026-07-08
--
-- Replaces the 1:1 grant-to-audience model with a normalized three-table model:
--   share_grants     = what was shared (content bundle, immutable identity)
--   role_assignments = who has access (audience, one row per principal)
--   invitations      = pending invite lifecycle (share and group, single table)
--
-- Supersedes: group_invitations table, share_grants.pending_email pattern
-- Enables:    grant reuse (one grant, N audience rows), grant-level revocation
--
-- DEPLOY IMMEDIATELY AFTER APPLYING: gateway must be redeployed before
-- any share/revoke operations are attempted, as subject column is dropped.

BEGIN;

-- ============================================================
-- PRE-STEP: Cancel all existing pending invitations
-- User will re-invite after migration completes.
-- Emails are logged via NOTICE for Clerk allowlist manual cleanup.
-- ============================================================

DO $$
DECLARE
    pending_emails TEXT[];
BEGIN
    SELECT array_agg(DISTINCT email) INTO pending_emails FROM (
        SELECT pending_email AS email
        FROM share_grants
        WHERE status = 'pending' AND pending_email IS NOT NULL
        UNION ALL
        SELECT pending_email AS email
        FROM group_invitations
        WHERE status = 'pending'
    ) t;
    IF pending_emails IS NOT NULL THEN
        RAISE NOTICE '[007] Pending invite emails being cancelled — remove from Clerk allowlist: %',
            array_to_string(pending_emails, ', ');
    END IF;
END $$;

-- Cancel pending share grants (become revoked; grant content bundle is discarded)
UPDATE share_grants
SET    status = 'revoked', revoked_at = now(), revoked_by = 'migration:007'
WHERE  status = 'pending';

-- Cancel pending group invitations before we migrate them
UPDATE group_invitations
SET    status = 'cancelled'
WHERE  status = 'pending';


-- ============================================================
-- NEW TABLE: roles
-- Named permission templates. Currently a placeholder for the
-- future role→permission mapping. Already wired into role_assignments
-- so the schema supports it when roles are implemented.
-- ============================================================

CREATE TABLE IF NOT EXISTS roles (
    role_id     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      TEXT        NOT NULL,
    name        TEXT        NOT NULL,
    description TEXT,
    created_by  TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, name)
);


-- ============================================================
-- NEW TABLE: role_assignments
-- Source of truth for all active access grants.
-- resource_type IN ('org', 'domain', 'grant', 'node')
-- assignee_type IN ('user', 'group')
-- ============================================================

CREATE TABLE IF NOT EXISTS role_assignments (
    assignment_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_type  TEXT        NOT NULL
                               CHECK (resource_type IN ('org', 'domain', 'grant', 'node')),
    resource_id    TEXT        NOT NULL,
    assignee_type  TEXT        NOT NULL
                               CHECK (assignee_type IN ('user', 'group')),
    assignee_id    TEXT        NOT NULL,
    assignee_email TEXT,                       -- denormalized from Clerk for display (user only)
    role_id        UUID        REFERENCES roles(role_id),  -- NULL = direct grant, no role
    status         TEXT        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'revoked', 'expired')),
    assigned_by    TEXT        NOT NULL,
    assigned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at     TIMESTAMPTZ,
    revoked_at     TIMESTAMPTZ,
    revoked_by     TEXT
);

CREATE INDEX IF NOT EXISTS idx_ra_resource_active
    ON role_assignments (resource_type, resource_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_ra_assignee_active
    ON role_assignments (assignee_type, assignee_id)
    WHERE status = 'active';


-- ============================================================
-- NEW TABLE: invitations
-- Pending invite lifecycle for both share grants and group membership.
-- Replaces group_invitations + share_grants.pending_email pattern.
-- One active pending invite per (type, resource, email) enforced by partial unique index.
-- ============================================================

CREATE TABLE IF NOT EXISTS invitations (
    invitation_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           TEXT,                      -- nullable: not available for legacy share grants
    invitation_type  TEXT        NOT NULL
                                 CHECK (invitation_type IN ('share', 'group')),
    resource_id      TEXT        NOT NULL,       -- grant_id for 'share', group_id for 'group'
    invited_email    TEXT        NOT NULL,
    invited_by       TEXT        NOT NULL,
    invited_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at       TIMESTAMPTZ,
    status           TEXT        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'accepted', 'cancelled', 'expired')),
    accepted_at      TIMESTAMPTZ
);

-- Only one pending invite per (type, resource, email) at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_active_unique
    ON invitations (invitation_type, resource_id, invited_email)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_inv_email_pending
    ON invitations (invited_email)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_inv_resource
    ON invitations (invitation_type, resource_id);


-- ============================================================
-- MODIFY: group_members — add email for display
-- ============================================================

ALTER TABLE group_members ADD COLUMN IF NOT EXISTS email TEXT;


-- ============================================================
-- DATA MIGRATION: active user grants → role_assignments
-- subject format: "user:clerk_sub_xxx"
-- ============================================================

INSERT INTO role_assignments
    (resource_type, resource_id, assignee_type, assignee_id, assignee_email,
     assigned_by, assigned_at, expires_at)
SELECT
    'grant'                            AS resource_type,
    grant_id::text                     AS resource_id,
    'user'                             AS assignee_type,
    REPLACE(subject, 'user:', '')      AS assignee_id,
    user_email                         AS assignee_email,
    issued_by,
    issued_at,
    expires_at
FROM share_grants
WHERE status = 'active'
  AND subject_type = 'user'
  AND subject IS NOT NULL
  AND subject != ''
  AND subject LIKE 'user:%';


-- ============================================================
-- DATA MIGRATION: active group grants → role_assignments
-- ============================================================

INSERT INTO role_assignments
    (resource_type, resource_id, assignee_type, assignee_id,
     assigned_by, assigned_at, expires_at)
SELECT
    'grant'              AS resource_type,
    sg.grant_id::text    AS resource_id,
    'group'              AS assignee_type,
    sg.group_id::text    AS assignee_id,
    sg.issued_by,
    sg.issued_at,
    sg.expires_at
FROM share_grants sg
WHERE sg.status = 'active'
  AND sg.subject_type = 'group'
  AND sg.group_id IS NOT NULL;


-- ============================================================
-- DATA MIGRATION: group_invitations → invitations
-- All pending invites were already cancelled above;
-- migrate accepted/cancelled history for audit continuity.
-- ============================================================

INSERT INTO invitations
    (org_id, invitation_type, resource_id, invited_email, invited_by,
     invited_at, status, accepted_at)
SELECT
    g.org_id          AS org_id,
    'group'           AS invitation_type,
    gi.group_id::text AS resource_id,
    gi.pending_email  AS invited_email,
    gi.invited_by,
    gi.invited_at,
    gi.status,
    gi.accepted_at
FROM group_invitations gi
JOIN groups g ON g.group_id = gi.group_id;


-- ============================================================
-- VIEWS
-- ============================================================

CREATE OR REPLACE VIEW audience_members AS
SELECT
    ra.assignment_id,
    ra.resource_id      AS grant_id,
    ra.assignee_type,
    ra.assignee_id,
    ra.assignee_email,
    ra.status,
    ra.assigned_by,
    ra.assigned_at,
    ra.expires_at,
    ra.revoked_at,
    ra.revoked_by
FROM role_assignments ra
WHERE ra.resource_type = 'grant';

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
    array_length(sg.child_node_ids, 1) AS node_count
FROM invitations i
LEFT JOIN groups g
    ON i.invitation_type = 'group'
    AND g.group_id::text = i.resource_id
LEFT JOIN share_grants sg
    ON i.invitation_type = 'share'
    AND sg.grant_id::text = i.resource_id
WHERE i.status = 'pending';


-- ============================================================
-- CLEAN UP share_grants: drop audience-tracking columns
-- These columns' data has been migrated to role_assignments
-- and invitations above. Dropping is irreversible.
-- ============================================================

-- Remove 'pending' from status enum — grants are now always born active
ALTER TABLE share_grants DROP CONSTRAINT IF EXISTS share_grants_status_check;
ALTER TABLE share_grants ADD CONSTRAINT share_grants_status_check
    CHECK (status IN ('active', 'revoked', 'expired'));

-- Drop audience / pending columns (data migrated above)
ALTER TABLE share_grants
    DROP COLUMN IF EXISTS subject,
    DROP COLUMN IF EXISTS subject_type,
    DROP COLUMN IF EXISTS group_id,
    DROP COLUMN IF EXISTS user_email,
    DROP COLUMN IF EXISTS pending_email,
    DROP COLUMN IF EXISTS relation;


-- ============================================================
-- DROP: group_invitations (fully replaced by invitations table)
-- ============================================================

DROP TABLE IF EXISTS group_invitations;


-- ============================================================
-- VERIFY (informational counts printed to psql output)
-- ============================================================

DO $$
DECLARE
    ra_count  INT;
    inv_count INT;
    sg_active INT;
BEGIN
    SELECT COUNT(*) INTO ra_count  FROM role_assignments;
    SELECT COUNT(*) INTO inv_count FROM invitations;
    SELECT COUNT(*) INTO sg_active FROM share_grants WHERE status = 'active';
    RAISE NOTICE '[007] Migration complete — role_assignments: %, invitations: %, active share_grants: %',
        ra_count, inv_count, sg_active;
END $$;

COMMIT;
