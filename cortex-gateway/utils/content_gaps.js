'use strict';
/**
 * Content-gaps log (§4.5, design 2026-11-09; table: scripts/migrations/011_content_gaps.sql). Best-effort: a failure is
 * logged and never affects the answer. Stores a normalised question pattern and the topics the asker named.
 */
const GAP_KINDS = new Set(['no_data', 'out_of_scope', 'clarify']);
const PATTERN_MAX = 200;
const REPORT_DAYS_DEFAULT = 30;
const REPORT_ROWS = 50;

function normaliseQuestion(q) {
    return String(q || '').toLowerCase()
        .replace(/https?:\/\/\S+/g, '<url>')
        .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
        .replace(/\d+/g, '#')
        .replace(/\s+/g, ' ').trim().slice(0, PATTERN_MAX);
}

/** The gap kind for a routing v2 result, or null. */
function gapKindFor(routing) {
    if (!routing) return null;
    if (routing.no_data) return 'no_data';
    if (routing.mode === 'out_of_scope') return 'out_of_scope';
    if (routing.mode === 'clarify') return 'clarify';
    return null;
}

function createContentGaps({ db, log = console }) {
    async function record({ orgId, userType, kind, question, topics = [] }) {
        if (!db || !orgId || !GAP_KINDS.has(kind)) return;
        try {
            await db.query(
                `INSERT INTO content_gaps (org_id, user_type, kind, question_pattern, topics) VALUES ($1, $2, $3, $4, $5)`,
                [orgId, userType || null, kind, normaliseQuestion(question), topics.slice(0, 5)]);
        } catch (e) {
            log.warn(`[CONTENT_GAPS] not recorded (${e.message})`);
        }
    }

    /** Org admins: their organization's top gaps. */
    async function orgReport(orgId, days = REPORT_DAYS_DEFAULT) {
        const { rows } = await db.query(
            `SELECT kind, question_pattern, topics, count(*)::int AS times, max(created_at) AS last_seen
               FROM content_gaps WHERE org_id = $1 AND created_at > now() - ($2 || ' days')::interval
              GROUP BY kind, question_pattern, topics ORDER BY times DESC, last_seen DESC LIMIT ${REPORT_ROWS}`,
            [orgId, String(days)]);
        return rows;
    }

    /** Platform owner: counts per organization and kind — no question text. */
    async function platformCounts(days = REPORT_DAYS_DEFAULT) {
        const { rows } = await db.query(
            `SELECT org_id, kind, count(*)::int AS times FROM content_gaps
              WHERE created_at > now() - ($1 || ' days')::interval GROUP BY org_id, kind ORDER BY times DESC`,
            [String(days)]);
        return rows;
    }

    return { record, orgReport, platformCounts };
}

module.exports = { createContentGaps, normaliseQuestion, gapKindFor, GAP_KINDS };
