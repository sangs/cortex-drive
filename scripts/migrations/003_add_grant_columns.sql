-- Extend share_grants to support graph-island grants and group subjects.
-- Must run AFTER 002_create_groups.sql (group_id FK references groups table).

ALTER TABLE share_grants
    ADD COLUMN IF NOT EXISTS grant_type   TEXT NOT NULL DEFAULT 'node'
                                          CHECK (grant_type IN ('node', 'graph_island')),
    ADD COLUMN IF NOT EXISTS subject_type TEXT NOT NULL DEFAULT 'user'
                                          CHECK (subject_type IN ('user', 'group')),
    ADD COLUMN IF NOT EXISTS group_id     UUID REFERENCES groups(group_id);
