'use strict';
/**
 * Owner-only cost summary for /finops (FinOps design 2026-11-16 §5 and §13; tracker S2-83 release 4).
 *
 * One BigQuery query reads cortex-drive's four authorized views in finops-admin, plus today's OpenAI spend from
 * the `openai.usage` events in `cortex_usage` (minutes behind; the views get it only from the twice-daily push).
 * All month, forecast and freshness logic lives in finops-admin's views; nothing is recomputed here. The response
 * follows the central design's §4.2 contract, the same shape as gmail-digest's `finops_summary.py`.
 *
 * Runs as the gateway's own account (cortex-gateway@): READER on the view dataset and jobUser in finops-admin,
 * READER on cortex_usage here. Cached in Redis for config.cache_seconds (one entry, fleet-wide); ?refresh=1
 * bypasses it. The route decides who may call this (owner only, 404 otherwise); this module never sees a user.
 */
const CONFIG = require('../config/finops.json');

const BIGQUERY_QUERY_URL = project => `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries`;
const BIGQUERY_SCOPE = 'https://www.googleapis.com/auth/bigquery';
const IDENTIFIER = /^[A-Za-z0-9_.-]+$/;   // project / dataset / table names are spliced into SQL: allow only these
const ROUND_DECIMALS = 4;

class FinopsUnavailable extends Error {}

function identifier(value, what) {
    if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new FinopsUnavailable(`${what} is not set or not a valid name`);
    return value;
}

function projectsFrom(env = process.env) {
    return { finops: identifier(env.FINOPS_PROJECT, 'FINOPS_PROJECT'), usage: identifier(env.USAGE_PROJECT, 'USAGE_PROJECT') };
}

/** BigQuery jobs.query body (pure; unit-tested). */
function buildQuery({ finops, usage }, cfg = CONFIG) {
    const d = `${identifier(finops, 'finops project')}.${identifier(cfg.view_dataset, 'view dataset')}`;
    const v = Object.fromEntries(Object.entries(cfg.views).map(([k, name]) => [k, `\`${d}.${identifier(name, 'view')}\``]));
    const u = `\`${identifier(usage, 'usage project')}.${identifier(cfg.usage_dataset, 'usage dataset')}.${identifier(cfg.usage_table, 'usage table')}\``;
    const query = `
SELECT TO_JSON_STRING(STRUCT(
  (SELECT AS STRUCT * FROM ${v.month_summary}) AS totals,
  ARRAY(SELECT AS STRUCT provider, sources, month_to_date FROM ${v.by_provider} ORDER BY month_to_date DESC) AS by_provider,
  ARRAY(SELECT AS STRUCT service, ROUND(SUM(effective_cost), ${ROUND_DECIMALS}) AS mtd FROM ${v.cost_daily}
        WHERE provider = @gcp_provider AND usage_date >= DATE_TRUNC(CURRENT_DATE(@tz), MONTH)
        GROUP BY service HAVING ROUND(SUM(effective_cost), ${ROUND_DECIMALS}) != 0 ORDER BY mtd DESC) AS by_gcp_service,
  ARRAY(SELECT AS STRUCT usage_date AS date, provider, ROUND(SUM(effective_cost), ${ROUND_DECIMALS}) AS cost FROM ${v.cost_daily}
        WHERE usage_date >= DATE_SUB(CURRENT_DATE(@tz), INTERVAL @daily_days DAY)
        GROUP BY 1, 2 ORDER BY 1, 2) AS daily,
  ARRAY(SELECT AS STRUCT source, provider, as_of, is_stale FROM ${v.source_status} ORDER BY source) AS sources,
  (SELECT MIN(usage_date) FROM ${v.cost_daily} WHERE source = @app_source) AS app_recorded_since,
  (SELECT SUM(CAST(jsonPayload.cost_usd AS FLOAT64)) FROM (
     SELECT * FROM ${u} WHERE timestamp >= TIMESTAMP(CURRENT_DATE()) AND jsonPayload.event = @event
     QUALIFY ROW_NUMBER() OVER (PARTITION BY insertId ORDER BY receiveTimestamp) = 1)) AS live_today
)) AS payload`;
    const param = (name, type, value) => ({ name, parameterType: { type }, parameterValue: { value: String(value) } });
    return {
        query,
        useLegacySql: false,
        maximumBytesBilled: String(cfg.max_bytes_billed),
        timeoutMs: cfg.query_timeout_ms,
        queryParameters: [
            param('gcp_provider', 'STRING', cfg.gcp_provider),
            param('tz', 'STRING', cfg.billing_time_zone),
            param('daily_days', 'INT64', cfg.daily_days - 1),
            param('app_source', 'STRING', cfg.app_recorded_source),
            param('event', 'STRING', cfg.usage_event),
        ],
    };
}

