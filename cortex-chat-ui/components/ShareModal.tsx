"use client";

import React, { useState, useEffect, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Link2, UserPlus, Users, Building2, Check, Copy, Trash2, Loader2, ChevronDown } from 'lucide-react';
import { useAuth } from '@clerk/nextjs';
import { useCapabilities } from '@/hooks/use-capabilities';

import { GATEWAY_URL as GATEWAY } from '@/lib/gateway';

type Tab = 'link' | 'person' | 'group' | 'manage';

interface ActiveGrant {
    grant_id: string;
    subject: string;
    relation: string;
    expires_at?: string | null;
    issued_at?: string;
    status: string;
}

interface RevokedEntry {
    subject: string;
    relation: string;
    revokedAt: string;
    revokedBy: string;
}

// A live node link (design §7b-1, 2026-11-02): a share_links row with this node as its root. Until
// 2026-11-02 this tab made an HMAC token in Redis (a separate guest page) whose visitor saw nothing on a
// Private node (S2-25); it now uses the same live links as the graph-view Share dialog.
interface NodeLink {
    link_id: string;
    link_type: string;
    shareUrl: string;
    created_at: string;
    expires_at: string | null;
    status: 'active' | 'revoked' | 'expired';
    view_count: number;
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

function formatDate(ts: number | string) {
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
    const caps = useCapabilities();   // S2-69: org-wide toggle for the owner and org admins only
    const [tab, setTab] = useState<Tab>('link');

    // --- Node link state ---
    const [nodeLinks, setNodeLinks] = useState<NodeLink[]>([]);
    const [linkPreview, setLinkPreview] = useState<{ totalNodes: number } | null>(null);
    const [generatedLink, setGeneratedLink] = useState<string | null>(null);
    const [linkExpiry, setLinkExpiry] = useState(30);
    const [linkCopied, setLinkCopied] = useState(false);
    const [generatingLink, setGeneratingLink] = useState(false);
    const [linkError, setLinkError] = useState('');
    const [revokingLink, setRevokingLink] = useState<string | null>(null);

    // --- Share with person state ---
    const [email, setEmail] = useState('');
    const [resolvedUser, setResolvedUser] = useState<{ sub: string; name: string } | null>(null);
    const [resolveError, setResolveError] = useState('');
    const [resolving, setResolving] = useState(false);
    const [personExpiry, setPersonExpiry] = useState(0);
    const [sharing, setSharing] = useState(false);
    const [shareSuccess, setShareSuccess] = useState('');
    const [shareError, setShareError] = useState('');

    // --- Manage access state ---
    const [active, setActive] = useState<ActiveGrant[]>([]);
    const [revoked, setRevoked] = useState<RevokedEntry[]>([]);
    const [tenantWide, setTenantWide] = useState(false);
    // Public / built-in (SYSTEM) nodes are already visible to everyone and cannot be shared (S2-44).
    const [everyoneVisible, setEveryoneVisible] = useState(false);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [revoking, setRevoking] = useState<string | null>(null);

    // --- Share with group state ---
    const [groups, setGroups] = useState<{ group_id: string; name: string; member_count: number }[]>([]);
    const [groupsLoading, setGroupsLoading] = useState(false);
    const [selectedGroupId, setSelectedGroupId] = useState('');
    const [selectedGroupCount, setSelectedGroupCount] = useState(0);
    const [groupExpiry, setGroupExpiry] = useState(0);
    const [groupSharing, setGroupSharing] = useState(false);
    const [groupShareSuccess, setGroupShareSuccess] = useState('');
    const [groupShareError, setGroupShareError] = useState('');

    const nodeId = node?.node_id || node?.id || node?.name;

    const authHeaders = useCallback(async () => {
        const token = await getToken();
        return {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        };
    }, [getToken]);

    // This node's active live links, for the Link tab
    const loadNodeLinks = useCallback(async () => {
        if (!nodeId) return;
        try {
            const headers = await authHeaders();
            const resp = await fetch(`${GATEWAY}/api/share/graph-links?nodeId=${encodeURIComponent(nodeId)}`, { headers });
            if (resp.ok) setNodeLinks(((await resp.json()) as NodeLink[]).filter(l => l.status === 'active'));
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
            }
            // The org-wide toggle lives only in Permify (one tenant_viewer tuple, no share_grants row),
            // so its state is read from the node's Permify access list (S2-40).
            const accessResp = await fetch(`${GATEWAY}/api/share/access/${encodeURIComponent(nodeId)}`, { headers });
            if (accessResp.ok) {
                const tuples: { relation?: string }[] = await accessResp.json();
                setTenantWide(Array.isArray(tuples) && tuples.some(t => t.relation === 'tenant_viewer'));
            }
        } catch { /* non-fatal */ } finally {
            setHistoryLoading(false);
        }
    }, [nodeId, authHeaders]);

