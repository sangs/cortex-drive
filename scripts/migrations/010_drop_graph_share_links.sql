-- Migration 010: remove graph_share_links (unified shares phase 1, 2026-10-29; user approved 2026-10-29).
-- The table held frozen copies of shared graphs, outside the authorization system. Live links replaced
-- it (009 share_links). Its one active, recent link was migrated by
-- cortex-gateway/scripts/migrate_graph_share_links.js and verified (old URL works via
-- share_links.legacy_token_hash; copy 6 nodes = live 6). The other row was already dead.
-- No running code reads this table (checked 2026-10-29). Irreversible.
BEGIN;
-- Refuse if an active, recent link was not migrated (would break a working URL).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM graph_share_links g
        WHERE g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
          AND g.created_at > now() - interval '90 days'
          AND NOT EXISTS (SELECT 1 FROM share_links s WHERE s.legacy_link_id = g.link_id)
    ) THEN
        RAISE EXCEPTION 'graph_share_links has an active link that was not migrated; run migrate_graph_share_links.js first';
    END IF;
END $$;
DROP TABLE graph_share_links;
COMMIT;
