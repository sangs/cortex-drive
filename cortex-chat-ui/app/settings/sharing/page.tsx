"use client";

import { useState, useEffect, useCallback } from 'react';
import { useAuth, useUser } from '@clerk/nextjs';
import Link from 'next/link';
import {
    ArrowLeft, Link2, Copy, Check, Trash2, Eye,
    Calendar, ExternalLink, AlertCircle, Loader2, RefreshCw
} from 'lucide-react';

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:4000';

interface GraphLink {
    link_id: string;
    title: string | null;
    node_count: number;
    shareUrl: string;
    share_token: string;
    created_at: string;
    expires_at: string | null;
    revoked_at: string | null;
    view_count: number;
    last_viewed_at: string | null;
    status: 'active' | 'expired' | 'revoked';
}

const STATUS_STYLES: Record<string, string> = {
    active:  'bg-emerald-50 text-emerald-700 border-emerald-200',
    expired: 'bg-amber-50  text-amber-700  border-amber-200',
    revoked: 'bg-red-50    text-red-700    border-red-200',
};

function fmt(iso: string) {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function ExpiryLabel({ link }: { link: GraphLink }) {
    if (link.status === 'revoked') return <span className="text-xs text-slate-400">Revoked {fmt(link.revoked_at!)}</span>;
    if (!link.expires_at) return <span className="text-xs text-slate-400">Never expires</span>;
    const diff = Math.ceil((new Date(link.expires_at).getTime() - Date.now()) / 86400000);
    if (diff <= 0) return <span className="text-xs text-amber-600">Expired {fmt(link.expires_at)}</span>;
    if (diff === 1) return <span className="text-xs text-amber-600 font-medium">Expires tomorrow</span>;
    if (diff <= 7) return <span className="text-xs text-amber-600">Expires in {diff} days</span>;
    return <span className="text-xs text-slate-400">Expires {fmt(link.expires_at)}</span>;
}

export default function SharingSettingsPage() {
    const { getToken } = useAuth();
    const { user } = useUser();

    const [links, setLinks] = useState<GraphLink[]>([]);
    const [loading, setLoading] = useState(true);
    const [copiedId, setCopiedId]     = useState<string | null>(null);
    const [revokingId, setRevokingId] = useState<string | null>(null);
    const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

    const authHeaders = useCallback(async () => {
        const token = await getToken();
        return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    }, [getToken]);

    const loadLinks = useCallback(async () => {
        setLoading(true);
        try {
            const headers = await authHeaders();
            const resp = await fetch(`${GATEWAY}/api/share/graph-links`, { headers });
            if (resp.ok) setLinks(await resp.json());
        } catch { /* non-fatal */ } finally { setLoading(false); }
    }, [authHeaders]);

    useEffect(() => { loadLinks(); }, [loadLinks]);

    async function copyUrl(link: GraphLink) {
        await navigator.clipboard.writeText(link.shareUrl);
        setCopiedId(link.link_id);
        setTimeout(() => setCopiedId(null), 2000);
    }

    async function revokeLink(linkId: string) {
        setRevokingId(linkId);
        try {
            const headers = await authHeaders();
            const resp = await fetch(`${GATEWAY}/api/share/graph-link/${linkId}`, { method: 'DELETE', headers });
            if (resp.ok) {
                setLinks(prev => prev.map(l =>
                    l.link_id === linkId
                        ? { ...l, status: 'revoked' as const, revoked_at: new Date().toISOString() }
                        : l
                ));
            }
        } catch { /* non-fatal */ } finally {
            setRevokingId(null);
            setConfirmRevoke(null);
        }
    }

    const activeLinks  = links.filter(l => l.status === 'active');
    const inactiveLinks = links.filter(l => l.status !== 'active');

    return (
        <div className="min-h-screen bg-slate-50">
            {/* Header */}
            <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
                <div className="max-w-5xl mx-auto px-6 h-16 flex items-center gap-4">
                    <Link href="/dashboard"
                        className="flex items-center gap-1.5 text-slate-400 hover:text-slate-700 transition-colors text-sm">
                        <ArrowLeft className="w-4 h-4" />
                        Dashboard
                    </Link>
                    <span className="text-slate-200">/</span>
                    <span className="text-sm font-bold text-slate-700">Sharing & Access</span>
                    <div className="ml-auto flex items-center gap-2">
                        <button onClick={loadLinks}
                            className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors">
                            <RefreshCw className="w-4 h-4" />
                        </button>
                        <Link href="/dashboard"
                            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold transition-all">
                            <ExternalLink className="w-3.5 h-3.5" />
                            Open Dashboard
                        </Link>
                    </div>
                </div>
            </header>

            <div className="max-w-5xl mx-auto px-6 py-10 space-y-8">
                {/* Page title */}
                <div>
                    <h1 className="text-2xl font-black text-slate-900">Sharing & Access</h1>
                    <p className="text-sm text-slate-500 mt-1">
                        Manage public graph links and access grants. Active links can be copied or revoked at any time.
                    </p>
                </div>

                {/* Tab strip — Public Links active; others coming */}
                <div className="flex gap-1 p-1 bg-slate-100 rounded-2xl w-fit">
                    <button className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white shadow-sm text-sm font-bold text-slate-900">
                        <Link2 className="w-3.5 h-3.5 text-indigo-600" />
                        Public Links
                        {links.length > 0 && (
                            <span className="ml-1 px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-[10px] font-black">
                                {links.length}
                            </span>
                        )}
                    </button>
                    <button disabled className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold text-slate-400 cursor-not-allowed"
                        title="Coming next">
                        Named Shares
                    </button>
                    <button disabled className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold text-slate-400 cursor-not-allowed"
                        title="Coming next">
                        Pending Invites
                    </button>
                </div>

                {/* Public Links panel */}
                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="w-6 h-6 text-slate-300 animate-spin" />
                    </div>
                ) : links.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
                        <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center">
                            <Link2 className="w-6 h-6 text-slate-300" />
                        </div>
                        <div>
                            <p className="text-sm font-bold text-slate-700">No public links yet</p>
                            <p className="text-xs text-slate-400 mt-1">
                                Run a query in the dashboard, then click "Share Graph" → "Public Link" to generate one.
                            </p>
                        </div>
                        <Link href="/dashboard"
                            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold transition-all">
                            Go to Dashboard →
                        </Link>
                    </div>
                ) : (
                    <div className="space-y-6">
                        {/* Active links */}
                        {activeLinks.length > 0 && (
                            <section className="space-y-3">
                                <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500 px-1">
                                    Active — {activeLinks.length}
                                </h2>
                                {activeLinks.map(link => (
                                    <LinkCard
                                        key={link.link_id}
                                        link={link}
                                        copiedId={copiedId}
                                        revokingId={revokingId}
                                        confirmRevoke={confirmRevoke}
                                        onCopy={copyUrl}
                                        onConfirmRevoke={setConfirmRevoke}
                                        onRevoke={revokeLink}
                                    />
                                ))}
                            </section>
                        )}

                        {/* Inactive (expired / revoked) */}
                        {inactiveLinks.length > 0 && (
                            <section className="space-y-3">
                                <h2 className="text-xs font-bold uppercase tracking-widest text-slate-400 px-1">
                                    Expired / Revoked — {inactiveLinks.length}
                                </h2>
                                {inactiveLinks.map(link => (
                                    <LinkCard
                                        key={link.link_id}
                                        link={link}
                                        copiedId={copiedId}
                                        revokingId={revokingId}
                                        confirmRevoke={confirmRevoke}
                                        onCopy={copyUrl}
                                        onConfirmRevoke={setConfirmRevoke}
                                        onRevoke={revokeLink}
                                        dimmed
                                    />
                                ))}
                            </section>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

// ── Link card component ────────────────────────────────────────────────────────

interface LinkCardProps {
    link: GraphLink;
    copiedId: string | null;
    revokingId: string | null;
    confirmRevoke: string | null;
    onCopy: (l: GraphLink) => void;
    onConfirmRevoke: (id: string | null) => void;
    onRevoke: (id: string) => void;
    dimmed?: boolean;
}

function LinkCard({ link, copiedId, revokingId, confirmRevoke, onCopy, onConfirmRevoke, onRevoke, dimmed }: LinkCardProps) {
    const isCopied   = copiedId === link.link_id;
    const isRevoking = revokingId === link.link_id;
    const isConfirming = confirmRevoke === link.link_id;

    return (
        <div className={`bg-white border rounded-2xl p-5 transition-all ${dimmed ? 'border-slate-100 opacity-60' : 'border-slate-200 shadow-sm'}`}>
            <div className="flex items-start gap-4">
                {/* Icon */}
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${dimmed ? 'bg-slate-100' : 'bg-indigo-50'}`}>
                    <Link2 className={`w-5 h-5 ${dimmed ? 'text-slate-300' : 'text-indigo-600'}`} />
                </div>

                {/* Main content */}
                <div className="flex-1 min-w-0 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-black text-slate-900 truncate">
                            {link.title || 'Untitled graph link'}
                        </span>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${STATUS_STYLES[link.status]}`}>
                            {link.status}
                        </span>
                    </div>

                    {/* URL */}
                    <p className="text-xs text-slate-400 font-mono truncate">{link.shareUrl}</p>

                    {/* Metadata row */}
                    <div className="flex items-center gap-4 flex-wrap">
                        <span className="flex items-center gap-1 text-xs text-slate-500">
                            <Eye className="w-3 h-3" />
                            {link.view_count} view{link.view_count !== 1 ? 's' : ''}
                        </span>
                        <span className="flex items-center gap-1 text-xs text-slate-500">
                            <Calendar className="w-3 h-3" />
                            Created {fmt(link.created_at)}
                        </span>
                        <span className="text-xs text-slate-400">
                            {link.node_count} node{link.node_count !== 1 ? 's' : ''}
                        </span>
                        <ExpiryLabel link={link} />
                    </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0">
                    {/* Copy */}
                    <button
                        onClick={() => onCopy(link)}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-50 hover:bg-indigo-50 border border-slate-200 hover:border-indigo-200 text-xs font-bold text-slate-600 hover:text-indigo-600 transition-all"
                        title="Copy link">
                        {isCopied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                        {isCopied ? 'Copied' : 'Copy'}
                    </button>

                    {/* Open in new tab (active only) */}
                    {link.status === 'active' && (
                        <a href={link.shareUrl} target="_blank" rel="noopener noreferrer"
                            className="p-2 rounded-xl bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-400 hover:text-slate-700 transition-all"
                            title="Open link">
                            <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                    )}

                    {/* Revoke (active only) */}
                    {link.status === 'active' && (
                        isConfirming ? (
                            <div className="flex items-center gap-1.5">
                                <button onClick={() => onRevoke(link.link_id)} disabled={isRevoking}
                                    className="flex items-center gap-1 px-3 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition-all disabled:opacity-40">
                                    {isRevoking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                                    Confirm
                                </button>
                                <button onClick={() => onConfirmRevoke(null)}
                                    className="px-2 py-2 rounded-xl text-xs text-slate-400 hover:text-slate-700 transition-colors">
                                    Cancel
                                </button>
                            </div>
                        ) : (
                            <button onClick={() => onConfirmRevoke(link.link_id)}
                                className="p-2 rounded-xl bg-slate-50 hover:bg-red-50 border border-slate-200 hover:border-red-200 text-slate-400 hover:text-red-600 transition-all"
                                title="Revoke link">
                                <Trash2 className="w-3.5 h-3.5" />
                            </button>
                        )
                    )}
                </div>
            </div>
        </div>
    );
}
