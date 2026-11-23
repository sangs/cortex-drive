'use client';
/**
 * Settings → People (S2-50 build 2b; design documents/security/offboarding-and-retention-design-2026-11-20.md §5, §7).
 * Members of your organization (owner / organization admin only) and outside people you shared with. "Remove" first
 * shows what will happen (a dry run on the gateway), then asks to confirm. Confirmation is inline (no browser dialogs).
 */
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { ArrowLeft, Loader2, UserMinus } from 'lucide-react';
import { GATEWAY_URL as GATEWAY } from '@/lib/gateway';
import AccountMenu from '@/components/AccountMenu';
import { previewLines, readPeople, type Person } from '@/utils/people';

type Preview = { person: Person; lines: string[] } | null;

export default function PeoplePage() {
    const { getToken, isSignedIn } = useAuth();
    const [people, setPeople] = useState<Person[] | null>(null);
    const [preview, setPreview] = useState<Preview>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);

    const call = useCallback(async (path: string, body?: unknown) => {
        const token = await getToken();
        const resp = await fetch(`${GATEWAY}${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data?.error || `Request failed (${resp.status})`);
        return data;
    }, [getToken]);

    const load = useCallback(async () => {
        if (!isSignedIn) return;
        try { setPeople(readPeople(await call('/api/people'))); } catch (e: any) { setMessage(e.message); setPeople([]); }
    }, [call, isSignedIn]);
    useEffect(() => { load(); }, [load]);

    const path = (p: Person) => `/api/people/${encodeURIComponent(p.userSub)}/${p.kind === 'member' ? 'remove-member' : 'remove-collaborator'}`;

    const ask = async (p: Person) => {
        setBusy(p.userSub); setMessage(null);
        try {
            const r = await call(path(p), { confirm: false });
            setPreview({ person: p, lines: previewLines(p.kind, r.counts || {}) });
        } catch (e: any) { setMessage(e.message); }
        finally { setBusy(null); }
    };
    const confirm = async () => {
        if (!preview) return;
        const p = preview.person;
        setBusy(p.userSub); setMessage(null);
        try {
            await call(path(p), { confirm: true });
            setMessage(`${p.name || p.userSub} was removed.`);
            setPreview(null);
            await load();
        } catch (e: any) { setMessage(e.message); }
        finally { setBusy(null); }
    };

    const groups: [Person['kind'], string, string][] = [
        ['member', 'Members of your organization', 'Removing a member takes away their access here and moves what they added to you.'],
        ['collaborator', 'People you shared with', 'Removing a collaborator revokes what you shared with them and takes them out of your groups.'],
    ];

    return (
        <div className="min-h-screen bg-slate-50">
            <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
                <div className="max-w-5xl mx-auto px-6 h-16 flex items-center gap-4">
                    <Link href="/settings/sharing" className="flex items-center gap-1.5 text-slate-400 hover:text-slate-700 transition-colors text-sm">
                        <ArrowLeft className="w-4 h-4" /> Sharing & Access
                    </Link>
                    <span className="text-slate-200">/</span>
                    <span className="text-sm font-bold text-slate-700">People</span>
                    <div className="ml-auto"><AccountMenu /></div>
                </div>
            </header>
            <div className="max-w-5xl mx-auto px-6 py-10 space-y-8">
                <div>
                    <h1 className="text-2xl font-black text-slate-900">People</h1>
                    <p className="text-sm text-slate-500 mt-1">See who has access through you, and remove someone. You see what will happen before anything changes.</p>
                </div>
                {message && <div role="status" className="text-sm text-slate-700 bg-white border border-slate-200 rounded-xl px-4 py-3">{message}</div>}
                {people === null ? <Loader2 className="w-6 h-6 text-slate-300 animate-spin" /> : groups.map(([kind, title, help]) => {
                    const list = people.filter(p => p.kind === kind);
                    if (!list.length) return null;
                    return (
                        <section key={kind} className="space-y-3">
                            <div>
                                <h2 className="text-xs font-bold uppercase tracking-widest px-1 text-slate-500">{title}</h2>
                                <p className="text-xs text-slate-500 px-1 mt-1">{help}</p>
                            </div>
                            {list.map(p => (
                                <div key={p.userSub} className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
                                    <div className="flex items-center gap-3">
                                        <span className="font-bold text-slate-800">{p.name || 'Name not recorded'}</span>
                                        <span className="text-[11px] text-slate-400 font-mono">{p.userSub.slice(0, 14)}…</span>
                                        <button onClick={() => ask(p)} disabled={busy === p.userSub}
                                            className="ml-auto px-3 py-1.5 rounded-xl text-xs font-bold bg-white border border-rose-200 text-rose-700 hover:bg-rose-50 disabled:opacity-50 flex items-center gap-1">
                                            {busy === p.userSub ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserMinus className="w-3 h-3" />} Remove
                                        </button>
                                    </div>
                                    {preview && preview.person.userSub === p.userSub && (
                                        <div role="alertdialog" className="border border-rose-200 bg-rose-50 rounded-xl p-3 text-xs text-rose-900 space-y-2">
                                            <p className="font-bold">Removing {p.name || 'this person'} will:</p>
                                            <ul className="list-disc pl-5 space-y-0.5">{preview.lines.map(l => <li key={l}>{l}</li>)}</ul>
                                            <p>Shares and links can be given again later; removed access is not restored automatically.</p>
                                            <div className="flex gap-2">
                                                <button onClick={confirm} disabled={busy === p.userSub} className="px-3 py-1.5 rounded-xl font-bold bg-rose-600 hover:bg-rose-500 text-white disabled:opacity-50">Remove</button>
                                                <button onClick={() => setPreview(null)} className="px-3 py-1.5 rounded-xl font-bold bg-white border border-slate-200 text-slate-700">Cancel</button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </section>
                    );
                })}
                {people && people.length === 0 && <p className="text-sm text-slate-500">Nobody to show yet.</p>}
            </div>
        </div>
    );
}
