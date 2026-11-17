'use strict';
/**
 * OpenAI usage recording (FinOps design 2026-11-16 §3, tracker S2-83, release 1).
 *
 * Every OpenAI call writes one `openai.usage` log event: service, feature, model, tokens, cost and user type.
 * No prompt, content or id is ever logged (the event's fields are allow-listed in config/log_events.json).
 * A Cloud Logging sink → BigQuery aggregates these lines for the daily push to finops-admin (release 2).
 *
 * Prices come only from config/openai_prices.json. A model with no price is recorded with cost 0 and
 * price_missing=true, and an `openai.price_missing` WARNING is logged — never a guessed price.
 *
 * Recording never changes behaviour: it runs after the call returned, never throws, and returns the response
 * untouched. User type is read from the request that started the call (AsyncLocalStorage set by
 * usageContextMiddleware); calls outside a request (start-up) carry no user type.
 *
 * The Python twin is src/mcp_server/usage_log.py, reading the generated mirror src/mcp_server/config/openai_usage.json
 * (scripts/sync_openai_usage_config.js); both are checked against tests/fixtures/openai_usage_cases.json.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const PRICES = require('../config/openai_prices.json');
const { logEvent, LOG_EVENTS } = require('./log_event');

/** Feature names recorded with each call (one per call site). */
const OPENAI_FEATURES = Object.freeze({
    CHAT: 'chat',                       // main tool-calling loop
    WRITER: 'writer',                   // career item prose (buildQ2WriterCall)
    CITATION_WRITER: 'citation_writer', // citations block (buildCitationWriterCall)
    CROSS_ANSWER: 'cross_answer',       // cross-domain bridge answer
    CLASSIFY_INIT: 'classify_init',     // intent classifier prototype embeddings (start-up)
    CLASSIFY_EMBED: 'classify_embed',   // intent classifier question embedding
});

const TOKENS_PER_PRICE_UNIT = 1_000_000;
const COST_DECIMALS = 8;
/** Cloud Run service (K_SERVICE) or job (CLOUD_RUN_JOB); 'local' on a laptop. */
const SERVICE_ENV_VARS = ['K_SERVICE', 'CLOUD_RUN_JOB'];
const LOCAL_SERVICE = 'local';
const USER_TYPE_HEADER = 'x-user-type';   // gateway-assigned (AP-23)

const requestContext = new AsyncLocalStorage();
const MODEL_KEYS = Object.keys(PRICES.models).sort((a, b) => b.length - a.length);   // longest prefix first

function serviceName(env = process.env) {
    for (const name of SERVICE_ENV_VARS) if (env[name]) return env[name];
    return LOCAL_SERVICE;
}

/** Price entry for a model name, by longest matching prefix; null when unknown. */
function priceFor(model) {
    if (typeof model !== 'string') return null;
    const key = MODEL_KEYS.find(k => model === k || model.startsWith(`${k}-`));
    return key ? PRICES.models[key] : null;
}

/** Token counts from a chat or embeddings `usage` object. */
function tokensOf(usage) {
    usage = usage || {};
    const prompt = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.cached_input_tokens ?? 0;
    const completion = usage.completion_tokens ?? usage.output_tokens ?? 0;
    return { prompt_tokens: prompt, cached_tokens: Math.min(cached, prompt), completion_tokens: completion };
}

/** {cost_usd, price_missing} for a model and token counts. Cached input is billed at the cached price when listed. */
function costOf(model, tokens) {
    const price = priceFor(model);
    if (!price) return { cost_usd: 0, price_missing: true };
    const cachedPrice = price.cached_input_per_1m ?? price.input_per_1m;
    const cost = ((tokens.prompt_tokens - tokens.cached_tokens) * price.input_per_1m
        + tokens.cached_tokens * cachedPrice
        + tokens.completion_tokens * price.output_per_1m) / TOKENS_PER_PRICE_UNIT;
    return { cost_usd: Number(cost.toFixed(COST_DECIMALS)), price_missing: false };
}

/** The event fields for one call (exported for tests). */
function usageFields({ feature, model, usage, userType, service = serviceName() }) {
    const tokens = tokensOf(usage);
    return { service, feature, model, ...tokens, ...costOf(model, tokens),
             prices_effective: PRICES.effective_date, user_type: userType };
}

function currentUserType() {
    return requestContext.getStore()?.req?.headers?.[USER_TYPE_HEADER];
}

/** Records one OpenAI response. Never throws; returns the response unchanged. */
function recordOpenAIUsage(feature, response, { model, userType, sink } = {}) {
    try {
        const fields = usageFields({ feature, model: response?.model || model, usage: response?.usage,
                                     userType: userType ?? currentUserType() });
        logEvent(LOG_EVENTS.OPENAI_USAGE, fields, sink);
        if (fields.price_missing) {
            logEvent(LOG_EVENTS.OPENAI_PRICE_MISSING, { service: fields.service, feature, model: fields.model }, sink);
        }
    } catch (err) {
        console.warn(`[OPENAI_USAGE] not recorded (${err && err.name})`);
    }
    return response;
}

/** `await withUsage(FEATURE, client.chat.completions.create({...}))` — the call is unchanged, its usage recorded. */
async function withUsage(feature, callPromise, options) {
    return recordOpenAIUsage(feature, await callPromise, options);
}

/** Express middleware: lets usage recorded anywhere in this request read its user type. */
function usageContextMiddleware(req, _res, next) {
    requestContext.run({ req }, next);
}

module.exports = {
    OPENAI_FEATURES, withUsage, recordOpenAIUsage, usageContextMiddleware,
    usageFields, costOf, tokensOf, priceFor, serviceName, PRICES,
};
