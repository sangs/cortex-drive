/**
 * Per-user browser state and the sign-in / sign-out routes (S2-92).
 * Design: documents/architecture/sign-out-and-sign-in-design-2026-11-18.md §3.2–3.3.
 *
 * Every sessionStorage key that holds one user's data is listed in config/auth-session.json, so a
 * new key is added there (data), and clearUserClientState() removes it on every way a session ends.
 */
import authSession from '../config/auth-session.json' with { type: 'json' };

export const AUTH_ROUTES = Object.freeze({ ...authSession.routes });
/** Named keys, so code reads STORAGE_KEYS.dashboard rather than repeating the string. */
export const STORAGE_KEYS = Object.freeze({ ...authSession.userSessionStorageKeys });
export const USER_SESSION_STORAGE_KEYS: readonly string[] = Object.freeze(Object.values(STORAGE_KEYS));

/** Routes open without a session (Clerk route patterns); proxy.ts protects every other route. */
export const PUBLIC_ROUTES: readonly string[] = Object.freeze([...authSession.publicRoutes]);

/** Where Clerk sends a user after sign-out: the sign-in page, with the "You have signed out" note. */
export const AFTER_SIGN_OUT_URL = `${AUTH_ROUTES.signIn}?${AUTH_ROUTES.signedOutParam}=1`;

const PUBLIC_ROUTE_RES = PUBLIC_ROUTES.map(p => new RegExp(`^${p}$`));
/** True when `pathname` is reachable without a session (same patterns as proxy.ts). */
export function isPublicPath(pathname: string): boolean {
    return PUBLIC_ROUTE_RES.some(re => re.test(pathname));
}

/**
 * What SessionGuard does when Clerk's signed-in user changes. Pure, so it is unit-tested.
 * - signed out (anyone → nobody): clear; leave a protected page for the sign-in page
 * - a different user (A → B) on the same tab: clear, then reload so no in-memory state survives
 * - nobody signed in on load: clear (per-user state has no owner)
 */
export type SessionTransition = 'none' | 'clear' | 'clear-and-redirect' | 'clear-and-reload';
export function sessionTransition(prevUserId: string | null, userId: string | null, pathname: string): SessionTransition {
    if (!userId) return prevUserId && !isPublicPath(pathname) ? 'clear-and-redirect' : 'clear';
    if (prevUserId && prevUserId !== userId) return 'clear-and-reload';
    return 'none';
}

type Clearer = () => void;
const extraClearers = new Set<Clearer>();

/** In-memory caches keyed by user (e.g. the capabilities cache) register here to be cleared too. */
export function registerUserStateClearer(fn: Clearer): void {
    extraClearers.add(fn);
}

/** Removes every registered per-user key and in-memory cache. Safe to call more than once. */
export function clearUserClientState(storage: Pick<Storage, 'removeItem'> | null = safeSessionStorage()): void {
    if (storage) {
        for (const key of USER_SESSION_STORAGE_KEYS) {
            try { storage.removeItem(key); } catch { /* non-fatal */ }
        }
    }
    for (const fn of extraClearers) {
        try { fn(); } catch { /* non-fatal */ }
    }
}

/**
 * Saved dashboard state belongs to one user. Returns the state only when it was written by
 * `userId`; anything else (another user's state, or state from before S2-92 with no owner) is
 * not restored.
 */
export function ownedDashboardState<T extends { ownerUserId?: string }>(saved: T | null, userId: string | null | undefined): T | null {
    if (!saved || !userId) return null;
    return saved.ownerUserId === userId ? saved : null;
}

function safeSessionStorage(): Storage | null {
    try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}
