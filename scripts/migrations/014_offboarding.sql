-- Migration 014: offboarding a person (S2-50, 2026-11-20).
-- Design: documents/security/offboarding-and-retention-design-2026-11-20.md (§3 D2/D8, §11).
--
-- people_directory   who a Clerk id is (display name, primary email), so content transferred after the person's
--                    account is gone can still say whose it was (D2). Filled by the Clerk webhook (user.created /
--                    user.updated) and by the offboarding sweep for every id it finds that still exists. The row is
--                    deleted when the person is offboarded; only the display name survives, on content_transfers.
-- content_transfers  one row per (person, receiving steward, organization): the separate "Transferred from <name>"
--                    group the steward sees (D2). The nodes keep their place in the graph; no node or edge is added.
-- offboarding_log    one row per offboarding run that changed something (D8): trigger, counts per store, failures.
--                    Never content or email.

CREATE TABLE IF NOT EXISTS people_directory (
    user_sub      TEXT        PRIMARY KEY,
    display_name  TEXT,
    email         TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS offboarding_log (
    offboarding_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_sub        TEXT        NOT NULL,
    trigger         TEXT        NOT NULL CHECK (trigger IN ('user_deleted', 'sweep', 'remove_person', 'membership_deleted')),
    actor           TEXT,
    status          TEXT        NOT NULL CHECK (status IN ('completed', 'failed')),
    counts          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    error           TEXT,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS offboarding_log_user_idx ON offboarding_log (user_sub, started_at DESC);

CREATE TABLE IF NOT EXISTS content_transfers (
    transfer_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    offboarding_id     UUID        REFERENCES offboarding_log(offboarding_id),
    from_sub           TEXT        NOT NULL,
    from_display_name  TEXT        NOT NULL,
    to_sub             TEXT        NOT NULL,
    org_id             TEXT        NOT NULL,
    node_ids           TEXT[]      NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS content_transfers_to_idx ON content_transfers (to_sub, created_at DESC);
