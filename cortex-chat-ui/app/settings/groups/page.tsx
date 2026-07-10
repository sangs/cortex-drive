"use client";

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import {
    ArrowLeft, Plus, Users, UserPlus, UserMinus, Loader2,
    X, ChevronRight, Calendar, ExternalLink, Clock, Send, Trash2,
} from 'lucide-react';

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:4000';

// ── Types ──────────────────────────────────────────────────────────────────────

interface Group {
    group_id: string;
    name: string;
    slug: string;
    description: string | null;
    created_at: string;
    member_count: number;
}

interface GroupMember {
    user_sub: string;
    user_org_id: string | null;
    added_by: string;
    added_at: string;
    display_name: string | null;
    email: string | null;
}

interface GroupInvitation {
    invitation_id: string;
    pending_email: string;
    invited_by: string;
    invited_at: string;
    status: 'pending';
}

interface GroupDetail extends Group {
    members: GroupMember[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(iso: string) {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function toSlug(name: string) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function memberLabel(m: GroupMember) {
    if (m.display_name && m.email) return `${m.display_name} (${m.email})`;
    if (m.display_name) return m.display_name;
    if (m.email) return m.email;
    return m.user_sub;
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function GroupsPage() {
    const { getToken } = useAuth();

    const [groups, setGroups]               = useState<Group[]>([]);
    const [selected, setSelected]           = useState<GroupDetail | null>(null);
    const [invitations, setInvitations]     = useState<GroupInvitation[]>([]);
    const [loading, setLoading]             = useState(true);
    const [detailLoading, setDetailLoading] = useState(false);

    // Create group modal
    const [showCreate, setShowCreate]   = useState(false);
    const [newName, setNewName]         = useState('');
    const [newSlug, setNewSlug]         = useState('');
    const [newDesc, setNewDesc]         = useState('');
    const [slugManual, setSlugManual]   = useState(false);
    const [creating, setCreating]       = useState(false);
    const [createError, setCreateError] = useState('');

    // Add / invite member
    const [addEmail, setAddEmail]           = useState('');
    const [addingMember, setAddingMember]   = useState(false);
    const [addError, setAddError]           = useState('');
    const [addSuccess, setAddSuccess]       = useState('');

    // Remove member / invitation actions
    const [removingSub, setRemovingSub]         = useState<string | null>(null);
    const [resendingInvId, setResendingInvId]   = useState<string | null>(null);
    const [cancellingInvId, setCancellingInvId] = useState<string | null>(null);

    const authHeaders = useCallback(async () => {
        const token = await getToken();
        return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    }, [getToken]);

    const loadGroups = useCallback(async () => {
        setLoading(true);
        try {
            const headers = await authHeaders();
            const resp = await fetch(`${GATEWAY}/api/groups`, { headers });
            if (resp.ok) setGroups(await resp.json());
        } catch { /* non-fatal */ } finally { setLoading(false); }
    }, [authHeaders]);

    useEffect(() => { loadGroups(); }, [loadGroups]);

    async function openGroup(group: Group) {
        setSelected(null);
        setInvitations([]);
        setDetailLoading(true);
        setAddEmail('');
        setAddError('');
        setAddSuccess('');
        try {
            const headers = await authHeaders();
            const [detailResp, invResp] = await Promise.all([
                fetch(`${GATEWAY}/api/groups/${group.group_id}`, { headers }),
                fetch(`${GATEWAY}/api/groups/${group.group_id}/invitations`, { headers }),
            ]);
            if (detailResp.ok) setSelected(await detailResp.json());
            if (invResp.ok)    setInvitations(await invResp.json());
        } catch { /* non-fatal */ } finally { setDetailLoading(false); }
    }

    // ── Create group ──────────────────────────────────────────────────────────

    function handleNameChange(v: string) {
        setNewName(v);
        if (!slugManual) setNewSlug(toSlug(v));
    }

    async function createGroup() {
        if (!newName.trim() || !newSlug.trim()) return;
        setCreating(true);
        setCreateError('');
        try {
            const headers = await authHeaders();
            const resp = await fetch(`${GATEWAY}/api/groups`, {
                method: 'POST', headers,
                body: JSON.stringify({ name: newName.trim(), slug: newSlug.trim(), description: newDesc.trim() || undefined }),
            });
            if (!resp.ok) {
                const err = await resp.json();
                setCreateError(err.error || 'Failed to create group');
                return;
            }
            const created = await resp.json();
            setGroups(prev =>
                [...prev, { ...created, member_count: 0, description: newDesc.trim() || null }]
                    .sort((a, b) => a.name.localeCompare(b.name))
            );
            setShowCreate(false);
            setNewName(''); setNewSlug(''); setNewDesc(''); setSlugManual(false);
        } catch { setCreateError('Network error'); } finally { setCreating(false); }
    }

    // ── Add / invite member ───────────────────────────────────────────────────
    // Single call to /api/groups/:id/invite — backend resolves Clerk, adds directly
    // if the user exists, or creates a pending invitation + sends email if not.

    async function addOrInviteMember() {
        if (!selected || !addEmail.trim()) return;
        setAddingMember(true);
        setAddError('');
        setAddSuccess('');
        try {
            const headers = await authHeaders();
            const resp = await fetch(`${GATEWAY}/api/groups/${selected.group_id}/invite`, {
                method: 'POST', headers,
                body: JSON.stringify({ email: addEmail.trim() }),
            });
            const data = await resp.json();
            if (!resp.ok) {
                setAddError(data.error || 'Failed');
                return;
            }
            if (data.added) {
                setSelected(prev => prev
                    ? { ...prev, members: [...prev.members, data.member], member_count: prev.member_count + 1 }
                    : prev
                );
                setGroups(prev => prev.map(g =>
                    g.group_id === selected.group_id ? { ...g, member_count: g.member_count + 1 } : g
                ));
                setAddSuccess(`${data.member.display_name || data.member.email} added to the group.`);
            } else if (data.invited) {
                setInvitations(prev => [data.invitation, ...prev]);
                setAddSuccess(`Invite sent to ${addEmail.trim()}. They'll be added automatically when they sign up.`);
            }
            setAddEmail('');
        } catch { setAddError('Network error'); } finally { setAddingMember(false); }
    }

    // ── Remove member ─────────────────────────────────────────────────────────

    async function removeMember(userSub: string) {
        if (!selected) return;
        setRemovingSub(userSub);
        try {
            const headers = await authHeaders();
            const resp = await fetch(
                `${GATEWAY}/api/groups/${selected.group_id}/members/${encodeURIComponent(userSub)}`,
                { method: 'DELETE', headers }
            );
            if (resp.ok) {
                setSelected(prev => prev
                    ? { ...prev, members: prev.members.filter(m => m.user_sub !== userSub), member_count: prev.member_count - 1 }
                    : prev
                );
                setGroups(prev => prev.map(g =>
                    g.group_id === selected.group_id ? { ...g, member_count: g.member_count - 1 } : g
                ));
            }
        } catch { /* non-fatal */ } finally { setRemovingSub(null); }
    }

    // ── Invitation actions ────────────────────────────────────────────────────

    async function resendInvitation(invId: string) {
        if (!selected) return;
        setResendingInvId(invId);
        try {
            const headers = await authHeaders();
            await fetch(`${GATEWAY}/api/groups/${selected.group_id}/invitations/${invId}/resend`, { method: 'POST', headers });
        } catch { /* non-fatal */ } finally { setResendingInvId(null); }
    }

    async function cancelInvitation(invId: string) {
        if (!selected) return;
        setCancellingInvId(invId);
        try {
            const headers = await authHeaders();
            const resp = await fetch(`${GATEWAY}/api/groups/${selected.group_id}/invitations/${invId}`, { method: 'DELETE', headers });
            if (resp.ok) setInvitations(prev => prev.filter(i => i.invitation_id !== invId));
        } catch { /* non-fatal */ } finally { setCancellingInvId(null); }
    }

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <div className="min-h-screen bg-slate-50">
            {/* Header */}
            <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
                <div className="max-w-5xl mx-auto px-6 h-16 flex items-center gap-4">
                    <Link href="/settings/sharing"
                        className="flex items-center gap-1.5 text-slate-400 hover:text-slate-700 transition-colors text-sm">
                        <ArrowLeft className="w-4 h-4" />
                        Sharing & Access
                    </Link>
                    <span className="text-slate-200">/</span>
                    <span className="text-sm font-bold text-slate-700">Groups</span>
                    <div className="ml-auto flex items-center gap-2">
                        <Link href="/dashboard"
                            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-bold transition-all">
                            <ExternalLink className="w-3.5 h-3.5" />
                            Dashboard
                        </Link>
                        <button
                            onClick={() => { setShowCreate(true); setCreateError(''); }}
                            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold transition-all">
                            <Plus className="w-3.5 h-3.5" />
                            New Group
                        </button>
                    </div>
                </div>
            </header>

            <div className="max-w-5xl mx-auto px-6 py-10">
                <div className="flex gap-6 items-start">
                    {/* ── Groups list ── */}
                    <div className="w-72 shrink-0 space-y-4">
                        <div>
                            <h1 className="text-xl font-black text-slate-900">Groups</h1>
                            <p className="text-xs text-slate-500 mt-0.5">
                                Share graph access with multiple people at once.
                            </p>
                        </div>

                        {loading ? (
                            <div className="flex items-center justify-center py-10">
                                <Loader2 className="w-5 h-5 text-slate-300 animate-spin" />
                            </div>
                        ) : groups.length === 0 ? (
                            <div className="flex flex-col items-center py-10 gap-3 text-center">
                                <div className="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center">
                                    <Users className="w-5 h-5 text-slate-300" />
                                </div>
                                <p className="text-xs text-slate-500 max-w-[180px]">
                                    No groups yet. Create one to share with multiple people at once.
                                </p>
                                <button onClick={() => setShowCreate(true)}
                                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all">
                                    <Plus className="w-3 h-3" />New Group
                                </button>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {groups.map(g => (
                                    <GroupRow
                                        key={g.group_id}
                                        group={g}
                                        selected={selected?.group_id === g.group_id}
                                        onClick={() => openGroup(g)}
                                    />
                                ))}
                            </div>
                        )}
                    </div>

                    {/* ── Group detail ── */}
                    <div className="flex-1 min-w-0">
                        {!selected && !detailLoading ? (
                            <div className="flex flex-col items-center justify-center min-h-[300px] gap-3 text-center rounded-2xl border-2 border-dashed border-slate-200">
                                <Users className="w-8 h-8 text-slate-200" />
                                <p className="text-sm text-slate-400">Select a group to manage its members</p>
                            </div>
                        ) : detailLoading ? (
                            <div className="flex items-center justify-center min-h-[300px]">
                                <Loader2 className="w-5 h-5 text-slate-300 animate-spin" />
                            </div>
                        ) : selected ? (
                            <GroupDetailPanel
                                group={selected}
                                invitations={invitations}
                                addEmail={addEmail}
                                addError={addError}
                                addSuccess={addSuccess}
                                addingMember={addingMember}
                                removingSub={removingSub}
                                resendingInvId={resendingInvId}
                                cancellingInvId={cancellingInvId}
                                onEmailChange={v => { setAddEmail(v); setAddError(''); setAddSuccess(''); }}
                                onAddOrInvite={addOrInviteMember}
                                onRemoveMember={removeMember}
                                onResendInvitation={resendInvitation}
                                onCancelInvitation={cancelInvitation}
                            />
                        ) : null}
                    </div>
                </div>
            </div>

            {/* ── Create group modal ── */}
            {showCreate && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
                    <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6 space-y-5">
                        <div className="flex items-center justify-between">
                            <h2 className="text-lg font-black text-slate-900">New Group</h2>
                            <button onClick={() => setShowCreate(false)}
                                className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 transition-colors">
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                        <div className="space-y-4">
                            <FormField label="Name" required>
                                <input autoFocus value={newName} onChange={e => handleNameChange(e.target.value)}
                                    onKeyDown={e => e.key === 'Enter' && createGroup()}
                                    placeholder="e.g. Hiring Managers"
                                    className="w-full px-3 py-2.5 rounded-xl border border-slate-200 bg-slate-50 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
                            </FormField>
                            <FormField label="Slug" hint="auto-generated, URL-safe">
                                <input value={newSlug} onChange={e => { setNewSlug(e.target.value); setSlugManual(true); }}
                                    onKeyDown={e => e.key === 'Enter' && createGroup()}
                                    placeholder="e.g. hiring-managers"
                                    className="w-full px-3 py-2.5 rounded-xl border border-slate-200 bg-slate-50 text-sm text-slate-900 font-mono placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
                            </FormField>
                            <FormField label="Description" hint="optional">
                                <input value={newDesc} onChange={e => setNewDesc(e.target.value)}
                                    onKeyDown={e => e.key === 'Enter' && createGroup()}
                                    placeholder="e.g. Recruiters and hiring panel members"
                                    className="w-full px-3 py-2.5 rounded-xl border border-slate-200 bg-slate-50 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
                            </FormField>
                        </div>
                        {createError && <p className="text-xs text-red-600 font-medium">{createError}</p>}
                        <div className="flex justify-end gap-3 pt-1">
                            <button onClick={() => setShowCreate(false)}
                                className="px-4 py-2.5 rounded-xl text-sm font-bold text-slate-600 hover:bg-slate-100 transition-all">
                                Cancel
                            </button>
                            <button onClick={createGroup} disabled={creating || !newName.trim() || !newSlug.trim()}
                                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold transition-all disabled:opacity-40">
                                {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                                Create Group
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// ── Group row ──────────────────────────────────────────────────────────────────

function GroupRow({ group, selected, onClick }: { group: Group; selected: boolean; onClick: () => void }) {
    return (
        <button onClick={onClick}
            className={`w-full text-left px-4 py-3 rounded-xl border transition-all flex items-center gap-3 ${
                selected ? 'border-indigo-300 bg-indigo-50 shadow-sm' : 'border-slate-200 bg-white hover:bg-slate-50'
            }`}>
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${selected ? 'bg-indigo-100' : 'bg-slate-100'}`}>
                <Users className={`w-4 h-4 ${selected ? 'text-indigo-600' : 'text-slate-400'}`} />
            </div>
            <div className="flex-1 min-w-0">
                <p className={`text-sm font-bold truncate ${selected ? 'text-indigo-900' : 'text-slate-800'}`}>{group.name}</p>
                <p className="text-xs text-slate-400">{group.member_count} member{group.member_count !== 1 ? 's' : ''}</p>
            </div>
            <ChevronRight className={`w-3.5 h-3.5 shrink-0 ${selected ? 'text-indigo-400' : 'text-slate-300'}`} />
        </button>
    );
}

// ── Group detail panel ─────────────────────────────────────────────────────────

function GroupDetailPanel({
    group, invitations,
    addEmail, addError, addSuccess, addingMember,
    removingSub, resendingInvId, cancellingInvId,
    onEmailChange, onAddOrInvite, onRemoveMember, onResendInvitation, onCancelInvitation,
}: {
    group: GroupDetail;
    invitations: GroupInvitation[];
    addEmail: string; addError: string; addSuccess: string; addingMember: boolean;
    removingSub: string | null; resendingInvId: string | null; cancellingInvId: string | null;
    onEmailChange: (v: string) => void;
    onAddOrInvite: () => void;
    onRemoveMember: (sub: string) => void;
    onResendInvitation: (id: string) => void;
    onCancelInvitation: (id: string) => void;
}) {
    return (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
            {/* Header */}
            <div className="px-6 py-5 border-b border-slate-100">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center shrink-0">
                        <Users className="w-5 h-5 text-indigo-600" />
                    </div>
                    <div className="min-w-0">
                        <h2 className="text-base font-black text-slate-900 truncate">{group.name}</h2>
                        <p className="text-xs text-slate-400 font-mono">{group.slug}</p>
                    </div>
                </div>
                {group.description && (
                    <p className="text-sm text-slate-500 mt-2 pl-[52px]">{group.description}</p>
                )}
                <p className="text-xs text-slate-400 mt-1 pl-[52px] flex items-center gap-1">
                    <Calendar className="w-3 h-3" />Created {fmt(group.created_at)}
                </p>
            </div>

            {/* Add / invite member */}
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-100">
                <p className="text-xs font-bold text-slate-600 mb-2">Add or invite member by email</p>
                <div className="flex gap-2">
                    <input
                        value={addEmail}
                        onChange={e => onEmailChange(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && onAddOrInvite()}
                        placeholder="user@example.com"
                        className="flex-1 px-3 py-2 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    />
                    <button onClick={onAddOrInvite} disabled={addingMember || !addEmail.trim()}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all disabled:opacity-40">
                        {addingMember ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
                        Add
                    </button>
                </div>
                {addError   && <p className="text-xs text-red-600 font-medium mt-1.5">{addError}</p>}
                {addSuccess && <p className="text-xs text-emerald-600 font-medium mt-1.5">{addSuccess}</p>}
                <p className="text-[10px] text-slate-400 mt-1.5">
                    If the user doesn't have a CortexDrive account, an invite email will be sent and they'll be added automatically when they sign up.
                </p>
            </div>

            {/* Active members */}
            <div className="px-6 py-4">
                {group.members.length === 0 && invitations.length === 0 ? (
                    <div className="flex flex-col items-center py-8 gap-2 text-center">
                        <Users className="w-6 h-6 text-slate-200" />
                        <p className="text-xs text-slate-400">No members yet. Add or invite the first member above.</p>
                    </div>
                ) : (
                    <div className="space-y-5">
                        {group.members.length > 0 && (
                            <div className="space-y-1">
                                <p className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">
                                    Members — {group.members.length}
                                </p>
                                {group.members.map(m => (
                                    <div key={m.user_sub}
                                        className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-50 transition-colors group">
                                        <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
                                            <span className="text-xs font-bold text-slate-500">
                                                {(m.display_name || m.email || m.user_sub).charAt(0).toUpperCase()}
                                            </span>
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium text-slate-800 truncate">{memberLabel(m)}</p>
                                            <p className="text-xs text-slate-400">Added {fmt(m.added_at)}</p>
                                        </div>
                                        <button onClick={() => onRemoveMember(m.user_sub)} disabled={removingSub === m.user_sub}
                                            title="Remove member"
                                            className="p-1.5 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-all opacity-0 group-hover:opacity-100 disabled:opacity-40">
                                            {removingSub === m.user_sub
                                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                : <UserMinus className="w-3.5 h-3.5" />
                                            }
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Pending invitations */}
                        {invitations.length > 0 && (
                            <div className="space-y-1">
                                <p className="text-xs font-bold text-amber-600 uppercase tracking-widest mb-3 flex items-center gap-1.5">
                                    <Clock className="w-3 h-3" />
                                    Pending Invites — {invitations.length}
                                </p>
                                {invitations.map(inv => (
                                    <div key={inv.invitation_id}
                                        className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-amber-50 border border-amber-100">
                                        <div className="w-7 h-7 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
                                            <Clock className="w-3.5 h-3.5 text-amber-500" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium text-slate-800 truncate">{inv.pending_email}</p>
                                            <p className="text-xs text-slate-400">
                                                Invited {fmt(inv.invited_at)} · awaiting sign-up
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-1 shrink-0">
                                            <button onClick={() => onResendInvitation(inv.invitation_id)} disabled={resendingInvId === inv.invitation_id}
                                                title="Resend invite"
                                                className="p-1.5 rounded-lg text-amber-500 hover:text-amber-700 hover:bg-amber-100 transition-all disabled:opacity-40">
                                                {resendingInvId === inv.invitation_id
                                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                    : <Send className="w-3.5 h-3.5" />
                                                }
                                            </button>
                                            <button onClick={() => onCancelInvitation(inv.invitation_id)} disabled={cancellingInvId === inv.invitation_id}
                                                title="Cancel invite"
                                                className="p-1.5 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-all disabled:opacity-40">
                                                {cancellingInvId === inv.invitation_id
                                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                    : <Trash2 className="w-3.5 h-3.5" />
                                                }
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

// ── Form field ─────────────────────────────────────────────────────────────────

function FormField({ label, children, hint, required }: {
    label: string; children: React.ReactNode; hint?: string; required?: boolean;
}) {
    return (
        <div className="space-y-1.5">
            <label className="text-xs font-bold text-slate-700">
                {label}
                {required && <span className="text-red-500 ml-0.5">*</span>}
                {hint && <span className="font-normal text-slate-400 ml-1">— {hint}</span>}
            </label>
            {children}
        </div>
    );
}