    const loadGroups = useCallback(async () => {
        setGroupsLoading(true);
        try {
            const headers = await authHeaders();
            const resp = await fetch(`${GATEWAY}/api/groups`, { headers });
            if (resp.ok) {
                const data = await resp.json();
                setGroups(data);
                if (data.length > 0) {
                    setSelectedGroupId(data[0].group_id);
                    setSelectedGroupCount(data[0].member_count);
                }
            }
        } catch { /* non-fatal */ } finally { setGroupsLoading(false); }
    }, [authHeaders]);

    useEffect(() => {
        if (!open || !nodeId) return;
        let cancelled = false;
        (async () => {
            try {
                const headers = await authHeaders();
                const resp = await fetch(`${GATEWAY}/api/share/access/${encodeURIComponent(nodeId)}`, { headers });
                const body = resp.status === 409 ? await resp.json() : null;
                if (!cancelled) setEveryoneVisible(Boolean(body && body.everyone_visible));
            } catch { if (!cancelled) setEveryoneVisible(false); }
        })();
        return () => { cancelled = true; };
    }, [open, nodeId, authHeaders]);

    useEffect(() => {
        if (!open || everyoneVisible) return;
        if (tab === 'link') loadNodeLinks();
        if (tab === 'group') loadGroups();
        if (tab === 'manage') loadHistory();
    }, [open, tab, everyoneVisible, loadNodeLinks, loadGroups, loadHistory]);

    // Reset per-tab state when switching tabs
    useEffect(() => {
        setGeneratedLink(null);
        setLinkPreview(null);
        setLinkError('');
        setLinkCopied(false);
        setEmail('');
        setResolvedUser(null);
        setResolveError('');
        setShareSuccess('');
        setShareError('');
        setSelectedGroupId('');
        setSelectedGroupCount(0);
        setGroupShareSuccess('');
        setGroupShareError('');
    }, [tab]);

    if (!open || !node) return null;

    // --- Node link actions (live link, one root: this node) ---
    const errorFrom = async (resp: Response, fallback: string) => {
        try { return (await resp.json()).error || fallback; } catch { return fallback; }
    };

    // What the link will include, shown before it is created (design §3).
    async function previewLink() {
        setGeneratingLink(true);
        setLinkError('');
        try {
            const headers = await authHeaders();
            const resp = await fetch(`${GATEWAY}/api/share/graph-link/preview`, {
                method: 'POST', headers, body: JSON.stringify({ nodeIds: [nodeId] }),
            });
            if (resp.ok) setLinkPreview(await resp.json());
            else setLinkError(await errorFrom(resp, 'Could not check what would be shared'));
        } catch { setLinkError('Could not reach server'); } finally {
            setGeneratingLink(false);
        }
    }

    async function generateLink() {
        setGeneratingLink(true);
        setLinkError('');
        try {
            const headers = await authHeaders();
            const body = {
                nodeIds: [nodeId],
                linkType: 'node',
                title: node?.name,
                expiresAt: new Date(Date.now() + linkExpiry * 86400000).toISOString(),
            };
            const resp = await fetch(`${GATEWAY}/api/share/graph-link`, { method: 'POST', headers, body: JSON.stringify(body) });
            if (resp.ok) {
                setGeneratedLink((await resp.json()).shareUrl);
                setLinkPreview(null);
                await loadNodeLinks();
            } else {
                setLinkError(await errorFrom(resp, 'Could not create the link'));
            }
        } catch { setLinkError('Could not reach server'); } finally {
            setGeneratingLink(false);
        }
    }

