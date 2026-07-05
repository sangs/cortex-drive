"use client";

import React, { useState, useCallback, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, UserPlus, Building2, Check, Loader2, Share2 } from 'lucide-react';
import { useAuth } from '@clerk/nextjs';

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:4000';

type GraphTab = 'user' | 'group';

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
    }, [tab]);

    if (!open) return null;

    async function resolveEmail() {
        if (!email) return;
        setResolving(true); setResolvedUser(null); setResolveError('');
        try {
            const headers = await authHeaders();
            const resp = await fetch(`${GATEWAY}/api/user/resolve?email=${encodeURIComponent(email)}`, { headers });
            if (resp.ok) setResolvedUser(await resp.json());
            else { const err = await resp.json(); setResolveError(err.error || 'User not found'); }
        } catch { setResolveError('Could not reach server'); } finally { setResolving(false); }
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

    const tabs = [
        { id: 'user'  as GraphTab, label: 'Share with Person', icon: <UserPlus className="w-3.5 h-3.5" /> },
        { id: 'group' as GraphTab, label: 'Share with Group',  icon: <Building2 className="w-3.5 h-3.5" /> },
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
                            {resolveError && <p className="text-xs text-red-400">{resolveError}</p>}

                            <div className="flex items-center gap-2">
                                <span className="text-xs text-slate-400">Expires:</span>
                                <select value={userExpiry} onChange={e => setUserExpiry(Number(e.target.value))}
                                    className="bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-slate-300 outline-none cursor-pointer">
                                    {EXPIRY_OPTIONS.map(o => <option key={o.days} value={o.days} className="bg-[#0f1117]">{o.label}</option>)}
                                </select>
                            </div>

                            {userSuccess && (
                                <p className="text-xs text-emerald-400 font-medium flex items-center gap-1.5">
                                    <Check className="w-3.5 h-3.5" />{userSuccess}
                                </p>
                            )}

                            <button onClick={shareWithUser} disabled={!resolvedUser || userSharing || nodeIds.length === 0}
                                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold transition-all disabled:opacity-40">
                                {userSharing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
                                Share Graph
                            </button>
                            <p className="text-[10px] text-slate-500">Recipients must sign in to Cortex-Drive to access the shared graph.</p>
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
                </motion.div>
            </motion.div>
        </AnimatePresence>,
        document.body
    );
}
