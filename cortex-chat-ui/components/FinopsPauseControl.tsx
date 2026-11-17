"use client";
/**
 * The owner's manual pause of OpenAI spend (FinOps S2-83 release 5; design §7). Reads and changes the setting through
 * the gateway's owner-only GET/POST /api/finops/pause (404 for everyone else). Pausing takes two clicks (no browser
 * dialog). Every change is audited by the gateway. Stops usage-based spend only: Google Cloud and plans keep billing.
 */
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { Loader2, PauseCircle, PlayCircle } from 'lucide-react';

import { GATEWAY_URL } from '@/lib/gateway';

interface PauseStatus { paused: boolean; reason: string | null; updated_by: string | null; updated_at: string | null }
const REASON_MAX_CHARS = 200;   // the gateway clips to config/finops.json pause.reason_max_chars

export default function FinopsPauseControl() {
    const { getToken } = useAuth();
    const [status, setStatus] = useState<PauseStatus | null>(null);
    const [reason, setReason] = useState('');
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const call = useCallback(async (init?: RequestInit) => {
        const token = await getToken();
        const res = await fetch(`${GATEWAY_URL}/api/finops/pause`, {
            ...init, cache: 'no-store',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        return body as PauseStatus;
    }, [getToken]);

    useEffect(() => { call().then(setStatus, e => setError(e.message)); }, [call]);

    const change = async (paused: boolean) => {
        setBusy(true);
        setError(null);
        try {
            setStatus(await call({ method: 'POST', body: JSON.stringify({ paused, reason }) }));
            setReason('');
            setConfirming(false);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not change the pause.');
        } finally {
            setBusy(false);
        }
    };

    if (!status) {
        return error ? <p className="text-sm text-red-700">{error}</p>
            : <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>;
    }
    return (
        <div className="space-y-3">
            <p className="text-sm">
                OpenAI calls are{' '}
                <span className={`font-bold ${status.paused ? 'text-red-700' : 'text-emerald-700'}`}>{status.paused ? 'paused' : 'running'}</span>
                {status.updated_at && <span className="text-slate-500"> · changed {new Date(status.updated_at).toLocaleString()}</span>}
                {status.reason && <span className="text-slate-500"> · “{status.reason}”</span>}
            </p>
            <input value={reason} onChange={e => setReason(e.target.value.slice(0, REASON_MAX_CHARS))} placeholder="Reason (kept in the audit log)"
                   className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" aria-label="Reason for the change" />
            {status.paused ? (
                <button onClick={() => change(false)} disabled={busy}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 text-white text-xs font-bold disabled:opacity-50">
                    <PlayCircle className="w-4 h-4" /> Resume OpenAI calls
                </button>
            ) : confirming ? (
                <span className="inline-flex items-center gap-2">
                    <button onClick={() => change(true)} disabled={busy}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-red-600 text-white text-xs font-bold disabled:opacity-50">
                        <PauseCircle className="w-4 h-4" /> Confirm: pause for every user
                    </button>
                    <button onClick={() => setConfirming(false)} disabled={busy} className="px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-600">Cancel</button>
                </span>
            ) : (
                <button onClick={() => setConfirming(true)}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-red-200 text-red-700 text-xs font-bold hover:bg-red-50">
                    <PauseCircle className="w-4 h-4" /> Pause OpenAI calls
                </button>
            )}
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
            <p className="text-[11px] text-slate-500">
                While paused, nobody can ask questions or add sources (they see a “paused by the owner” message), and ingestion
                stops before calling OpenAI. Google Cloud, Neo4j Aura and other plans keep billing. Takes effect within about
                10 seconds on every service.
            </p>
        </div>
    );
}
