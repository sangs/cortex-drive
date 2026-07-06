"use client";

import React, { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ExternalLink, Lock, AlertCircle, Loader2 } from 'lucide-react';

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:4000';

interface NodeData {
    name?: string;
    type?: string;
    description?: string;
    links?: string[];
    link_titles?: string[];
    error?: string;
}

const TYPE_COLORS: Record<string, string> = {
    Project: 'text-violet-400 bg-violet-500/10 border-violet-500/20',
    Company: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
    ThoughtLeadership: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
    Episode: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    Podcast: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    Role: 'text-sky-400 bg-sky-500/10 border-sky-500/20',
    Hackathon: 'text-pink-400 bg-pink-500/10 border-pink-500/20',
};

function typeBadgeClass(type: string) {
    return TYPE_COLORS[type] || 'text-slate-400 bg-slate-500/10 border-slate-500/20';
}

function DiscoveryContent() {
    const params = useSearchParams();
    const token = params.get('share');

    const [node, setNode] = useState<NodeData | null>(null);
    const [status, setStatus] = useState<'loading' | 'ok' | 'revoked' | 'expired' | 'error'>('loading');

    useEffect(() => {
        if (!token) { setStatus('error'); return; }

        fetch(`${GATEWAY}/api/share/preview?share=${encodeURIComponent(token)}`)
            .then(async res => {
                if (res.status === 403) { setStatus('revoked'); return; }
                if (!res.ok) { setStatus('expired'); return; }
                const data = await res.json();
                if (data.error) { setStatus('expired'); return; }
                setNode(data);
                setStatus('ok');
            })
            .catch(() => setStatus('error'));
    }, [token]);

    const links: { url: string; label: string }[] = React.useMemo(() => {
        if (!node?.links) return [];
        return (node.links as string[]).map((url, i) => ({
            url,
            label: (node.link_titles as string[])?.[i] || url,
        })).filter(l => l.url);
    }, [node]);

    return (
        <div className="min-h-screen bg-[#080a0f] text-white flex flex-col">
            {/* Header */}
            <header className="flex items-center justify-between px-6 py-4 border-b border-white/5">
                <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-lg bg-indigo-600 flex items-center justify-center">
                        <Lock className="w-3.5 h-3.5 text-white" />
                    </div>
                    <span className="text-sm font-bold tracking-tight text-white">Cortex-Drive</span>
                </div>
                <a
                    href="/sign-in"
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all"
                >
                    Sign In →
                </a>
            </header>

            {/* Main */}
            <main className="flex-1 flex items-center justify-center p-6">
                {status === 'loading' && (
                    <div className="flex flex-col items-center gap-3 text-slate-500">
                        <Loader2 className="w-8 h-8 animate-spin" />
                        <p className="text-sm">Loading shared view…</p>
                    </div>
                )}

                {(status === 'revoked' || status === 'expired' || status === 'error') && (
                    <div className="flex flex-col items-center gap-4 max-w-sm text-center">
                        <div className="w-12 h-12 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
                            <AlertCircle className="w-6 h-6 text-red-400" />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold text-white mb-1">
                                {status === 'revoked' ? 'Link revoked' : 'Link unavailable'}
                            </h2>
                            <p className="text-sm text-slate-400">
                                {status === 'revoked'
                                    ? 'The owner has revoked access to this shared link.'
                                    : 'This link may have expired or is no longer valid.'}
                            </p>
                        </div>
                        <a href="/" className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
                            Go to Cortex-Drive
                        </a>
                    </div>
                )}

                {status === 'ok' && node && (
                    <div className="w-full max-w-lg space-y-6">
                        {/* Node card */}
                        <div className="bg-[#0f1117] border border-white/10 rounded-3xl p-8 space-y-5">
                            <div className="space-y-2">
                                <span className={`inline-flex items-center px-2.5 py-1 rounded-lg border text-[11px] font-bold uppercase tracking-wider ${typeBadgeClass(node.type || '')}`}>
                                    {node.type || 'Node'}
                                </span>
                                <h1 className="text-2xl font-bold text-white leading-tight">{node.name}</h1>
                            </div>

                            {node.description && (
                                <p className="text-sm text-slate-300 leading-relaxed">{node.description}</p>
                            )}

                            {links.length > 0 && (
                                <div className="space-y-2">
                                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Resources</p>
                                    {links.map((l, i) => (
                                        <a
                                            key={i}
                                            href={l.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 hover:border-sky-500/30 transition-all group"
                                        >
                                            <span className="text-xs text-slate-300 group-hover:text-white truncate pr-4">{l.label}</span>
                                            <ExternalLink className="w-3 h-3 text-slate-500 group-hover:text-sky-400 shrink-0" />
                                        </a>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Footer CTA */}
                        <div className="bg-white/3 border border-white/5 rounded-2xl p-5 flex items-center justify-between gap-4">
                            <div>
                                <p className="text-xs text-slate-300 font-medium">Shared read-only view</p>
                                <p className="text-[11px] text-slate-500 mt-0.5">Sign in to explore the full knowledge graph</p>
                            </div>
                            <a
                                href="/sign-in"
                                className="shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all whitespace-nowrap"
                            >
                                Open in Cortex-Drive →
                            </a>
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
}

export default function DiscoveryPage() {
    return (
        <Suspense>
            <DiscoveryContent />
        </Suspense>
    );
}
