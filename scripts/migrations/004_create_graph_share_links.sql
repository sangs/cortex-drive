-- Migration 004: graph_share_links table
-- Public token-based graph sharing (Loom-style).
-- No Permify involvement — the token IS the authorization.
-- graph_snapshot stores the full canvas state at share time (frozen node set + content).

CREATE TABLE IF NOT EXISTS graph_share_links (
    link_id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    share_token     TEXT        NOT NULL UNIQUE,
    node_ids        UUID[]      NOT NULL,
    graph_snapshot  JSONB       NOT NULL,          -- { nodes: [], links: [] } frozen at creation
    title           TEXT,
    owner_sub       TEXT        NOT NULL,
    org_id          TEXT        NOT NULL,
    expires_at      TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    view_count      INTEGER     NOT NULL DEFAULT 0,
    last_viewed_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gsl_token_idx ON graph_share_links (share_token)
    WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS gsl_owner_idx ON graph_share_links (owner_sub);
