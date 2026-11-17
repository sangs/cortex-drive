-- Migration 012: app_settings + append-only audit (FinOps design 2026-11-16 §7, tracker S2-83 release 5).
-- First setting: `pause_openai` = {"paused": bool, "reason": text}. Written only by the gateway's owner-only
-- POST /api/finops/pause (cortex-gateway/utils/openai_pause.js), which changes the setting and writes its audit row in
-- one statement. The gateway mirrors the value to Redis key `finops:pause_openai` so MCP, Bento and the worker can read it.
-- The audit table refuses UPDATE and DELETE (trigger), so the history of who paused and resumed spend cannot be edited.

CREATE TABLE IF NOT EXISTS app_settings (
    key         TEXT         PRIMARY KEY,
    value       JSONB        NOT NULL,
    updated_by  TEXT         NOT NULL,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_settings_audit (
    audit_id    BIGSERIAL    PRIMARY KEY,
    key         TEXT         NOT NULL,
    old_value   JSONB,
    new_value   JSONB        NOT NULL,
    changed_by  TEXT         NOT NULL,
    reason      TEXT,
    changed_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_settings_audit_key_time ON app_settings_audit (key, changed_at DESC);

CREATE OR REPLACE FUNCTION app_settings_audit_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'app_settings_audit is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_settings_audit_no_change ON app_settings_audit;
CREATE TRIGGER app_settings_audit_no_change
    BEFORE UPDATE OR DELETE ON app_settings_audit
    FOR EACH ROW EXECUTE FUNCTION app_settings_audit_append_only();
