'use strict';
/**
 * Guest node-share tokens (GET /api/share → /discovery?share=<token>), signed with GATEWAY_SHARE_SECRET.
 * Graph-view links use utils/share_links.js instead; both read the same secret.
 *
 * Token = base64("<tenantId>:<nodeId>:<expiresAtMs>:<hex HMAC-SHA256(secret, tenantId:nodeId:expiresAtMs)>").
 * A token is honoured only while its Redis registration (guest_link:<sha256(token)>) exists; DEL = revoke.
 *
 * Fixed 2026-11-02 (GL-4/S2-72, GL-5; documents/security/go-live-readiness-review-2026-10-28.md):
 * - no in-code default secret (AP-24); production refuses to start without one of MIN_SHARE_SECRET_LENGTH;
 * - signatures compared in constant time;
 * - a non-numeric expiry was accepted forever (Date.now() > NaN is false); it is now rejected;
 * - fields are parsed from the right and node ids may not contain ':', so a tenant id with ':'
 *   (personal:<sub>) parses correctly and two different (tenant, node) pairs can't share one signature;
 * - a Redis error during the revocation check denies the link (503) instead of trusting the signature
 *   alone, and a link whose registration fails is not handed out.
 *
 * Built from injected dependencies so it can be unit-tested without a server.
 */
const crypto = require('crypto');

const MIN_SHARE_SECRET_LENGTH = 32;
const TOKEN_FIELD_SEPARATOR = ':';
const GUEST_LINK_KEY_PREFIX = 'guest_link:';
const GUEST_LINKS_SET_PREFIX = 'guest_links:';
const GUEST_LINKS_SET_TTL_SECONDS = 90 * 86400;
const MS_PER_DAY = 86400 * 1000;
const UNAVAILABLE_ERROR = 'Share links are temporarily unavailable. Try again shortly.';
const REVOKED_ERROR = 'This link has been revoked or has expired.';

const tokenHash = token => crypto.createHash('sha256').update(String(token)).digest('hex');

/** Why the configured secret can't be used, or null when it can. */
function shareSecretProblem(secret) {
    if (!secret) return 'GATEWAY_SHARE_SECRET is not set';
    if (secret.length < MIN_SHARE_SECRET_LENGTH) {
        return `GATEWAY_SHARE_SECRET is shorter than ${MIN_SHARE_SECRET_LENGTH} characters`;
    }
    return null;
}

/**
 * @param {object} deps
 *   secret   GATEWAY_SHARE_SECRET; no default. Unusable → sign() throws 503 and every token is invalid.
 *   redis    { get, setex, sadd, expire }
 */
function createShareTokens({ secret, redis, log = console }) {
    const configured = shareSecretProblem(secret) === null;
    const hmac = payload => crypto.createHmac('sha256', secret).update(payload).digest('hex');

    function sign(tenantId, nodeId, expiresDays) {
        if (!configured) {
            throw Object.assign(new Error('Share links are not configured (GATEWAY_SHARE_SECRET missing or too short)'), { status: 503 });
        }
        if (!tenantId || !nodeId || String(nodeId).includes(TOKEN_FIELD_SEPARATOR)) {
            throw Object.assign(new Error('This item cannot be shared by link'), { status: 400 });
        }
        const expiresAt = Date.now() + expiresDays * MS_PER_DAY;
        const payload = [tenantId, nodeId, expiresAt].join(TOKEN_FIELD_SEPARATOR);
        return { token: Buffer.from(`${payload}${TOKEN_FIELD_SEPARATOR}${hmac(payload)}`).toString('base64'), expiresAt };
    }

    /** → { tenantId, nodeId, expiresAt } for a well-formed, correctly signed, unexpired token; else null. */
    function verify(token) {
        if (!configured || typeof token !== 'string' || !token) return null;
        const fields = Buffer.from(token, 'base64').toString('utf-8').split(TOKEN_FIELD_SEPARATOR);
        if (fields.length < 4) return null;
        const signature = fields.pop();
        const expiresRaw = fields.pop();
        const nodeId = fields.pop();
        const tenantId = fields.join(TOKEN_FIELD_SEPARATOR);
        if (!tenantId || !nodeId || !/^\d+$/.test(expiresRaw)) return null;
        const expiresAt = Number(expiresRaw);
        if (!Number.isSafeInteger(expiresAt) || Date.now() > expiresAt) return null;

        const given = Buffer.from(signature, 'utf-8');
        const expected = Buffer.from(hmac([tenantId, nodeId, expiresRaw].join(TOKEN_FIELD_SEPARATOR)), 'utf-8');
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
        return { tenantId, nodeId, expiresAt };
    }

    /**
     * Full check for an incoming token.
     * → { ok: true, tenantId, nodeId } | { ok: false, status: 403|503, error } | { ok: false, status: null } (not a valid token)
     */
    async function check(token) {
        const verified = verify(token);
        if (!verified) return { ok: false, status: null };
        let active;
        try {
            active = await redis.get(`${GUEST_LINK_KEY_PREFIX}${tokenHash(token)}`);
        } catch (err) {
            log.error(`[GUEST-AUTH] Revocation check failed, link denied: ${err.message}`);
            return { ok: false, status: 503, error: UNAVAILABLE_ERROR };
        }
        if (!active) return { ok: false, status: 403, error: REVOKED_ERROR };
        return { ok: true, tenantId: verified.tenantId, nodeId: verified.nodeId };
    }

    /** Records the link so check() honours it. Throws 503 when Redis fails: an unregistered link would never open. */
    async function register(token, { tenantId, nodeId, issuedAt, expiresAt, expireDays }) {
        const hash = tokenHash(token);
        try {
            await redis.setex(`${GUEST_LINK_KEY_PREFIX}${hash}`, expireDays * 86400,
                              JSON.stringify({ nodeId, tenantId, issuedAt, expiresAt, expireDays }));
            await redis.sadd(`${GUEST_LINKS_SET_PREFIX}${tenantId}:${nodeId}`, hash);
            await redis.expire(`${GUEST_LINKS_SET_PREFIX}${tenantId}:${nodeId}`, GUEST_LINKS_SET_TTL_SECONDS);
        } catch (err) {
            log.error(`[GUEST-LINK] Registration failed, link not issued: ${err.message}`);
            throw Object.assign(new Error(UNAVAILABLE_ERROR), { status: 503 });
        }
        return hash;
    }

    return { configured, sign, verify, check, register };
}

module.exports = {
    createShareTokens,
    shareSecretProblem,
    tokenHash,
    MIN_SHARE_SECRET_LENGTH,
    GUEST_LINK_KEY_PREFIX,
    GUEST_LINKS_SET_PREFIX,
};
