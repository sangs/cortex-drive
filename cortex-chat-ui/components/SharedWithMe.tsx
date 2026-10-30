"use client";
/**
 * "Shared with me" (unified shares phase 2, 2026-10-29; design security/unified-shares-design-2026-10-29.md §5).
 * Lists what others shared with the signed-in user (GET /api/share/received: active grants, each re-checked
 * against the user's own permissions), with suggested questions built by fixed templates on the server.
 * Refreshes when the window regains focus, so a new share appears and a revoked one disappears.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { Inbox, MessageSquare, Network, ChevronDown, ChevronRight } from 'lucide-react';

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:4000';

export interface SharedItem {
    grantId: string;
    nodeId: string;
    title: string;
    type: string;
    description: string;
    nodeCount: number;
    sharedBy: string;
    sharedAt: string;
    expiresAt: string | null;
    via: { direct?: boolean; group?: string };
    questions: string[];
}

interface Props {
    onAsk: (question: string) => void;
    onOpen: (item: SharedItem) => void;
    // Show the empty-state hint (collaborators, whose dashboard is otherwise empty). Writers see nothing
    // when nothing is shared with them.
    showEmptyState: boolean;
    disabled?: boolean;
}

const fmtDate = (s: string) => new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export default function SharedWithMe({ onAsk, onOpen, showEmptyState, disabled = false }: Props) {
    const { getToken, isSignedIn } = useAuth();
    const [items, setItems] = useState<SharedItem[] | null>(null);
    const [open, setOpen] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!isSignedIn) return;
        try {
            const token = await getToken();
            const resp = await fetch(`${GATEWAY}/api/share/received`, { headers: { Authorization: `Bearer ${token}` } });
            if (resp.ok) setItems(await resp.json());
        } catch { /* keep the last list */ }
    }, [getToken, isSignedIn]);

    useEffect(() => {
        load();
        window.addEventListener('focus', load);
        return () => window.removeEventListener('focus', load);
    }, [load]);

    if (items === null) return null;
    if (items.length === 0) {
        if (!showEmptyState) return null;
        return (
            <div className="px-4 py-3 rounded-2xl bg-white border border-slate-200 text-[11px] text-slate-500" data-testid="shared-empty">
                Nothing has been shared with you yet. You can still ask about Public content.
            </div>
        );
    }

    return (
        <div className="space-y-2" data-testid="shared-with-me">
            <div className="px-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
                <Inbox className="w-3 h-3" /> Shared with me
            </div>
            {items.map(item => (
                <div key={item.grantId} className="rounded-2xl bg-white border border-slate-200 shadow-sm">
                    <button onClick={() => setOpen(open === item.grantId ? null : item.grantId)}
                        className="w-full flex items-start gap-2 p-3 text-left">
                        {open === item.grantId ? <ChevronDown className="w-3.5 h-3.5 mt-0.5 text-slate-400 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 mt-0.5 text-slate-400 shrink-0" />}
                        <span className="flex flex-col min-w-0">
                            <span className="text-xs font-bold text-slate-900 truncate" title={item.title}>{item.title}</span>
                            <span className="text-[10px] text-slate-500">
                                {item.type} · {item.sharedBy}{item.via.group ? ` (to ${item.via.group})` : ''} · {fmtDate(item.sharedAt)}
                                {item.expiresAt ? ` · until ${fmtDate(item.expiresAt)}` : ''}
                            </span>
                        </span>
                    </button>
                    {open === item.grantId && (
                        <div className="px-3 pb-3 space-y-1.5">
                            <button onClick={() => onOpen(item)} disabled={disabled}
                                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl text-[11px] font-bold text-indigo-600 hover:bg-indigo-50 disabled:opacity-40">
                                <Network className="w-3.5 h-3.5" /> Open in graph
                            </button>
                            {item.questions.map(q => (
                                <button key={q} onClick={() => onAsk(q)} disabled={disabled}
                                    className="w-full flex items-start gap-2 px-2.5 py-1.5 rounded-xl text-[11px] text-left text-slate-700 hover:bg-slate-50 disabled:opacity-40">
                                    <MessageSquare className="w-3.5 h-3.5 mt-0.5 text-slate-400 shrink-0" /> {q}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}