    async function copyLink(url: string) {
        await navigator.clipboard.writeText(url);
        setLinkCopied(true);
        setTimeout(() => setLinkCopied(false), 2500);
    }

    async function revokeNodeLink(link: NodeLink) {
        setRevokingLink(link.link_id);
        setLinkError('');
        try {
            const headers = await authHeaders();
            const resp = await fetch(`${GATEWAY}/api/share/graph-link/${encodeURIComponent(link.link_id)}`, { method: 'DELETE', headers });
            if (!resp.ok) setLinkError(await errorFrom(resp, 'Could not revoke the link'));
            setGeneratedLink(prev => (prev === link.shareUrl ? null : prev));
            await loadNodeLinks();
        } catch { setLinkError('Could not reach server'); } finally {
            setRevokingLink(null);
        }
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
        setShareSuccess('');
        setShareError('');
        try {
            const headers = await authHeaders();
            const body: any = { rootNodeId: nodeId, targetSub: resolvedUser.sub };
            if (personExpiry > 0) {
                body.expiresAt = new Date(Date.now() + personExpiry * 86400000).toISOString();
            }
            // Check the response: until 2026-11-02 a failed share still showed "Shared with" (S2-77).
            const resp = await fetch(`${GATEWAY}/api/share/user`, { method: 'POST', headers, body: JSON.stringify(body) });
            if (!resp.ok) { setShareError(await errorFrom(resp, 'Could not share')); return; }
            setShareSuccess(`Shared with ${resolvedUser.name}`);
            setEmail('');
            setResolvedUser(null);
        } catch { setShareError('Could not reach server'); } finally { setSharing(false); }
    }

    // --- Share with group actions ---
    async function shareWithGroup() {
        if (!selectedGroupId) return;
        setGroupSharing(true);
        setGroupShareSuccess('');
        setGroupShareError('');
        try {
            const headers = await authHeaders();
            const body: any = { rootNodeId: nodeId, groupId: selectedGroupId };
            if (groupExpiry > 0) {
                body.expiresAt = new Date(Date.now() + groupExpiry * 86400000).toISOString();
            }
            const resp = await fetch(`${GATEWAY}/api/share/group`, { method: 'POST', headers, body: JSON.stringify(body) });
            if (!resp.ok) { setGroupShareError(await errorFrom(resp, 'Could not share with the group')); return; }
            const g = groups.find(g => g.group_id === selectedGroupId);
            setGroupShareSuccess(`Shared with group "${g?.name}"`);
        } catch { setGroupShareError('Could not reach server'); } finally { setGroupSharing(false); }
    }

    // --- Manage access actions ---
    async function revokeAccess(grantId: string) {
        setRevoking(grantId);
        try {
            const headers = await authHeaders();
            await fetch(`${GATEWAY}/api/share/revoke`, {
                method: 'DELETE',
                headers,
                body: JSON.stringify({ grant_id: grantId }),
            });
            await loadHistory();
        } catch { /* non-fatal */ } finally { setRevoking(null); }
    }

    async function toggleTenantWide() {
        const headers = await authHeaders();
        try {
            // POST switches organization-wide visibility on, DELETE switches it off (S2-40).
            const resp = await fetch(`${GATEWAY}/api/share/tenant-wide`, {
                method: tenantWide ? 'DELETE' : 'POST',
                headers,
                body: JSON.stringify({ node_id: nodeId }),
            });
            if (!resp.ok) console.warn('[ShareModal] organization-wide toggle failed:', resp.status);
        } catch { /* state is re-read below */ }
        await loadHistory(); // re-read the real state from Permify either way
    }

