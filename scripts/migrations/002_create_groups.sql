-- Groups: named audience sets for CortexDrive sharing.
-- Members can be cross-org (user_org_id tracks their org for compliance).
-- SCIM sync deferred; group ownership managed inside CortexDrive for now.

CREATE TABLE IF NOT EXISTS groups (
    group_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      TEXT NOT NULL,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    description TEXT,
    created_by  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, slug)
);

CREATE TABLE IF NOT EXISTS group_members (
    group_id    UUID NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
    user_sub    TEXT NOT NULL,
    user_org_id TEXT,
    added_by    TEXT NOT NULL,
    added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_sub)
);

CREATE INDEX IF NOT EXISTS group_members_user_sub_idx ON group_members (user_sub);
CREATE INDEX IF NOT EXISTS groups_org_id_idx          ON groups (org_id);
