"use client";
/**
 * "Transferred to you" (S2-50 §3b, documents/security/offboarding-and-retention-design-2026-11-20.md §3b).
 * Content of a person who left, moved to this steward. Each transfer is its own group: review it, keep it as yours
 * (it then joins your answers), delete sources (permanent), or delete the person's hidden chats now.
 * Shows nothing for people who have never received a transfer. Confirmations are inline (no browser dialogs).
 */
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Archive, Check, Loader2, MessageSquareX, Trash2 } from "lucide-react";
import { GATEWAY_URL as GATEWAY } from "@/lib/gateway";
import { readTransferItems, readTransfers, type Transfer, type TransferItems } from "@/utils/transfers";

type Pending = { transferId: string; action: "delete" | "purge"; sourceIds?: string[]; label: string } | null;

export default function TransferredToYou() {
    const { getToken, isSignedIn } = useAuth();
    const [transfers, setTransfers] = useState<Transfer[] | null>(null);
    const [open, setOpen] = useState<string | null>(null);
    const [items, setItems] = useState<Record<string, TransferItems>>({});
    const [busy, setBusy] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<Pending>(null);
    const [message, setMessage] = useState<string | null>(null);

    const call = useCallback(async (path: string, body?: unknown) => {
        const token = await getToken();
        const resp = await fetch(`${GATEWAY}${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data?.error || `Request failed (${resp.status})`);
        return data;
    }, [getToken]);

    const load = useCallback(async () => {
        if (!isSignedIn) return;
        try { setTransfers(readTransfers(await call("/api/transfers"))); } catch { /* keep what is shown */ }
    }, [call, isSignedIn]);
    useEffect(() => { load(); }, [load]);

    const loadItems = useCallback(async (id: string) => {
        try {
            const data = await call(`/api/transfers/${id}/items`);
            const parsed = readTransferItems(data);
            if (parsed) setItems(prev => ({ ...prev, [id]: parsed }));
        } catch (e: any) { setMessage(e.message); }
    }, [call]);

    const run = async (id: string, path: string, body: unknown, done: (r: any) => string) => {
        setBusy(id); setMessage(null); setConfirm(null);
        try {
            const r = await call(path, body);
            setMessage(done(r));
            await load();
            await loadItems(id);
        } catch (e: any) { setMessage(e.message); }
        finally { setBusy(null); }
    };

    if (!transfers || transfers.length === 0) return null;
    return (
        <section className="space-y-3" aria-label="Transferred to you">
            <div>
                <h2 className="text-xs font-bold uppercase tracking-widest px-1 text-slate-500">Transferred to you</h2>
                <p className="text-xs text-slate-500 px-1 mt-1">
                    Content of people who left, now owned by you. It stays out of your answers until you keep it.
                </p>
            </div>
            {message && <div role="status" className="text-xs text-slate-700 bg-slate-100 rounded-xl px-3 py-2">{message}</div>}
            {transfers.map(t => {
                const it = items[t.transferId];
                const isOpen = open === t.transferId;
                return (
                    <div key={t.transferId} className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <Archive className="w-4 h-4 text-amber-500" />
                            <span className="font-bold text-slate-800">Transferred from {t.fromName}</span>
                            <span className="text-xs text-slate-400">{t.createdAt.slice(0, 10)}</span>
                            <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${t.status === "reviewed" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                                {t.status === "reviewed" ? "Reviewed" : "In review"}
                            </span>
                            {t.reminder && <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-rose-50 text-rose-700">Waiting for your decision</span>}
                        </div>
                        <div className="text-xs text-slate-600 flex flex-wrap gap-x-4 gap-y-1">
                            <span>{t.nodes} item{t.nodes === 1 ? "" : "s"} transferred</span>
                            <span>{t.sharesKept} share{t.sharesKept === 1 ? "" : "s"} kept for others</span>
                            <span>
                                {t.hiddenChats} hidden chat{t.hiddenChats === 1 ? "" : "s"}
                                {t.hiddenChats > 0 && t.hiddenChatsPurgeOn ? `, deleted automatically on ${t.hiddenChatsPurgeOn}` : ""}
                            </span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <button onClick={() => { const next = isOpen ? null : t.transferId; setOpen(next); if (next) loadItems(next); }}
                                className="px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700">
                                {isOpen ? "Hide items" : "Review items"}
                            </button>
                            {t.status !== "reviewed" && (
                                <button disabled={busy === t.transferId}
                                    onClick={() => run(t.transferId, `/api/transfers/${t.transferId}/keep`, {}, r => `Kept ${r.changed} item(s) as yours.`)}
                                    className="px-3 py-1.5 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 flex items-center gap-1">
                                    <Check className="w-3 h-3" /> Keep all as mine
                                </button>
                            )}
                            {t.hiddenChats > 0 && (
                                <button disabled={busy === t.transferId}
                                    onClick={() => setConfirm({ transferId: t.transferId, action: "purge", label: `${t.hiddenChats} hidden chat(s) of ${t.fromName}` })}
                                    className="px-3 py-1.5 rounded-xl text-xs font-bold bg-white border border-rose-200 text-rose-700 hover:bg-rose-50 disabled:opacity-50 flex items-center gap-1">
                                    <MessageSquareX className="w-3 h-3" /> Delete hidden chats now
                                </button>
                            )}
                            {busy === t.transferId && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
                        </div>

                        {confirm && confirm.transferId === t.transferId && (
                            <div className="border border-rose-200 bg-rose-50 rounded-xl p-3 text-xs text-rose-800 space-y-2" role="alertdialog">
                                <p>
                                    {confirm.action === "delete"
                                        ? <>Delete <b>{confirm.label}</b> and the transferred items only it uses? Items someone else&apos;s content still uses are kept. This cannot be undone.</>
                                        : <>Delete <b>{confirm.label}</b> now? Nobody can open them; they would otherwise be deleted automatically. This cannot be undone.</>}
                                </p>
                                <div className="flex gap-2">
                                    <button onClick={() => confirm.action === "delete"
                                        ? run(t.transferId, `/api/transfers/${t.transferId}/delete`, { source_ids: confirm.sourceIds, confirm: true },
                                              r => `Deleted ${r.deleted} item(s)${r.keptInUse ? `; ${r.keptInUse} kept because other content uses them` : ""}.`)
                                        : run(t.transferId, `/api/transfers/${t.transferId}/purge-history`, { confirm: true }, r => `Deleted ${r.deleted} hidden chat(s).`)}
                                        className="px-3 py-1.5 rounded-xl font-bold bg-rose-600 hover:bg-rose-500 text-white">Delete permanently</button>
                                    <button onClick={() => setConfirm(null)} className="px-3 py-1.5 rounded-xl font-bold bg-white border border-slate-200 text-slate-700">Cancel</button>
                                </div>
                            </div>
                        )}

                        {isOpen && (
                            it ? (
                                <div className="space-y-2">
                                    {it.sources.length === 0 && it.otherNodes === 0 && <p className="text-xs text-slate-500">Nothing left to review.</p>}
                                    {it.sources.map(s => (
                                        <div key={s.nodeId} className="flex flex-wrap items-center gap-2 border border-slate-100 rounded-xl px-3 py-2">
                                            <span className="text-sm text-slate-800 font-medium">{s.name}</span>
                                            <span className="text-[10px] text-slate-400">{s.type} · {s.nodes} item{s.nodes === 1 ? "" : "s"}</span>
                                            <div className="ml-auto flex gap-2">
                                                <button disabled={busy === t.transferId}
                                                    onClick={() => run(t.transferId, `/api/transfers/${t.transferId}/keep`, { source_ids: [s.nodeId] }, r => `Kept ${r.changed} item(s) as yours.`)}
                                                    className="px-2 py-1 rounded-lg text-[11px] font-bold bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">Keep</button>
                                                <button disabled={busy === t.transferId}
                                                    onClick={() => setConfirm({ transferId: t.transferId, action: "delete", sourceIds: [s.nodeId], label: `"${s.name}"` })}
                                                    className="px-2 py-1 rounded-lg text-[11px] font-bold bg-rose-50 text-rose-700 hover:bg-rose-100 disabled:opacity-50 flex items-center gap-1">
                                                    <Trash2 className="w-3 h-3" /> Delete
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                    {it.otherNodes > 0 && (
                                        <p className="text-xs text-slate-500">{it.otherNodes} other item(s) not under a source: &quot;Keep all as mine&quot; covers them.</p>
                                    )}
                                </div>
                            ) : <Loader2 className="w-4 h-4 animate-spin text-slate-300" />
                        )}
                    </div>
                );
            })}
        </section>
    );
}
