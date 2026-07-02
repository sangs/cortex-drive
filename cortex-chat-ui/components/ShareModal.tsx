"use client";

import React, { useState, useEffect, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Link2, UserPlus, Users, Check, Copy, Trash2, Loader2, ChevronDown } from 'lucide-react';
import { useAuth } from '@clerk/nextjs';

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:4000';

type Tab = 'guest' | 'person' | 'manage';

interface ActiveGrant {
    user: string;
    relation: string;
    condition?: { context?: { expires_at?: string } } | null;
    expired: boolean;
}

interface RevokedEntry {
    subject: string;
    relation: string;
    revokedAt: string;
    revokedBy: string;
}

interface GuestLink {
    tokenHash: string;
    nodeId: string;
    issuedAt: number;
    expiresAt: number;
    expireDays: number;
}

interface ShareModalProps {
    node: any | null;
    open: boolean;
    onClose: () => void;
}

const EXPIRY_OPTIONS = [
    { label: '1 day', days: 1 },
    { label: '7 days', days: 7 },
    { label: '30 days', days: 30 },
    { label: '90 days', days: 90 },
];

const PERSON_EXPIRY_OPTIONS = [
    { label: 'No expiry', days: 0 },
    { label: '24 hours', days: 1 },
    { label: '7 days', days: 7 },
    { label: '30 days', days: 30 },
];

