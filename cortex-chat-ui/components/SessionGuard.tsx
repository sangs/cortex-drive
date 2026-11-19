"use client";
/**
 * Clears every user's browser state whenever their session ends (S2-92).
 * Design: documents/architecture/sign-out-and-sign-in-design-2026-11-18.md §3.3.
 *
 * Mounted once in app/layout.tsx. It watches Clerk's signed-in user, not the Sign out button, so it
 * covers every way a session ends: the button, another tab (Clerk syncs tabs), expiry, an admin
 * revoke in the Clerk dashboard, and "sign out of other devices". The hard navigation also drops
 * in-memory state (graph, undo stack, messages) and cancels requests still in flight.
 */
import { useEffect, useRef } from 'react';
import { useAuth } from '@clerk/nextjs';

import { AFTER_SIGN_OUT_URL, clearUserClientState, sessionTransition } from '@/lib/session-state';

export default function SessionGuard() {
    const { isLoaded, userId } = useAuth();
    const prevUserId = useRef<string | null>(null);

    useEffect(() => {
        if (!isLoaded) return;
        const current = userId ?? null;
        const action = sessionTransition(prevUserId.current, current, window.location.pathname);
        prevUserId.current = current;
        if (action === 'none') return;
        clearUserClientState();
        if (action === 'clear-and-redirect') window.location.replace(AFTER_SIGN_OUT_URL);
        else if (action === 'clear-and-reload') window.location.reload();
    }, [isLoaded, userId]);

    return null;
}
