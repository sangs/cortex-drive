-- CortexDrive: share_grants table
-- Run against the 'cortexdrive_app' database on the cortex-openfga-db Cloud SQL instance.
--
-- Purpose: durable audit record for every sharing decision.
--   - Permify tuple store = live permission state (who can see what right now)
--   - share_grants = permanent intent record (why, who, scope, when)
--
-- depth_ui_selection: what the sharer chose in the UI. Informational only —
--   Permify enforces GLOBAL_MAX_DEPTH=5 at lookup time, not this value.
--
-- child_node_ids: BFS snapshot of the subtree at share time, excluding private nodes.
--   Used for the share preview UI, revoke conflict analysis, and audit.
--   NOT the enforcement mechanism — Permify parent chain traversal is enforcement.
--
-- already_accessible_ids: nodes in child_node_ids that the recipient could already see
--   at share time (deduplication result, stored for audit).

CREATE TABLE IF NOT EXISTS share_grants (
    grant_id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    root_node_id           TEXT        NOT NULL,
    subject                TEXT        NOT NULL,         -- "user:clerk_sub" or "group:gid#member"
    relation               TEXT        NOT NULL DEFAULT 'shared_viewer',
    depth_ui_selection     INTEGER     NOT NULL DEFAULT 5,
    composition_rels       TEXT[]      NOT NULL DEFAULT '{}',
    child_node_ids         TEXT[]      NOT NULL DEFAULT '{}',
    already_accessible_ids TEXT[]      NOT NULL DEFAULT '{}',
    private_node_ids       TEXT[]      NOT NULL DEFAULT '{}',  -- excluded from share (is_private=true)
    issued_by              TEXT        NOT NULL,         -- Clerk sub of the sharer
    issued_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at             TIMESTAMPTZ,
    revoked_at             TIMESTAMPTZ,
    revoked_by             TEXT,
    status                 TEXT        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'revoked', 'expired'))
);

CREATE INDEX IF NOT EXISTS share_grants_root_status_idx  ON share_grants (root_node_id, status);
CREATE INDEX IF NOT EXISTS share_grants_subject_status_idx ON share_grants (subject, status);
CREATE INDEX IF NOT EXISTS share_grants_issued_by_idx    ON share_grants (issued_by);
CREATE INDEX IF NOT EXISTS share_grants_issued_at_idx    ON share_grants (issued_at DESC);