function formatDate(ts: number) {
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatRelation(rel: string) {
    const map: Record<string, string> = {
        shared_viewer: 'Shared',
        tenant_viewer: 'Org Member',
        owner: 'Owner',
    };
    return map[rel] || rel;
}

function relationColor(rel: string) {
    if (rel === 'shared_viewer') return 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20';
    if (rel === 'tenant_viewer') return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
    return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
}

export default function ShareModal({ node, open, onClose }: ShareModalProps) {
    const { getToken } = useAuth();
    const [tab, setTab] = useState<Tab>('guest');

    // --- Guest link state ---
    const [guestLinks, setGuestLinks] = useState<GuestLink[]>([]);
    const [generatedLink, setGeneratedLink] = useState<string | null>(null);
    const [generatedHash, setGeneratedHash] = useState<string | null>(null);
    const [linkExpiry, setLinkExpiry] = useState(30);
    const [linkCopied, setLinkCopied] = useState(false);
    const [generatingLink, setGeneratingLink] = useState(false);

    // --- Share with person state ---
    const [email, setEmail] = useState('');
    const [resolvedUser, setResolvedUser] = useState<{ sub: string; name: string } | null>(null);
    const [resolveError, setResolveError] = useState('');
    const [resolving, setResolving] = useState(false);
    const [personExpiry, setPersonExpiry] = useState(0);
    const [sharing, setSharing] = useState(false);
    const [shareSuccess, setShareSuccess] = useState('');

    // --- Manage access state ---
    const [active, setActive] = useState<ActiveGrant[]>([]);
    const [revoked, setRevoked] = useState<RevokedEntry[]>([]);
    const [tenantWide, setTenantWide] = useState(false);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [revoking, setRevoking] = useState<string | null>(null);

    const nodeId = node?.node_id || node?.id || node?.name;

    const authHeaders = useCallback(async () => {
        const token = await getToken();
        return {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        };
    }, [getToken]);

    // Load guest links when Guest tab is active
    const loadGuestLinks = useCallback(async () => {
        if (!nodeId) return;
        try {
            const headers = await authHeaders();
            const resp = await fetch(`${GATEWAY}/api/share/links/${encodeURIComponent(nodeId)}`, { headers });
            if (resp.ok) setGuestLinks(await resp.json());
        } catch { /* non-fatal */ }
    }, [nodeId, authHeaders]);

    // Load full access history when Manage tab is active
    const loadHistory = useCallback(async () => {
        if (!nodeId) return;
        setHistoryLoading(true);
        try {
            const headers = await authHeaders();
            const resp = await fetch(`${GATEWAY}/api/share/history/${encodeURIComponent(nodeId)}`, { headers });
            if (resp.ok) {
                const data = await resp.json();
                setActive(data.active || []);
                setRevoked(data.revoked || []);
                setTenantWide(data.active?.some((g: ActiveGrant) => g.relation === 'tenant_viewer') ?? false);
            }
        } catch { /* non-fatal */ } finally {
            setHistoryLoading(false);
        }
    }, [nodeId, authHeaders]);

    useEffect(() => {
        if (!open) return;
        if (tab === 'guest') loadGuestLinks();
        if (tab === 'manage') loadHistory();
    }, [open, tab, loadGuestLinks, loadHistory]);

    // Reset per-tab state when switching tabs
    useEffect(() => {
        setGeneratedLink(null);
        setGeneratedHash(null);
        setLinkCopied(false);
        setEmail('');
        setResolvedUser(null);
        setResolveError('');
        setShareSuccess('');
    }, [tab]);

    if (!open || !node) return null;

    // --- Guest link actions ---
    async function generateLink() {
        setGeneratingLink(true);
        try {
            const headers = await authHeaders();
            const resp = await fetch(
                `${GATEWAY}/api/share?nodeId=${encodeURIComponent(nodeId)}&expireDays=${linkExpiry}`,
                { headers }
            );
            const data = await resp.json();
            if (data.shareUrl) {
                setGeneratedLink(data.shareUrl);
                setGeneratedHash(data.tokenHash);
                await loadGuestLinks();
            }
        } catch { /* non-fatal */ } finally {
            setGeneratingLink(false);
        }
    }

    async function copyLink(url: string) {
        await navigator.clipboard.writeText(url);
        setLinkCopied(true);
        setTimeout(() => setLinkCopied(false), 2500);
    }

    async function revokeGuestLink(tokenHash: string) {
        const headers = await authHeaders();
        await fetch(`${GATEWAY}/api/share/revoke-link`, {
            method: 'DELETE',
            headers,
            body: JSON.stringify({ tokenHash, node_id: nodeId }),
        });
        setGeneratedLink(prev => (generatedHash === tokenHash ? null : prev));
        await loadGuestLinks();
    }

    // --- Share with person actions ---
    async function resolveEmail() {
        if (!email) return;
        setResolving(true);
        setResolvedUser(null);
        setResolveError('');
        try {
            const headers = await authHeaders();
            const resp = await fetch(`${GATEWAY}/api/user/resolve?email=${encodeURIComponent(email)}`, { headers });
            if (resp.ok) {
                setResolvedUser(await resp.json());
            } else {
                const err = await resp.json();
                setResolveError(err.error || 'User not found');
            }
        } catch { setResolveError('Could not reach server'); } finally { setResolving(false); }
    }

    async function shareWithPerson() {
        if (!resolvedUser) return;
        setSharing(true);
        try {
            const headers = await authHeaders();
            const body: any = { node_id: nodeId, targetSub: resolvedUser.sub };
            if (personExpiry > 0) {
                body.expiresAt = new Date(Date.now() + personExpiry * 86400000).toISOString();
            }
            await fetch(`${GATEWAY}/api/share/user`, { method: 'POST', headers, body: JSON.stringify(body) });
            setShareSuccess(`Shared with ${resolvedUser.name}`);
            setEmail('');
            setResolvedUser(null);
        } catch { /* non-fatal */ } finally { setSharing(false); }
    }

    // --- Manage access actions ---
    async function revokeAccess(subject: string, relation: string) {
        setRevoking(`${subject}:${relation}`);
        try {
            const headers = await authHeaders();
            await fetch(`${GATEWAY}/api/share/revoke`, {
                method: 'DELETE',
                headers,
                body: JSON.stringify({ node_id: nodeId, subject, relation }),
            });
            await loadHistory();
        } catch { /* non-fatal */ } finally { setRevoking(null); }
    }

    async function toggleTenantWide() {
        const headers = await authHeaders();
        if (!tenantWide) {
            await fetch(`${GATEWAY}/api/share/tenant-wide`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ node_id: nodeId }),
            });
        } else {
            const orgGrant = active.find(g => g.relation === 'tenant_viewer');
            if (orgGrant) await revokeAccess(orgGrant.user, 'tenant_viewer');
        }
        await loadHistory();
    }

    const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
        { id: 'guest', label: 'Guest Link', icon: <Link2 className="w-3.5 h-3.5" /> },
        { id: 'person', label: 'Share with Person', icon: <UserPlus className="w-3.5 h-3.5" /> },
        { id: 'manage', label: 'Manage Access', icon: <Users className="w-3.5 h-3.5" /> },
    ];

    return ReactDOM.createPortal(
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
                onClick={onClose}
            >
                <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: 8 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 8 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                    className="bg-[#0f1117] border border-white/10 rounded-3xl p-6 w-full max-w-md shadow-2xl"
                    onClick={e => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className="flex items-start justify-between mb-5">
                        <div>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-indigo-400 mb-0.5">Share</p>
                            <h3 className="text-base font-bold text-white leading-tight truncate max-w-[280px]">{node.name}</h3>
                        </div>
                        <button onClick={onClose} className="p-1.5 rounded-xl hover:bg-white/5 text-slate-500 hover:text-white transition-all">
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    {/* Tab bar */}
                    <div className="flex gap-1 p-1 bg-white/5 rounded-2xl mb-5">
                        {tabs.map(t => (
                            <button
                                key={t.id}
                                onClick={() => setTab(t.id)}
                                className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-2 rounded-xl text-[11px] font-bold transition-all ${
                                    tab === t.id
                                        ? 'bg-indigo-600 text-white shadow-md'
                                        : 'text-slate-400 hover:text-white'
                                }`}
                            >
                                {t.icon}
                                <span className="hidden sm:inline">{t.label}</span>
                            </button>
                        ))}
                    </div>

                    {/* ── GUEST LINK TAB ── */}
                    {tab === 'guest' && (
                        <div className="space-y-4">
                            <div className="flex items-center gap-2">
                                <div className="flex items-center gap-1.5 flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2">
                                    <ChevronDown className="w-3 h-3 text-slate-500 shrink-0" />
                                    <select
                                        value={linkExpiry}
                                        onChange={e => setLinkExpiry(Number(e.target.value))}
                                        className="bg-transparent text-xs text-slate-300 flex-1 outline-none cursor-pointer"
                                    >
                                        {EXPIRY_OPTIONS.map(o => (
                                            <option key={o.days} value={o.days} className="bg-[#0f1117]">{o.label}</option>
                                        ))}
                                    </select>
                                </div>
                                <button
                                    onClick={generateLink}
                                    disabled={generatingLink}
                                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all disabled:opacity-50 shrink-0"
                                >
                                    {generatingLink ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
                                    Generate
                                </button>
                            </div>

                            {generatedLink && (
                                <div className="flex items-center gap-2 p-3 bg-indigo-500/5 border border-indigo-500/20 rounded-2xl">
                                    <p className="text-[11px] text-slate-300 flex-1 truncate font-mono">{generatedLink}</p>
                                    <button
                                        onClick={() => copyLink(generatedLink)}
                                        className={`shrink-0 p-1.5 rounded-lg transition-all ${linkCopied ? 'text-emerald-400' : 'text-slate-400 hover:text-white'}`}
                                    >
                                        {linkCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                    </button>
                                </div>
                            )}

                            {guestLinks.length > 0 && (
                                <div>
                                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">Active Guest Links</p>
                                    <div className="space-y-2">
                                        {guestLinks.map(link => (
                                            <div key={link.tokenHash} className="flex items-center justify-between p-3 bg-white/3 border border-white/5 rounded-xl">
                                                <div>
                                                    <p className="text-[11px] text-slate-300">Issued {formatDate(link.issuedAt)}</p>
                                                    <p className="text-[10px] text-slate-500">Expires {formatDate(link.expiresAt)}</p>
                                                </div>
                                                <button
                                                    onClick={() => revokeGuestLink(link.tokenHash)}
                                                    className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all"
                                                    title="Revoke this link"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <p className="text-[10px] text-slate-500">Anyone with the link can view this node. No login required.</p>
                        </div>
                    )}

                    {/* ── SHARE WITH PERSON TAB ── */}
                    {tab === 'person' && (
                        <div className="space-y-4">
                            <div className="flex gap-2">
                                <input
                                    type="email"
                                    value={email}
                                    onChange={e => { setEmail(e.target.value); setResolvedUser(null); setResolveError(''); }}
                                    onBlur={resolveEmail}
                                    onKeyDown={e => e.key === 'Enter' && resolveEmail()}
                                    placeholder="Email address"
                                    className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500/50 transition-all"
                                />
                                {resolving && <Loader2 className="w-4 h-4 text-slate-500 animate-spin self-center" />}
                            </div>

                            {resolvedUser && (
                                <p className="text-xs text-emerald-400 font-medium">→ {resolvedUser.name}</p>
                            )}
                            {resolveError && (
                                <p className="text-xs text-red-400">{resolveError}</p>
                            )}

                            <div className="flex items-center gap-2">
                                <span className="text-xs text-slate-400">Expires:</span>
                                <select
                                    value={personExpiry}
                                    onChange={e => setPersonExpiry(Number(e.target.value))}
                                    className="bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-slate-300 outline-none cursor-pointer"
                                >
                                    {PERSON_EXPIRY_OPTIONS.map(o => (
                                        <option key={o.days} value={o.days} className="bg-[#0f1117]">{o.label}</option>
                                    ))}
                                </select>
                            </div>

                            {shareSuccess && (
                                <p className="text-xs text-emerald-400 font-medium flex items-center gap-1.5">
                                    <Check className="w-3.5 h-3.5" />{shareSuccess}
                                </p>
                            )}

                            <button
                                onClick={shareWithPerson}
                                disabled={!resolvedUser || sharing}
                                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold transition-all disabled:opacity-40"
                            >
                                {sharing ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                                Share
                            </button>

                            <p className="text-[10px] text-slate-500">Recipient must have a Cortex-Drive account. Access is controlled via OpenFGA.</p>
                        </div>
                    )}

                    {/* ── MANAGE ACCESS TAB ── */}
                    {tab === 'manage' && (
                        <div className="space-y-4">
                            {/* Tenant-wide toggle */}
                            <div className="flex items-center justify-between p-3 bg-white/3 border border-white/5 rounded-xl">
                                <span className="text-xs text-slate-300 font-medium">Visible to all org members</span>
                                <button
                                    onClick={toggleTenantWide}
                                    className={`w-10 h-5 rounded-full relative transition-colors ${tenantWide ? 'bg-emerald-500' : 'bg-white/10'}`}
                                >
                                    <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all shadow ${tenantWide ? 'left-5' : 'left-0.5'}`} />
                                </button>
                            </div>

                            {historyLoading ? (
                                <div className="flex justify-center py-4">
                                    <Loader2 className="w-5 h-5 text-slate-500 animate-spin" />
                                </div>
                            ) : (
                                <>
                                    {/* Current access */}
                                    {active.filter(g => g.relation !== 'owner').length > 0 && (
                                        <div>
                                            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">Who Has Access</p>
                                            <div className="space-y-2">
                                                {active.filter(g => g.relation !== 'owner').map((g, i) => (
                                                    <div key={i} className="flex items-center justify-between p-3 bg-white/3 border border-white/5 rounded-xl">
                                                        <div className="flex-1 min-w-0">
                                                            <p className="text-[11px] text-slate-300 truncate">{g.user.replace(/^(user|org|group):/, '')}</p>
                                                            <div className="flex items-center gap-2 mt-0.5">
                                                                <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${relationColor(g.relation)}`}>
                                                                    {formatRelation(g.relation)}
                                                                </span>
                                                                {g.condition?.context?.expires_at && (
                                                                    <span className="text-[10px] text-slate-500">
                                                                        exp {new Date(g.condition.context.expires_at).toLocaleDateString()}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </div>
                                                        <button
                                                            onClick={() => revokeAccess(g.user, g.relation)}
                                                            disabled={revoking === `${g.user}:${g.relation}`}
                                                            className="p-1.5 ml-2 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all shrink-0"
                                                        >
                                                            {revoking === `${g.user}:${g.relation}`
                                                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                                : <Trash2 className="w-3.5 h-3.5" />}
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* Revocation history */}
                                    {revoked.length > 0 && (
                                        <div>
                                            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">Access History</p>
                                            <div className="space-y-1.5 max-h-40 overflow-y-auto">
                                                {revoked.map((r, i) => (
                                                    <div key={i} className="flex items-center justify-between p-2.5 bg-white/2 border border-white/5 rounded-xl opacity-60">
                                                        <div>
                                                            <p className="text-[11px] text-slate-400 truncate">{r.subject.replace(/^(user|org|group):/, '')}</p>
                                                            <p className="text-[10px] text-slate-500">
                                                                Revoked {new Date(r.revokedAt).toLocaleDateString()} · {formatRelation(r.relation)}
                                                            </p>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {active.filter(g => g.relation !== 'owner').length === 0 && revoked.length === 0 && (
                                        <p className="text-xs text-slate-500 text-center py-4">Only you can see this node.</p>
                                    )}
                                </>
                            )}
                        </div>
                    )}
                </motion.div>
            </motion.div>
        </AnimatePresence>,
        document.body
    );
}