    const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
        { id: 'link',   label: 'Link',              icon: <Link2 className="w-3.5 h-3.5" /> },
        { id: 'person', label: 'Share with Person', icon: <UserPlus className="w-3.5 h-3.5" /> },
        { id: 'group',  label: 'Share with Group',  icon: <Building2 className="w-3.5 h-3.5" /> },
        { id: 'manage', label: 'Manage Access',     icon: <Users className="w-3.5 h-3.5" /> },
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

                    {everyoneVisible && (
                        <div className="p-4 bg-white/3 border border-white/5 rounded-xl text-xs text-slate-300 leading-relaxed">
                            <p className="font-medium text-white mb-1">Already visible to everyone</p>
                            <p>This node is Public or built-in, so every organization, invited user and guest link can already see it. There is nothing to share.</p>
                        </div>
                    )}

                    {/* ── LINK TAB (live node link) ── */}
                    {!everyoneVisible && tab === 'link' && (
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
                                    onClick={linkPreview ? generateLink : previewLink}
                                    disabled={generatingLink}
                                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all disabled:opacity-50 shrink-0"
                                >
                                    {generatingLink ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
                                    {linkPreview ? 'Create link' : 'Check what\'s included'}
                                </button>
                            </div>

                            {linkPreview && !generatedLink && (
                                <div className="p-3 bg-white/5 border border-indigo-500/30 rounded-xl text-xs text-slate-200" data-testid="node-link-preview">
                                    {linkPreview.totalNodes > 1
                                        ? `This node and ${linkPreview.totalNodes - 1} item${linkPreview.totalNodes - 1 === 1 ? '' : 's'} it contains.`
                                        : 'This node.'}
                                    <span className="text-slate-500"> Private notes stay hidden.</span>
                                </div>
                            )}

                            {linkError && <p className="text-xs text-red-400">{linkError}</p>}

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

                            {nodeLinks.length > 0 && (
                                <div>
                                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">Active links</p>
                                    <div className="space-y-2">
                                        {nodeLinks.map(link => (
                                            <div key={link.link_id} className="flex items-center justify-between p-3 bg-white/3 border border-white/5 rounded-xl">
                                                <div>
                                                    <p className="text-[11px] text-slate-300">
                                                        Created {formatDate(link.created_at)}{link.link_type === 'graph' ? ' · graph view' : ''}
                                                    </p>
                                                    <p className="text-[10px] text-slate-500">
                                                        {link.expires_at ? `Expires ${formatDate(link.expires_at)}` : 'No expiry'} · {link.view_count} view{link.view_count === 1 ? '' : 's'}
                                                    </p>
                                                </div>
                                                <div className="flex items-center gap-1">
                                                    <button
                                                        onClick={() => copyLink(link.shareUrl)}
                                                        className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/5 transition-all"
                                                        title="Copy this link"
                                                    >
                                                        <Copy className="w-3.5 h-3.5" />
                                                    </button>
                                                    <button
                                                        onClick={() => revokeNodeLink(link)}
                                                        disabled={revokingLink === link.link_id}
                                                        className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-40"
                                                        title="Revoke this link"
                                                    >
                                                        {revokingLink === link.link_id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <p className="text-[10px] text-slate-500">Anyone with the link can view this node and what it contains, live. No sign-in needed. Revoke and it stops working.</p>
                        </div>
                    )}

                    {/* ── SHARE WITH PERSON TAB ── */}
                    {!everyoneVisible && tab === 'person' && (
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

                            {shareError && <p className="text-xs text-red-400">{shareError}</p>}
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

                            <p className="text-[10px] text-slate-500">Recipient must have a Cortex-Drive account. Recipients must sign in to access.</p>
                        </div>
                    )}

                    {/* ── SHARE WITH GROUP TAB ── */}
                    {!everyoneVisible && tab === 'group' && (
                        <div className="space-y-4">
                            {groupsLoading ? (
                                <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 text-slate-500 animate-spin" /></div>
                            ) : groups.length === 0 ? (
                                <p className="text-xs text-slate-500 text-center py-4">No groups yet. Create one at Settings → Groups.</p>
                            ) : (
                                <>
                                    <select
                                        value={selectedGroupId}
                                        onChange={e => {
                                            setSelectedGroupId(e.target.value);
                                            const g = groups.find(g => g.group_id === e.target.value);
                                            setSelectedGroupCount(g?.member_count ?? 0);
                                        }}
                                        className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-indigo-500/50 transition-all cursor-pointer"
                                    >
                                        {groups.map(g => (
                                            <option key={g.group_id} value={g.group_id} className="bg-[#0f1117]">
                                                {g.name} ({g.member_count} member{g.member_count !== 1 ? 's' : ''})
                                            </option>
                                        ))}
                                    </select>

                                    {selectedGroupId && (
                                        <p className="text-[11px] text-indigo-400">
                                            Access will be granted to all {selectedGroupCount} group member{selectedGroupCount !== 1 ? 's' : ''}.
                                        </p>
                                    )}

                                    <div className="flex items-center gap-2">
                                        <span className="text-xs text-slate-400">Expires:</span>
                                        <select
                                            value={groupExpiry}
                                            onChange={e => setGroupExpiry(Number(e.target.value))}
                                            className="bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-slate-300 outline-none cursor-pointer"
                                        >
                                            {PERSON_EXPIRY_OPTIONS.map(o => (
                                                <option key={o.days} value={o.days} className="bg-[#0f1117]">{o.label}</option>
                                            ))}
                                        </select>
                                    </div>

                                    {groupShareError && <p className="text-xs text-red-400">{groupShareError}</p>}
                                    {groupShareSuccess && (
                                        <p className="text-xs text-emerald-400 font-medium flex items-center gap-1.5">
                                            <Check className="w-3.5 h-3.5" />{groupShareSuccess}
                                        </p>
                                    )}

                                    <button
                                        onClick={shareWithGroup}
                                        disabled={!selectedGroupId || groupSharing}
                                        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold transition-all disabled:opacity-40"
                                    >
                                        {groupSharing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Building2 className="w-4 h-4" />}
                                        Share with Group
                                    </button>

                                    <p className="text-[10px] text-slate-500">Recipients must sign in to Cortex-Drive to access the shared node.</p>
                                </>
                            )}
                        </div>
                    )}

                    {/* ── MANAGE ACCESS TAB ── */}
                    {!everyoneVisible && tab === 'manage' && (
                        <div className="space-y-4">
                            {/* Tenant-wide toggle */}
                            {caps.shareOrgWide && (
                            <div className="flex items-center justify-between p-3 bg-white/3 border border-white/5 rounded-xl">
                                <span className="text-xs text-slate-300 font-medium">Visible to all org members</span>
                                <button
                                    onClick={toggleTenantWide}
                                    className={`w-10 h-5 rounded-full relative transition-colors ${tenantWide ? 'bg-emerald-500' : 'bg-white/10'}`}
                                >
                                    <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all shadow ${tenantWide ? 'left-5' : 'left-0.5'}`} />
                                </button>
                            </div>
                            )}

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
                                                    <div key={g.grant_id} className="flex items-center justify-between p-3 bg-white/3 border border-white/5 rounded-xl">
                                                        <div className="flex-1 min-w-0">
                                                            <p className="text-[11px] text-slate-300 truncate">{g.subject?.replace(/^(user|org|group):/, '')}</p>
                                                            <div className="flex items-center gap-2 mt-0.5">
                                                                <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${relationColor(g.relation)}`}>
                                                                    {formatRelation(g.relation)}
                                                                </span>
                                                                {g.expires_at && (
                                                                    <span className="text-[10px] text-slate-500">
                                                                        exp {new Date(g.expires_at).toLocaleDateString()}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </div>
                                                        <button
                                                            onClick={() => revokeAccess(g.grant_id)}
                                                            disabled={revoking === g.grant_id}
                                                            className="p-1.5 ml-2 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all shrink-0"
                                                        >
                                                            {revoking === g.grant_id
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
