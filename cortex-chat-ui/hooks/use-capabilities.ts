"use client";
/**
 * What the signed-in user may do (S2-69, 2026-10-29), from the gateway's GET /api/me/capabilities.
 * The UI shows a control only when its capability is true. While loading, or if the call fails,
 * every capability is false (fail closed). The gateway routes enforce the same rules; hiding a
 * control is a courtesy, never the protection.
 */
import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:4000';

export type SourceVisibility = 'private' | 'organization' | 'public';
export interface Capabilities {
    addSource: boolean;
    sourceVisibilities: SourceVisibility[];
    share: boolean;
    shareOrgWide: boolean;
    manageGroups: boolean;
    admin: boolean;
}
export const NO_CAPABILITIES: Capabilities = Object.freeze({
    addSource: false, sourceVisibilities: [], share: false, shareOrgWide: false, manageGroups: false, admin: false,
}) as Capabilities;

// One request per signed-in user per page load, shared by every component that asks.
const cache = new Map<string, Promise<Capabilities>>();

async function fetchCapabilities(getToken: () => Promise<string | null>): Promise<Capabilities> {
    const token = await getToken();
    if (!token) return NO_CAPABILITIES;
    const resp = await fetch(`${GATEWAY}/api/me/capabilities`, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return NO_CAPABILITIES;
    const body = await resp.json();
    return { ...NO_CAPABILITIES, ...(body?.capabilities || {}) };
}

export function useCapabilities(): Capabilities {
    const { getToken, userId, isSignedIn } = useAuth();
    const [caps, setCaps] = useState<Capabilities>(NO_CAPABILITIES);
    useEffect(() => {
        if (!isSignedIn || !userId) { setCaps(NO_CAPABILITIES); return; }
        let cancelled = false;
        if (!cache.has(userId)) {
            const p = fetchCapabilities(getToken).catch(() => NO_CAPABILITIES);
            cache.set(userId, p);
            p.then(c => { if (c === NO_CAPABILITIES) cache.delete(userId); });   // retry on next mount
        }
        cache.get(userId)!.then(c => { if (!cancelled) setCaps(c); });
        return () => { cancelled = true; };
    }, [isSignedIn, userId, getToken]);
    return caps;
}
