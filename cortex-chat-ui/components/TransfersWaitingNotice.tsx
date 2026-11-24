"use client";
/**
 * Dashboard notice (S2-50 §3b, owner approved 2026-11-23): content transferred to you is waiting for review. Without it
 * the only place to find out is Settings. Shows nothing when there is none (GET /api/transfers, one call per load).
 */
import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { Archive } from "lucide-react";
import { GATEWAY_URL as GATEWAY } from "@/lib/gateway";
import { readTransfers, waitingNotice } from "@/utils/transfers";

export default function TransfersWaitingNotice() {
    const { getToken, isSignedIn } = useAuth();
    const [text, setText] = useState<string | null>(null);

    useEffect(() => {
        if (!isSignedIn) return;
        (async () => {
            try {
                const token = await getToken();
                const resp = await fetch(`${GATEWAY}/api/transfers`, { headers: { Authorization: `Bearer ${token}` } });
                if (resp.ok) setText(waitingNotice(readTransfers(await resp.json())));
            } catch { /* no notice */ }
        })();
    }, [getToken, isSignedIn]);

    if (!text) return null;
    return (
        <div role="status" className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs">
            <Archive className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-600" />
            <span>
                {text}{" "}
                <Link href="/settings/sharing" className="font-bold underline hover:text-amber-700">Review</Link>
            </span>
        </div>
    );
}
