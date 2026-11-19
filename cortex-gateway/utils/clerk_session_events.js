'use strict';
/**
 * Clerk session webhooks → sign-in / sign-out audit log (S2-92).
 * Design: documents/architecture/sign-out-and-sign-in-design-2026-11-18.md §3.4.
 *
 * Audit only: one structured `[AUTH]` line per session start or end (user ID, session ID, Clerk
 * event, status). No token is logged and nothing is written to Redis or Permify. The request path
 * is unchanged: authMiddleware keeps stateless verifyToken (RV-24 records when to add revocation).
 *
 * The Clerk webhook endpoint must be subscribed to these event types (Clerk dashboard → Webhooks).
 */
const { logEvent, LOG_EVENTS } = require('./log_event');

/** Clerk event type → audit log event. */
const SESSION_EVENT_LOG = Object.freeze({
    'session.created': LOG_EVENTS.AUTH_SESSION_STARTED,
    'session.ended':   LOG_EVENTS.AUTH_SESSION_ENDED,
    'session.removed': LOG_EVENTS.AUTH_SESSION_ENDED,
    'session.revoked': LOG_EVENTS.AUTH_SESSION_ENDED,
});

function isClerkSessionEvent(event) {
    return Boolean(event && Object.prototype.hasOwnProperty.call(SESSION_EVENT_LOG, event.type));
}

/** Logs one audit line for a verified Clerk session event. Returns false for other event types. */
function handleClerkSessionEvent(event, log = logEvent) {
    if (!isClerkSessionEvent(event)) return false;
    const data = event.data || {};
    log(SESSION_EVENT_LOG[event.type], {
        clerk_event: event.type,
        user_id: typeof data.user_id === 'string' ? data.user_id : undefined,
        session_id: typeof data.id === 'string' ? data.id : undefined,
        status: typeof data.status === 'string' ? data.status : undefined,
    });
    return true;
}

module.exports = { handleClerkSessionEvent, isClerkSessionEvent, SESSION_EVENT_LOG };
