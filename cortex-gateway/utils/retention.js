'use strict';
/**
 * Retention purge (S2-50 build 2c; design documents/security/offboarding-and-retention-design-2026-11-20.md D1, D8).
 * Deletes, in this order:
 *   1. hidden (soft-deleted) chats whose deleted_at is older than history_retention_days (messages cascade) — a chat a
 *      user deleted, or an organization chat hidden when its author left;
 *   2. transfer groups the steward has finished reviewing, older than audit_retention_days (the former person's
 *      name goes with them);
 *   3. offboarding audit rows older than audit_retention_days that no remaining transfer group points to.
 * plan() counts only; purge() deletes and returns the same counts. Never touches active chats or in-review transfers.
 */
const CONFIG = require('../config/offboarding.json');

const R = CONFIG.retention || {};
const HISTORY_DAYS = R.history_retention_days || 30;
const AUDIT_DAYS = R.audit_retention_days || 365;

const WHERE = {
    chats: `status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at < now() - make_interval(days => $1)`,
    transfers: `status = 'reviewed' AND reviewed_at IS NOT NULL AND reviewed_at < now() - make_interval(days => $1)`,
    audit: `finished_at < now() - make_interval(days => $1)
            AND NOT EXISTS (SELECT 1 FROM content_transfers ct WHERE ct.offboarding_id = offboarding_log.offboarding_id)`,
};

function createRetention({ db, historyDays = HISTORY_DAYS, auditDays = AUDIT_DAYS }) {
    if (!(historyDays > 0) || !(auditDays > 0)) throw new Error('retention windows must be positive');
    const count = async (table, where, days) =>
        (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, [days])).rows[0].n;

    async function plan() {
        return {
            hidden_chats: await count('conversations', WHERE.chats, historyDays),
            reviewed_transfers: await count('content_transfers', WHERE.transfers, auditDays),
            audit_rows: await count('offboarding_log', WHERE.audit, auditDays),
            windows: { history_retention_days: historyDays, audit_retention_days: auditDays },
        };
    }

    async function purge() {
        const chats = await db.query(`DELETE FROM conversations WHERE ${WHERE.chats}`, [historyDays]);
        const transfers = await db.query(`DELETE FROM content_transfers WHERE ${WHERE.transfers}`, [auditDays]);
        const audit = await db.query(`DELETE FROM offboarding_log WHERE ${WHERE.audit}`, [auditDays]);
        return { hidden_chats: chats.rowCount, reviewed_transfers: transfers.rowCount, audit_rows: audit.rowCount,
                 windows: { history_retention_days: historyDays, audit_retention_days: auditDays } };
    }

    return { plan, purge };
}

module.exports = { createRetention, HISTORY_DAYS, AUDIT_DAYS };