const num = v => Number(Number(v || 0).toFixed(ROUND_DECIMALS));
const splitSources = s => (Array.isArray(s) ? s : String(s || '').split(',')).map(x => x.trim()).filter(Boolean);

/** Banners: threshold reached / forecast over it (only when a limit exists), and stale sources. */
function alertsFor(totals, sources, warnPcts = CONFIG.warn_pcts) {
    const out = [];
    if (totals.threshold) {
        const pct = (100 * totals.month_to_date) / totals.threshold;
        const reached = warnPcts.filter(p => pct >= p);
        if (reached.length) out.push({ level: reached[reached.length - 1] >= 100 ? 'critical' : 'warning',
            message: `Month to date is ${pct.toFixed(0)}% of the $${totals.threshold.toFixed(2)} monthly limit` });
        if (totals.forecast_month_end > totals.threshold) out.push({ level: 'warning',
            message: `Month-end forecast $${totals.forecast_month_end.toFixed(2)} is over the $${totals.threshold.toFixed(2)} limit` });
    }
    for (const s of sources) if (s.stale) out.push({ level: 'warning', message: `${s.provider} data is out of date (as of ${s.as_of || 'never'})` });
    return out;
}

/** View payload → the §4.2 contract (pure; unit-tested). */
function buildSummary(payload, generatedAt, cfg = CONFIG) {
    const t = payload.totals || {};
    const threshold = t.threshold_usd != null ? Number(t.threshold_usd) : null;
    const totals = {
        today: num(t.today_cost), month_to_date: num(t.month_to_date), last_month: num(t.last_month),
        forecast_month_end: num(t.forecast_month_end), threshold,
        pct_of_threshold: threshold ? Number(((100 * num(t.month_to_date)) / threshold).toFixed(1)) : null,
    };
    const sources = (payload.sources || []).map(s => ({ source: s.source, provider: s.provider, as_of: s.as_of || null, stale: s.is_stale === true }));
    return {
        project: cfg.project_key,
        currency: cfg.currency,
        generated_at: generatedAt.toISOString(),
        as_of: Object.fromEntries(sources.map(s => [s.source, s.as_of])),
        totals,
        live: { app_spend_today_utc: payload.live_today == null ? 0 : num(payload.live_today) },
        by_provider: (payload.by_provider || []).map(p => ({ provider: p.provider, mtd: num(p.month_to_date), sources: splitSources(p.sources) })),
        by_gcp_service: (payload.by_gcp_service || []).map(s => ({ service: s.service, mtd: num(s.mtd) })),
        daily: (payload.daily || []).map(x => ({ date: x.date, provider: x.provider, cost: num(x.cost) })),
        sources,
        alerts: alertsFor(totals, sources, cfg.warn_pcts),
        untracked_before: payload.app_recorded_since || null,
    };
}

/** Default BigQuery caller: the gateway's own account via google-auth-library (metadata server on Cloud Run). */
async function bigQuery(project, body) {
    const { GoogleAuth } = require('google-auth-library');
    const client = await new GoogleAuth({ scopes: [BIGQUERY_SCOPE] }).getClient();
    const res = await client.request({ url: BIGQUERY_QUERY_URL(project), method: 'POST', data: body });
    return res.data;
}

/**
 * The summary, from Redis when fresh. deps: { redis, query, env, now } (all optional; injected in tests).
 * Throws FinopsUnavailable with a user-safe message; the cause is logged by the caller.
 */
async function getSummary({ refresh = false, redis = null, query = bigQuery, env = process.env, now = () => new Date() } = {}, cfg = CONFIG) {
    if (redis && !refresh) {
        try {
            const hit = await redis.get(cfg.cache_key);
            if (hit) return { ...JSON.parse(hit), cached: true };
        } catch (_) { /* cache is optional */ }
    }
    let projects, result;
    try {
        projects = projectsFrom(env);
        result = await query(projects.finops, buildQuery(projects, cfg));
    } catch (err) {
        const e = new FinopsUnavailable('Cost data is unavailable right now. Try again shortly.');
        e.cause = err;
        throw e;
    }
    if (!result || !result.jobComplete || !result.rows || !result.rows[0]) {
        throw new FinopsUnavailable('Cost data is unavailable right now. Try again shortly.');
    }
    const summary = buildSummary(JSON.parse(result.rows[0].f[0].v), now(), cfg);
    if (redis) {
        try { await redis.set(cfg.cache_key, JSON.stringify(summary), 'EX', cfg.cache_seconds); } catch (_) { /* optional */ }
    }
    return { ...summary, cached: false };
}

module.exports = { getSummary, buildQuery, buildSummary, alertsFor, projectsFrom, FinopsUnavailable, CONFIG };
