-- Migration 009: share_links (unified shares phase 1, 2026-10-29).
-- Design: documents/security/unified-shares-design-2026-10-29.md §3, §4, §9.
-- A link is a Permify audience (subject share_link:<link_id>, one shared_viewer tuple per root node).
-- No graph data is stored: the link page reads the layout nodes live, through the link's permissions.
-- Tokens are not stored either: a token is "<link_id>.<HMAC(GATEWAY_SHARE_SECRET, link_id:nonce)>",
-- so a database leak exposes no working link and the owner can still copy the URL later.
-- Replaces graph_share_links (004), whose rows are migrated by
-- cortex-gateway/scripts/migrate_graph_share_links.js and then removed.

CREATE TABLE IF NOT EXISTS share_links (
    link_id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    token_nonce        TEXT        NOT NULL,                 -- random; part of the signed token
    link_type          TEXT        NOT NULL DEFAULT 'graph', -- 'graph' (phase 1); 'node' later
    root_node_ids      TEXT[]      NOT NULL,                 -- one Permify shared_viewer tuple each
    layout_node_ids    TEXT[]      NOT NULL,                 -- the nodes on screen when shared (layout only)
    title              TEXT,
    owner_sub          TEXT        NOT NULL,
    org_id             TEXT        NOT NULL,
    expires_at         TIMESTAMPTZ,
    revoked_at         TIMESTAMPTZ,
    view_count         INTEGER     NOT NULL DEFAULT 0,
    last_viewed_at     TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    legacy_token_hash  TEXT UNIQUE,                          -- sha256 of a migrated graph_share_links token
    legacy_link_id     UUID                                  -- graph_share_links.link_id it came from
);

CREATE INDEX IF NOT EXISTS sl_owner_idx ON share_links (owner_sub);
CREATE INDEX IF NOT EXISTS sl_legacy_idx ON share_links (legacy_token_hash) WHERE legacy_token_hash IS NOT NULL;
