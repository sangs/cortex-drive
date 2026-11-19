'use strict';
/**
 * Invite delivery for share and group invitations (S2-93). Design:
 * documents/architecture/share-results-and-invite-delivery-design-2026-11-19.md.
 *
 * Moved out of index.js (`sendClerkOrgInvitation`) unchanged in what it does to the account: it still
 * creates a Clerk account plus a sign-in token. Replacing that with Clerk invitations is S2-96.
 * What is new:
 *   - the email goes through notify_email.sendEmail, so a refused email is reported, not logged as sent;
 *   - the result is stored on the pending invitation (email_status, email_provider_id, email_last_attempt_at;
 *     migration 013) and returned to the route as { emailSent, reason };
 *   - errors are no longer swallowed silently: they come back as emailSent=false with a reason;
 *   - the invitee's address and the sign-in link are never logged, and inviter names are HTML-escaped.
 * The sign-in link is a credential for the invitee, so it is sent only to the invitee, never shown to the sharer.
 */
const CONFIG = require('../config/notify.json');
const { sendEmail, escapeHtml } = require('./notify_email');
const { logEvent, LOG_EVENTS } = require('./log_event');

const EMAIL_KIND = 'invite';
const DEFAULT_INVITER = 'A Cortex-Drive member';

function inviteEmail({ inviterName, signInUrl }) {
    const who = escapeHtml(inviterName || DEFAULT_INVITER);
    return {
        subject: `${inviterName || DEFAULT_INVITER} invited you to Cortex-Drive`,
        html: `
            <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#080a0f;color:#e2e8f0;border-radius:16px">
                <h2 style="color:#fff;margin:0 0 16px">${who} invited you to Cortex-Drive</h2>
                <p style="color:#94a3b8;margin:0 0 8px">You've been given access to a shared knowledge graph on Cortex-Drive.</p>
                <p style="color:#94a3b8;margin:0 0 24px">Click below to sign in — your account has been created and access will be granted automatically.</p>
                <a href="${escapeHtml(signInUrl)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 24px;border-radius:12px;text-decoration:none;font-weight:700">Sign in to Cortex-Drive →</a>
                <p style="color:#475569;font-size:12px;margin-top:32px">This link expires in 7 days. If you didn't expect this, you can ignore this email.</p>
            </div>`,
    };
}

/**
 * deps: { clerkClient, db, activatePendingGrants, send = sendEmail, appUrl, log }
 * Returns { deliverInvite, inviterDisplayName }.
 */
function createInviteDelivery({ clerkClient, db, activatePendingGrants, send = sendEmail,
                                appUrl = process.env.APP_URL || CONFIG.app_url_default, log = logEvent }) {

    /** The sharer's display name for the email, falling back to `fallback`. */
    async function inviterDisplayName(issuerSub, fallback) {
        try {
            const issuer = await clerkClient.users.getUser(issuerSub);
            return `${issuer.firstName || ''} ${issuer.lastName || ''}`.trim()
                || issuer.emailAddresses?.[0]?.emailAddress || fallback;
        } catch { return fallback; }
    }

    async function recordResult({ invitationType, resourceId, email }, result) {
        if (!invitationType || !resourceId) return;
        try {
            await db.query(
                `UPDATE invitations
                    SET email_status = $4, email_provider_id = $5, email_last_attempt_at = now()
                  WHERE invitation_type = $1 AND resource_id = $2 AND invited_email = $3 AND status = 'pending'`,
                [invitationType, String(resourceId), email, result.emailSent ? 'sent' : 'failed', result.providerId || null]
            );
        } catch (err) {
            console.error('[invite-delivery] could not record email status:', err.message);
        }
    }

    /**
     * Sends the invite email for a pending invitation and records the result on it.
     * Returns { emailSent: boolean, reason?: string }.
     */
    async function deliverInvite({ email, inviterName, invitationType, resourceId }) {
        const toEmail = String(email || '').toLowerCase().trim();
        let account = 'unknown';
        let result;
        try {
            let userId;
            const existing = await clerkClient.users.getUserList({ emailAddress: [toEmail] });
            if (existing.data.length > 0) {
                userId = existing.data[0].id;
                account = 'existing';
            } else {
                // Unchanged until S2-96: create the account; a random password is set but never used.
                const randomPassword = require('crypto').randomBytes(32).toString('hex');
                const derivedFirstName = toEmail.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                const newUser = await clerkClient.users.createUser({
                    emailAddress: [toEmail], password: randomPassword, skipPasswordChecks: true, firstName: derivedFirstName,
                });
                userId = newUser.id;
                account = 'created';
                // Not added to the organization (S2-47): people you share with are external collaborators.
                activatePendingGrants(toEmail, userId).catch(e => console.error('[invite-delivery] activatePendingGrants:', e.message));
            }
            const signInToken = await clerkClient.signInTokens.createSignInToken({
                userId, expiresInSeconds: CONFIG.invite_token_ttl_seconds,
            });
            const signInUrl = `${appUrl}/sign-in?__clerk_ticket=${signInToken.token}`;
            const { subject, html } = inviteEmail({ inviterName, signInUrl });
            const sent = await send({ to: toEmail, subject, html, kind: EMAIL_KIND });
            result = { emailSent: sent.sent, reason: sent.reason, providerId: sent.providerId };
        } catch (err) {
            const detail = err && err.errors ? JSON.stringify(err.errors).slice(0, 300) : (err && err.message);
            console.error('[invite-delivery] account or token step failed:', detail);
            result = { emailSent: false, reason: 'account_step_failed' };
        }
        log(LOG_EVENTS.INVITE_DELIVERY, { invitation_type: invitationType, email_sent: result.emailSent, reason: result.reason, account });
        await recordResult({ invitationType, resourceId, email: toEmail }, result);
        return { emailSent: result.emailSent, ...(result.reason ? { reason: result.reason } : {}) };
    }

    return { deliverInvite, inviterDisplayName };
}

/** What a route adds to its JSON for the UI (one shape for every invite route). */
function deliveryFields(delivery) {
    return { emailSent: Boolean(delivery && delivery.emailSent) };
}

module.exports = { createInviteDelivery, deliveryFields, inviteEmail };
