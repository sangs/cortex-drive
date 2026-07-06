"use client";

import React, { useState, useCallback, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, UserPlus, Building2, Check, Loader2, Share2, Link2, Copy } from 'lucide-react';
import { useAuth } from '@clerk/nextjs';

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:4000';

type GraphTab = 'user' | 'group' | 'link';

const EXPIRY_OPTIONS = [
    { label: 'No expiry', days: 0 },
    { label: '24 hours', days: 1 },
    { label: '7 days', days: 7 },
    { label: '30 days', days: 30 },
];

interface GraphShareModalProps {
    graphData: { nodes: any[]; links: any[] };
    open: boolean;
    onClose: () => void;
}

export default function GraphShareModal({ graphData, open, onClose }: GraphShareModalProps) {
    const { getToken } = useAuth();
    const [tab, setTab] = useState<GraphTab>('user');

    // --- User tab state ---
    const [email, setEmail] = useState('');
    const [resolvedUser, setResolvedUser] = useState<{ sub: string; name: string } | null>(null);
    const [resolveError, setResolveError] = useState('');
    const [resolving, setResolving] = useState(false);
    const [userExpiry, setUserExpiry] = useState(0);
    const [userSharing, setUserSharing] = useState(false);
    const [userSuccess, setUserSuccess] = useState('');

    // --- Group tab state ---
    const [groups, setGroups] = useState<{ group_id: string; name: string; member_count: number }[]>([]);
    const [groupsLoading, setGroupsLoading] = useState(false);
    const [selectedGroupId, setSelectedGroupId] = useState('');
    const [selectedGroupCount, setSelectedGroupCount] = useState(0);
    const [groupExpiry, setGroupExpiry] = useState(0);
    const [groupSharing, setGroupSharing] = useState(false);
    const [groupSuccess, setGroupSuccess] = useState('');

    // --- Public Link tab state ---
    const [linkTitle, setLinkTitle] = useState('');
    const [linkExpiry, setLinkExpiry] = useState(0);
    const [linkGenerating, setLinkGenerating] = useState(false);
    const [generatedUrl, setGeneratedUrl] = useState('');
    const [linkCopied, setLinkCopied] = useState(false);
    const [linkError, setLinkError] = useState('');

    const nodeIds = graphData.nodes
        .map(n => n.node_id || n.id)
        .filter(Boolean) as string[];

    const authHeaders = useCallback(async () => {
        const token = await getToken();
        return {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        };
    }, [getToken]);

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
        if (!open) return;
        if (tab === 'group') loadGroups();
    }, [open, tab, loadGroups]);

    useEffect(() => {
        setEmail(''); setResolvedUser(null); setResolveError('');
        setUserSuccess(''); setGroupSuccess('');
        setGeneratedUrl(''); setLinkCopied(false); setLinkError('');
    }, [tab]);

    if (!open) return null;

    async function resolveEmail() {
        if (!email) return;
        setResolving(true); setResolvedUser(null); setResolveError('');
        try {
            const headers = await authHeaders();
            const resp = await fetch(`${GATEWAY}/api/user/resolve?email=${encodeURIComponent(email)}`, { headers });
            if (resp.ok) setResolvedUser(await resp.json());
            else setResolveError('not_found'); // sentinel — triggers invite UI below
        } catch { setResolveError('error'); } finally { setResolving(false); }
    }

    async function shareWithUser() {
        if (!resolvedUser || nodeIds.length === 0) return;
        setUserSharing(true);
        try {
            const headers = await authHeaders();
            const body: any = { nodeIds, targetSub: resolvedUser.sub };
            if (userExpiry > 0) body.expiresAt = new Date(Date.now() + userExpiry * 86400000).toISOString();
            const resp = await fetch(`${GATEWAY}/api/share/graph-island`, { method: 'POST', headers, body: JSON.stringify(body) });
            const data = await resp.json();
            setUserSuccess(`Graph shared with ${resolvedUser.name}. ${data.totalNodes} nodes shared.`);
            setEmail(''); setResolvedUser(null);
        } catch { /* non-fatal */ } finally { setUserSharing(false); }
    }

    async function sendInvite() {
        if (!email || nodeIds.length === 0) return;
        setUserSharing(true);
        try {
            const headers = await authHeaders();
            const body: any = { nodeIds, pendingEmail: email };
            if (userExpiry > 0) body.expiresAt = new Date(Date.now() + userExpiry * 86400000).toISOString();
            await fetch(`${GATEWAY}/api/share/graph-island`, { method: 'POST', headers, body: JSON.stringify(body) });
            setUserSuccess(`Invite sent to ${email}. They'll get access when they sign up.`);
            setEmail(''); setResolveError('');
        } catch { /* non-fatal */ } finally { setUserSharing(false); }
    }

    async function shareWithGroup() {
        if (!selectedGroupId || nodeIds.length === 0) return;
        setGroupSharing(true);
        try {
            const headers = await authHeaders();
            const body: any = { nodeIds, groupId: selectedGroupId };
            if (groupExpiry > 0) body.expiresAt = new Date(Date.now() + groupExpiry * 86400000).toISOString();
            await fetch(`${GATEWAY}/api/share/graph-island`, { method: 'POST', headers, body: JSON.stringify(body) });
            const g = groups.find(g => g.group_id === selectedGroupId);
            setGroupSuccess(`Graph shared with group "${g?.name}". ${nodeIds.length} nodes shared.`);
        } catch { /* non-fatal */ } finally { setGroupSharing(false); }
    }

    async function generateLink() {
        if (nodeIds.length === 0) return;
        setLinkGenerating(true);
        setLinkError('');
        try {
            const headers = await authHeaders();
            // Strip ECharts metadata — keep only display fields to minimise payload
            const cleanNodes = graphData.nodes.map((n: any) => ({
                id: n.id || n.node_id,
                node_id: n.node_id || n.id,
                name: n.name,
                type: n.type,
                description: n.description,
                links: n.links,
                link_titles: n.link_titles,
            }));
            const cleanLinks = graphData.links.map((l: any) => ({
                source: typeof l.source === 'object' ? (l.source?.id || l.source?.node_id) : l.source,
                target: typeof l.target === 'object' ? (l.target?.id || l.target?.node_id) : l.target,
                type: l.type,
            }));
            const body: any = { nodeIds, graphData: { nodes: cleanNodes, links: cleanLinks }, title: linkTitle || undefined };
            if (linkExpiry > 0) body.expiresAt = new Date(Date.now() + linkExpiry * 86400000).toISOString();
            const resp = await fetch(`${GATEWAY}/api/share/graph-link`, { method: 'POST', headers, body: JSON.stringify(body) });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                setLinkError(err.error || `Server error (${resp.status})`);
                return;
            }
            const data = await resp.json();
            if (data.shareUrl) setGeneratedUrl(data.shareUrl);
            else setLinkError('No URL returned — try again.');
        } catch (e: any) {
            setLinkError(e?.message || 'Network error — try again.');
        } finally { setLinkGenerating(false); }
    }

    async function copyLink() {
        if (!generatedUrl) return;
        await navigator.clipboard.writeText(generatedUrl);
        setLinkCopied(true);
        setTimeout(() => setLinkCopied(false), 2000);
    }

    const tabs = [
        { id: 'user'  as GraphTab, label: 'Person',      icon: <UserPlus className="w-3.5 h-3.5" /> },
        { id: 'group' as GraphTab, label: 'Group',        icon: <Building2 className="w-3.5 h-3.5" /> },
        { id: 'link'  as GraphTab, label: 'Public Link',  icon: <Link2 className="w-3.5 h-3.5" /> },
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
                            <p className="text-[10px] font-bold uppercase tracking-widest text-indigo-400 mb-0.5">Share Graph</p>
                            <div className="flex items-center gap-2">
                                <Share2 className="w-4 h-4 text-slate-400" />
                                <span className="text-base font-bold text-white">{nodeIds.length} node{nodeIds.length !== 1 ? 's' : ''}</span>
                            </div>
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
                                    tab === t.id ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:text-white'
                                }`}
                            >
                                {t.icon}
                                <span className="hidden sm:inline">{t.label}</span>
                            </button>
                        ))}
                    </div>

                    {/* ── USER TAB ── */}
                    {tab === 'user' && (
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
                            {resolvedUser && <p className="text-xs text-emerald-400 font-medium">→ {resolvedUser.name}</p>}
                            {resolveError === 'error' && <p className="text-xs text-red-400">Could not reach server — try again.</p>}

                            {/* No account found — offer invite instead of failing */}
                            {resolveError === 'not_found' && (
                                <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 space-y-2">
                                    <p className="text-[11px] font-bold text-amber-400">No Cortex-Drive account found</p>
                                    <p className="text-[10px] text-slate-400 leading-snug">Send an invite? They'll get access automatically the moment they sign up — no action needed on your end.</p>
                                    <div className="flex items-center gap-2">
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs text-slate-400">Expires:</span>
                                            <select value={userExpiry} onChange={e => setUserExpiry(Number(e.target.value))}
                                                className="bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-slate-300 outline-none cursor-pointer">
                                                {EXPIRY_OPTIONS.map(o => <option key={o.days} value={o.days} className="bg-[#0f1117]">{o.label}</option>)}
                                            </select>
                                        </div>
                                        <button onClick={sendInvite} disabled={userSharing}
                                            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold transition-all disabled:opacity-40">
                                            {userSharing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
                                            Send Invite
                                        </button>
                                    </div>
                                </div>
                            )}

                            {!resolveError && (
                                <div className="flex items-center gap-2">
                                    <span className="text-xs text-slate-400">Expires:</span>
                                    <select value={userExpiry} onChange={e => setUserExpiry(Number(e.target.value))}
                                        className="bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-slate-300 outline-none cursor-pointer">
                                        {EXPIRY_OPTIONS.map(o => <option key={o.days} value={o.days} className="bg-[#0f1117]">{o.label}</option>)}
                                    </select>
                                </div>
                            )}

                            {userSuccess && (
                                <p className="text-xs text-emerald-400 font-medium flex items-center gap-1.5">
                                    <Check className="w-3.5 h-3.5" />{userSuccess}
                                </p>
                            )}

                            {!resolveError && (
                                <>
                                    <button onClick={shareWithUser} disabled={!resolvedUser || userSharing || nodeIds.length === 0}
                                        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold transition-all disabled:opacity-40">
                                        {userSharing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
                                        Share Graph
                                    </button>
                                    <p className="text-[10px] text-slate-500">Recipients must sign in to Cortex-Drive to access the shared graph.</p>
                                </>
                            )}
                        </div>
                    )}

                    {/* ── GROUP TAB ── */}
                    {tab === 'group' && (
                        <div className="space-y-4">
                            {groupsLoading ? (
                                <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 text-slate-500 animate-spin" /></div>
                            ) : groups.length === 0 ? (
                                <p className="text-xs text-slate-500 text-center py-4">No groups yet. Create one at Settings → Groups.</p>
                            ) : (
                                <>
                                    <select value={selectedGroupId}
                                        onChange={e => {
                                            setSelectedGroupId(e.target.value);
                                            const g = groups.find(g => g.group_id === e.target.value);
                                            setSelectedGroupCount(g?.member_count ?? 0);
                                        }}
                                        className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-indigo-500/50 cursor-pointer">
                                        {groups.map(g => (
                                            <option key={g.group_id} value={g.group_id} className="bg-[#0f1117]">
                                                {g.name} ({g.member_count} member{g.member_count !== 1 ? 's' : ''})
                                            </option>
                                        ))}
                                    </select>

                                    {selectedGroupId && (
                                        <p className="text-[11px] text-indigo-400">
                                            Access will be granted to all {selectedGroupCount} member{selectedGroupCount !== 1 ? 's' : ''} of this group.
                                        </p>
                                    )}

                                    <div className="flex items-center gap-2">
                                        <span className="text-xs text-slate-400">Expires:</span>
                                        <select value={groupExpiry} onChange={e => setGroupExpiry(Number(e.target.value))}
                                            className="bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-slate-300 outline-none cursor-pointer">
                                            {EXPIRY_OPTIONS.map(o => <option key={o.days} value={o.days} className="bg-[#0f1117]">{o.label}</option>)}
                                        </select>
                                    </div>

                                    {groupSuccess && (
                                        <p className="text-xs text-emerald-400 font-medium flex items-center gap-1.5">
                                            <Check className="w-3.5 h-3.5" />{groupSuccess}
                                        </p>
                                    )}

                                    <button onClick={shareWithGroup} disabled={!selectedGroupId || groupSharing || nodeIds.length === 0}
                                        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold transition-all disabled:opacity-40">
                                        {groupSharing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Building2 className="w-4 h-4" />}
                                        Share Graph with Group
                                    </button>
                                    <p className="text-[10px] text-slate-500">Recipients must sign in to Cortex-Drive to access the shared graph.</p>
                                </>
                            )}
                        </div>
                    )}

                    {/* ── PUBLIC LINK TAB ── */}
                    {tab === 'link' && (
                        <div className="space-y-4">
                            <div>
                                <input
                                    type="text"
                                    value={linkTitle}
                                    onChange={e => setLinkTitle(e.target.value)}
                                    placeholder="Link title (optional)"
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500/50 transition-all"
                                />
                                <p className="text-[10px] text-slate-500 mt-1.5">e.g. "Career Graph — Q3 2026 Application"</p>
                            </div>

                            <div className="flex items-center gap-2">
                                <span className="text-xs text-slate-400">Expires:</span>
                                <select value={linkExpiry} onChange={e => setLinkExpiry(Number(e.target.value))}
                                    className="bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-slate-300 outline-none cursor-pointer">
                                    {EXPIRY_OPTIONS.map(o => <option key={o.days} value={o.days} className="bg-[#0f1117]">{o.label}</option>)}
                                </select>
                            </div>

                            {linkError && (
                                <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2">{linkError}</p>
                            )}

                            {!generatedUrl ? (
                                <button onClick={generateLink} disabled={linkGenerating || nodeIds.length === 0}
                                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold transition-all disabled:opacity-40">
                                    {linkGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                                    Generate Public Link
                                </button>
                            ) : (
                                <div className="space-y-3">
                                    <div className="flex items-center gap-2 bg-white/5 border border-emerald-500/30 rounded-xl px-3 py-2.5">
                                        <p className="flex-1 text-xs text-emerald-300 truncate font-mono">{generatedUrl}</p>
                                        <button onClick={copyLink}
                                            className="shrink-0 p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-all">
                                            {linkCopied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                                        </button>
                                    </div>
                                    <button onClick={() => { setGeneratedUrl(''); setLinkTitle(''); setLinkExpiry(0); }}
                                        className="w-full text-xs text-slate-500 hover:text-slate-300 transition-colors">
                                        Generate another link
                                    </button>
                                </div>
                            )}

                            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 space-y-1">
                                <p className="text-[11px] font-bold text-amber-400">Anyone with this link can view the graph</p>
                                <p className="text-[10px] text-slate-500">No sign-in required. The graph snapshot is frozen at the time you generate this link. Good for sharing with recruiters or hiring managers.</p>
                            </div>
                        </div>
                    )}
                </motion.div>
            </motion.div>
        </AnimatePresence>,
        document.body
    );
}
