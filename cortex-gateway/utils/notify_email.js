'use strict';
/**
 * The one outbound email sender (S2-93). Design:
 * documents/architecture/share-results-and-invite-delivery-design-2026-11-19.md §3.2.
 *
 * sendEmail() reports whether the provider ACCEPTED the email: { sent, providerId, status, reason }.
 * It never throws. Until 2026-11-19 the invite code ignored Resend's reply, so a refused email was
 * logged as "sent". Each attempt writes one `notify.email` log event with the kind and the result only:
 * no address, subject or body (allow-listed fields, config/log_events.json).
 * Delivery after acceptance (bounces) is RV-26.
 */
const CONFIG = require('../config/notify.json');
const { logEvent, LOG_EVENTS } = require('./log_event');

const REASONS = Object.freeze({
    NOT_CONFIGURED: 'not_configured',
    INVALID: 'invalid_request',
    REJECTED: 'rejected',
    TIMEOUT: 'timeout',
    NETWORK: 'network_error',
});

async function sendEmail({ to, subject, html, kind }, {
    fetchImpl = fetch, apiKey = process.env.RESEND_API_KEY, log = logEvent, timeoutMs = CONFIG.timeout_ms,
} = {}) {
    const finish = result => {
        log(LOG_EVENTS.NOTIFY_EMAIL, { kind, sent: result.sent, status: result.status, reason: result.reason });
        return result;
    };
    if (!apiKey) return finish({ sent: false, reason: REASONS.NOT_CONFIGURED });
    if (!to || !subject || !html) return finish({ sent: false, reason: REASONS.INVALID });

    let resp;
    try {
        resp = await fetchImpl(CONFIG.endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: CONFIG.from, to: [to], subject, html }),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        return finish({ sent: false, reason: timedOut ? REASONS.TIMEOUT : REASONS.NETWORK });
    }
    if (!resp.ok) return finish({ sent: false, status: resp.status, reason: REASONS.REJECTED });

    let providerId = null;
    try { providerId = (await resp.json())?.id || null; } catch { /* accepted; id unknown */ }
    return finish({ sent: true, status: resp.status, providerId });
}

/** Escapes text placed into an email's HTML (names come from user profiles). */
function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { sendEmail, escapeHtml, REASONS };
