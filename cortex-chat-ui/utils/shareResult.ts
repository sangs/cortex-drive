/**
 * What a share request actually did (S2-93). Design:
 * documents/architecture/share-results-and-invite-delivery-design-2026-11-19.md §3.1.
 *
 * Until 2026-11-19 the share dialog showed its success text for every response, so a refused share
 * (409 "already visible to everyone") read as "Invite sent". Every share handler now goes through
 * readShareResult() and shows `message` in the success or the error slot.
 */

type ShareBody = Record<string, unknown> & { error?: string; denied?: unknown[]; reused?: boolean; emailSent?: boolean; roots?: number; totalNodes?: number };

export interface ShareResult<T = ShareBody> {
    ok: boolean;
    status: number;
    data: T;
    /** The gateway's own error text on failure (share refusals carry safe, fixed messages). */
    error?: string;
}

/** Reads a share response without throwing. Non-2xx → ok=false with the gateway's error text. */
export async function readShareResult(resp: { ok: boolean; status: number; json: () => Promise<unknown> }): Promise<ShareResult> {
    let data: ShareBody = {};
    try { data = ((await resp.json()) as ShareBody) || {}; } catch { /* empty or non-JSON body */ }
    if (resp.ok) return { ok: true, status: resp.status, data };
    const denied = Array.isArray(data?.denied) && data.denied.length ? ` (${data.denied.length} node${data.denied.length > 1 ? 's' : ''})` : '';
    return { ok: false, status: resp.status, data, error: `${data?.error || `The share did not go through (error ${resp.status}).`}${denied}` };
}

/** Text shown after an invite to someone without an account. */
export function inviteMessage(email: string, data: { reused?: boolean; emailSent?: boolean }): { ok: boolean; text: string } {
    if (data.emailSent === false) {
        return { ok: false, text: `Invite saved for ${email}, but the email could not be sent. Try again from Sharing & Access → Pending invites.` };
    }
    return { ok: true, text: data.reused ? `Invite email sent again to ${email}.` : `Invite sent to ${email}. They'll get access when they sign in.` };
}

/**
 * Whether anything in the selection needs a share at all. The link preview reports `roots`: nodes that need a
 * grant. roots === 0 means everything is Public or built-in: everyone can already see it, so there is nothing to
 * share (Invariant 9). Point the user to a graph link instead.
 */
export function needsGrant(preview: { roots?: number } | null | undefined): boolean {
    return Boolean(preview && typeof preview.roots === 'number' && preview.roots > 0);
}

export const PUBLIC_ONLY_TEXT =
    'Everything here is already visible to everyone (Public or built-in), so there is nothing to share. ' +
    'To point someone to it, create a link on the Public Link tab and send it to them.';
