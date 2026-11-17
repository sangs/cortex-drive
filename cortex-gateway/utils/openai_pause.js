'use strict';
/**
 * The owner's manual pause of usage-based (OpenAI) spend (FinOps design 2026-11-16 §7, tracker S2-83 release 5).
 *
 * - Source of truth: Postgres `app_settings` key `pause_openai` (migration 012). Every change also writes an
 *   `app_settings_audit` row in the SAME statement, so a change without its audit row cannot happen.
 * - Mirror: Redis key `finops:pause_openai` ({"paused": bool}), written on every change and re-synced from Postgres at
 *   start-up and every `resync_seconds` (a Redis restart cannot silently resume spend). MCP, Bento and the worker read
 *   the same key (src/mcp_server/usage_log.py `ensure_openai_allowed`).
 * - Readers cache the flag for `cache_seconds`, so a request costs no Redis read most of the time.
 * - If Redis cannot be read, the last known state is used, else "not paused" (fail open) with a warning: the pause
 *   is a cost control, not a security boundary.
 *
 * Who may change it is decided by the route (owner only, 404 otherwise); this module records whoever the route says.
 */
const CONFIG = require('../config/finops.json').pause;

const UPSERT_WITH_AUDIT = `
WITH old AS (SELECT value FROM app_settings WHERE key = $1),
up AS (
  INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  RETURNING value, updated_by, updated_at
)
INSERT INTO app_settings_audit (key, old_value, new_value, changed_by, reason)
SELECT $1, (SELECT value FROM old), up.value, $3, $4 FROM up
RETURNING changed_at`;
const READ_SETTING = 'SELECT value, updated_by, updated_at FROM app_settings WHERE key = $1';

const NOT_PAUSED = Object.freeze({ paused: false });

function createOpenAIPause({ db, redis, cfg = CONFIG, now = () => Date.now(), log = console }) {
    let cached = { at: -Infinity, state: null };

    async function readRedis() {
        const raw = await redis.get(cfg.redis_key);
        return raw ? { paused: JSON.parse(raw).paused === true } : NOT_PAUSED;
    }

    /** { paused } for request paths; cached for cfg.cache_seconds. */
    async function current() {
        if (cached.state && now() - cached.at < cfg.cache_seconds * 1000) return cached.state;
        try {
            cached = { at: now(), state: await readRedis() };
        } catch (err) {
            log.warn(`[FINOPS] pause flag unreadable (${err.message}); continuing ${cached.state && cached.state.paused ? 'paused' : 'not paused'}`);
            cached = { at: now(), state: cached.state || NOT_PAUSED };
        }
        return cached.state;
    }

    async function writeMirror(paused) {
        await redis.set(cfg.redis_key, JSON.stringify({ paused }));
        cached = { at: now(), state: { paused } };
    }

    /** The owner's view: the Postgres row (who, when, why). */
    async function status() {
        const { rows } = await db.query(READ_SETTING, [cfg.setting_key]);
        if (!rows.length) return { paused: false, reason: null, updated_by: null, updated_at: null };
        const v = rows[0].value || {};
        return { paused: v.paused === true, reason: v.reason || null, updated_by: rows[0].updated_by, updated_at: rows[0].updated_at };
    }

    /** Change the setting (+ audit row, one statement), then the Redis mirror. */
    async function set({ paused, reason, by }) {
        if (typeof paused !== 'boolean') throw new TypeError('paused must be true or false');
        const why = String(reason || '').trim().slice(0, cfg.reason_max_chars) || null;
        await db.query(UPSERT_WITH_AUDIT, [cfg.setting_key, JSON.stringify({ paused, reason: why }), String(by), why]);
        await writeMirror(paused);
        return status();
    }

    /** Postgres → Redis (start-up and periodically). Never throws. */
    async function resync() {
        try {
            const s = await status();
            await writeMirror(s.paused);
            return s.paused;
        } catch (err) {
            log.warn(`[FINOPS] pause resync failed (${err.message})`);
            return null;
        }
    }

    /** Express middleware: 503 while paused (every user type: spend is paused for everyone). */
    function guard(req, res, next) {
        current().then(s => {
            if (!s.paused) return next();
            res.set('Cache-Control', 'no-store');
            return res.status(503).json({ error: cfg.paused_message, paused: true });
        }, next);
    }

    return { current, status, set, resync, guard };
}

module.exports = { createOpenAIPause, UPSERT_WITH_AUDIT, CONFIG };
