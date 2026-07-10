"use client";

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import {
    ArrowLeft, Link2, Copy, Check, Trash2, Eye,
    Calendar, ExternalLink, AlertCircle, Loader2, RefreshCw,
    Users, UserCheck, Clock, Send, XCircle, Shield, UserMinus,
} from 'lucide-react';

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:4000';

type Tab = 'public-links' | 'named-shares' | 'pending-invites';

// ── Types ──────────────────────────────────────────────────────────────────────

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

interface AudienceMember {
    assignment_id: string;
    assignee_type: 'user' | 'group';
    assignee_id: string;
    assignee_email: string | null;
    group_name: string | null;
    member_count: number | null;
    status: 'active' | 'revoked' | 'expired';
    assigned_at: string;
    expires_at: string | null;
}

interface PendingAudienceMember {
    invitation_id: string;
    invited_email: string;
    invited_at: string;
    expires_at: string | null;
}

interface NamedGrant {
    grant_id: string;
    root_node_id: string;
    grant_type: 'node' | 'graph_island';
    node_count: number | null;
    issued_at: string;
    expires_at: string | null;
    status: 'active' | 'revoked';
    audience: AudienceMember[];
    pending_audience: PendingAudienceMember[];
}

interface PendingInvite {
    record_type: 'share' | 'group';
    id: string;
    grant_id: string | null;
    group_id: string | null;
    group_name: string | null;
    pending_email: string;
    issued_at: string;
    expires_at: string | null;
    grant_type: 'node' | 'graph_island' | null;
    node_count: number | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
    active:  'bg-emerald-50 text-emerald-700 border-emerald-200',
    expired: 'bg-amber-50  text-amber-700  border-amber-200',
    revoked: 'bg-red-50    text-red-700    border-red-200',
};

function fmt(iso: string) {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function ExpiryLabel({ expiresAt, revokedAt }: { expiresAt: string | null; revokedAt?: string | null }) {
    if (revokedAt) return <span className="text-xs text-slate-400">Revoked {fmt(revokedAt)}</span>;
    if (!expiresAt) return <span className="text-xs text-slate-400">Never expires</span>;
    const diff = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000);
    if (diff <= 0) return <span className="text-xs text-amber-600">Expired {fmt(expiresAt)}</span>;
    if (diff === 1) return <span className="text-xs text-amber-600 font-medium">Expires tomorrow</span>;
    if (diff <= 7) return <span className="text-xs text-amber-600">Expires in {diff} days</span>;
    return <span className="text-xs text-slate-400">Expires {fmt(expiresAt)}</span>;
}

function GrantTypeBadge({ type }: { type: 'node' | 'graph_island' }) {
    return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${
            type === 'graph_island'
                ? 'bg-violet-50 text-violet-700 border-violet-200'
                : 'bg-sky-50 text-sky-700 border-sky-200'
        }`}>
            {type === 'graph_island' ? 'Graph' : 'Node'}
        </span>
    );
}

function audienceDisplayName(member: AudienceMember): string {
    if (member.assignee_type === 'group') {
        return member.group_name
            ? `${member.group_name}${member.member_count != null ? ` (${member.member_count})` : ''}`
            : `Group ${member.assignee_id.slice(0, 8)}`;
    }
    return member.assignee_email || member.assignee_id;
}

// ── Page root ──────────────────────────────────────────────────────────────────

export default function SharingSettingsPage() {
    const { getToken } = useAuth();
    const [tab, setTab] = useState<Tab>('public-links');

    const [links, setLinks]     = useState<GraphLink[]>([]);
    const [grants, setGrants]   = useState<NamedGrant[]>([]);
    const [pending, setPending] = useState<PendingInvite[]>([]);
    const [loading, setLoading] = useState(true);

    const [copiedId, setCopiedId]         = useState<string | null>(null);
    const [revokingId, setRevokingId]     = useState<string | null>(null);
    const [confirmId, setConfirmId]       = useState<string | null>(null);
    const [resendingId, setResendingId]   = useState<string | null>(null);
    const [cancellingId, setCancellingId] = useState<string | null>(null);

    const authHeaders = useCallback(async () => {
        const token = await getToken();
        return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    }, [getToken]);

    const loadAll = useCallback(async () => {
        setLoading(true);
        try {
            const headers = await authHeaders();
            const [linksResp, grantsResp, pendingResp] = await Promise.all([
                fetch(`${GATEWAY}/api/share/graph-links`, { headers }),
                fetch(`${GATEWAY}/api/share/grants`, { headers }),
                fetch(`${GATEWAY}/api/share/pending`, { headers }),
            ]);
            if (linksResp.ok)   setLinks(await linksResp.json());
            if (grantsResp.ok)  setGrants(await grantsResp.json());
            if (pendingResp.ok) setPending(await pendingResp.json());
        } catch { /* non-fatal */ } finally { setLoading(false); }
    }, [authHeaders]);

    useEffect(() => { loadAll(); }, [loadAll]);

    // ── Public links actions ───────────────────────────────────────────────────

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
            if (resp.ok) setLinks(prev => prev.map(l =>
                l.link_id === linkId ? { ...l, status: 'revoked' as const, revoked_at: new Date().toISOString() } : l
            ));
        } catch { /* non-fatal */ } finally { setRevokingId(null); setConfirmId(null); }
    }

    // ── Named grant actions ────────────────────────────────────────────────────

    async function revokeGrant(grantId: string) {
        setRevokingId(grantId);
        try {
            const headers = await authHeaders();
            const resp = await fetch(`${GATEWAY}/api/share/grants/${grantId}`, { method: 'DELETE', headers });
            if (resp.ok) setGrants(prev => prev.filter(g => g.grant_id !== grantId));
        } catch { /* non-fatal */ } finally { setRevokingId(null); setConfirmId(null); }
    }

    async function revokeAudienceMember(grantId: string, assignmentId: string) {
        setRevokingId(assignmentId);
        try {
            const headers = await authHeaders();
            const resp = await fetch(
                `${GATEWAY}/api/share/grants/${grantId}/audience/${assignmentId}`,
                { method: 'DELETE', headers }
            );
            if (resp.ok) {
                setGrants(prev => prev.map(g =>
                    g.grant_id === grantId
                        ? { ...g, audience: g.audience.filter(m => m.assignment_id !== assignmentId) }
                        : g
                ));
            }
        } catch { /* non-fatal */ } finally { setRevokingId(null); setConfirmId(null); }
    }

    async function cancelPendingAudience(grantId: string, invitationId: string) {
        setCancellingId(invitationId);
        try {
            const headers = await authHeaders();
            const resp = await fetch(`${GATEWAY}/api/share/cancel-invite/${grantId}`, { method: 'DELETE', headers });
            if (resp.ok) {
                setGrants(prev => prev.map(g =>
                    g.grant_id === grantId
                        ? { ...g, pending_audience: g.pending_audience.filter(p => p.invitation_id !== invitationId) }
                        : g
                ));
            }
        } catch { /* non-fatal */ } finally { setCancellingId(null); }
    }

    async function resendPendingAudience(grantId: string) {
        setResendingId(grantId);
        try {
            const headers = await authHeaders();
            await fetch(`${GATEWAY}/api/share/resend-invite/${grantId}`, { method: 'POST', headers });
        } catch { /* non-fatal */ } finally { setResendingId(null); }
    }

    // ── Pending invites tab actions ────────────────────────────────────────────

    async function resendInvite(invite: PendingInvite) {
        setResendingId(invite.id);
        try {
            const headers = await authHeaders();
            if (invite.record_type === 'share') {
                await fetch(`${GATEWAY}/api/share/resend-invite/${invite.grant_id}`, { method: 'POST', headers });
            } else {
                await fetch(`${GATEWAY}/api/groups/${invite.group_id}/invitations/${invite.id}/resend`, { method: 'POST', headers });
            }
        } catch { /* non-fatal */ } finally { setResendingId(null); }
    }

    async function cancelInvite(invite: PendingInvite) {
        setCancellingId(invite.id);
        try {
            const headers = await authHeaders();
            let resp: Response;
            if (invite.record_type === 'share') {
                resp = await fetch(`${GATEWAY}/api/share/cancel-invite/${invite.grant_id}`, { method: 'DELETE', headers });
            } else {
                resp = await fetch(`${GATEWAY}/api/groups/${invite.group_id}/invitations/${invite.id}`, { method: 'DELETE', headers });
            }
            if (resp.ok) setPending(prev => prev.filter(p => p.id !== invite.id));
        } catch { /* non-fatal */ } finally { setCancellingId(null); setConfirmId(null); }
    }

    // ── Tab counts ─────────────────────────────────────────────────────────────

    const activeLinks   = links.filter(l => l.status === 'active');
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
                        <button onClick={loadAll}
                            className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors">
                            <RefreshCw className="w-4 h-4" />
                        </button>
                        <Link href="/settings/groups"
                            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-bold transition-all">
                            <Users className="w-3.5 h-3.5" />
                            Groups
                        </Link>
                        <Link href="/dashboard"
                            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold transition-all">
                            <ExternalLink className="w-3.5 h-3.5" />
                            Open Dashboard
                        </Link>
                    </div>
                </div>
            </header>

            <div className="max-w-5xl mx-auto px-6 py-10 space-y-8">
                <div>
                    <h1 className="text-2xl font-black text-slate-900">Sharing & Access</h1>
                    <p className="text-sm text-slate-500 mt-1">
                        Manage public graph links, named grants, and pending invites.
                    </p>
                </div>

                {/* Tab strip */}
                <div className="flex gap-1 p-1 bg-slate-100 rounded-2xl w-fit">
                    <TabButton tab="public-links" active={tab} onClick={setTab} icon={<Link2 className="w-3.5 h-3.5 text-indigo-600" />}
                        label="Public Links" count={links.length} />
                    <TabButton tab="named-shares" active={tab} onClick={setTab} icon={<UserCheck className="w-3.5 h-3.5 text-emerald-600" />}
                        label="Named Shares" count={grants.length} />
                    <TabButton tab="pending-invites" active={tab} onClick={setTab} icon={<Clock className="w-3.5 h-3.5 text-amber-500" />}
                        label="Pending Invites" count={pending.length} />
                </div>

                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="w-6 h-6 text-slate-300 animate-spin" />
                    </div>
                ) : (
                    <>
                        {/* ── Public Links ── */}
                        {tab === 'public-links' && (
                            links.length === 0 ? (
                                <EmptyState icon={<Link2 className="w-6 h-6 text-slate-300" />}
                                    title="No public links yet"
                                    body='Run a query in the dashboard, then click "Share Graph" → "Public Link" to generate one.' />
                            ) : (
                                <div className="space-y-6">
                                    {activeLinks.length > 0 && (
                                        <section className="space-y-3">
                                            <SectionHeading label="Active" count={activeLinks.length} />
                                            {activeLinks.map(link => (
                                                <LinkCard key={link.link_id} link={link}
                                                    copiedId={copiedId} revokingId={revokingId} confirmId={confirmId}
                                                    onCopy={copyUrl} onConfirm={setConfirmId} onRevoke={revokeLink} />
                                            ))}
                                        </section>
                                    )}
                                    {inactiveLinks.length > 0 && (
                                        <section className="space-y-3">
                                            <SectionHeading label="Expired / Revoked" count={inactiveLinks.length} dimmed />
                                            {inactiveLinks.map(link => (
                                                <LinkCard key={link.link_id} link={link} dimmed
                                                    copiedId={copiedId} revokingId={revokingId} confirmId={confirmId}
                                                    onCopy={copyUrl} onConfirm={setConfirmId} onRevoke={revokeLink} />
                                            ))}
                                        </section>
                                    )}
                                </div>
                            )
                        )}

                        {/* ── Named Shares ── */}
                        {tab === 'named-shares' && (
                            grants.length === 0 ? (
                                <EmptyState icon={<UserCheck className="w-6 h-6 text-slate-300" />}
                                    title="No named shares yet"
                                    body='Open a node in the dashboard → "Share" → share with a person or group to create a named grant.' />
                            ) : (
                                <section className="space-y-4">
                                    <SectionHeading label="Active grants" count={grants.length} />
                                    {grants.map(grant => (
                                        <GrantCard key={grant.grant_id} grant={grant}
                                            revokingId={revokingId} confirmId={confirmId}
                                            cancellingId={cancellingId} resendingId={resendingId}
                                            onConfirm={setConfirmId}
                                            onRevokeGrant={revokeGrant}
                                            onRevokeAudience={revokeAudienceMember}
                                            onCancelPending={cancelPendingAudience}
                                            onResendPending={resendPendingAudience} />
                                    ))}
                                </section>
                            )
                        )}

                        {/* ── Pending Invites ── */}
                        {tab === 'pending-invites' && (
                            pending.length === 0 ? (
                                <EmptyState icon={<Clock className="w-6 h-6 text-slate-300" />}
                                    title="No pending invites"
                                    body="Share with an email address that has no CortexDrive account — the invite will appear here." />
                            ) : (
                                <section className="space-y-3">
                                    <SectionHeading label="Awaiting sign-up" count={pending.length} />
                                    {pending.map(invite => (
                                        <InviteCard key={invite.id} invite={invite}
                                            resendingId={resendingId} cancellingId={cancellingId} confirmId={confirmId}
                                            onResend={resendInvite} onConfirm={setConfirmId} onCancel={cancelInvite} />
                                    ))}
                                </section>
                            )
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

// ── Tab button ─────────────────────────────────────────────────────────────────

function TabButton({ tab, active, onClick, icon, label, count }: {
    tab: Tab; active: Tab; onClick: (t: Tab) => void;
    icon: React.ReactNode; label: string; count: number;
}) {
    const isActive = tab === active;
    return (
        <button onClick={() => onClick(tab)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-all ${
                isActive ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'
            }`}>
            {icon}
            {label}
            {count > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-[10px] font-black">
                    {count}
                </span>
            )}
        </button>
    );
}

// ── Section heading ────────────────────────────────────────────────────────────

function SectionHeading({ label, count, dimmed }: { label: string; count: number; dimmed?: boolean }) {
    return (
        <h2 className={`text-xs font-bold uppercase tracking-widest px-1 ${dimmed ? 'text-slate-400' : 'text-slate-500'}`}>
            {label} — {count}
        </h2>
    );
}

// ── Empty state ────────────────────────────────────────────────────────────────

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
    return (
        <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
            <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center">{icon}</div>
            <div>
                <p className="text-sm font-bold text-slate-700">{title}</p>
                <p className="text-xs text-slate-400 mt-1 max-w-sm">{body}</p>
            </div>
        </div>
    );
}

// ── Link card (Public Links tab) ───────────────────────────────────────────────

function LinkCard({ link, copiedId, revokingId, confirmId, onCopy, onConfirm, onRevoke, dimmed }: {
    link: GraphLink;
    copiedId: string | null; revokingId: string | null; confirmId: string | null;
    onCopy: (l: GraphLink) => void; onConfirm: (id: string | null) => void; onRevoke: (id: string) => void;
    dimmed?: boolean;
}) {
    const isCopied     = copiedId === link.link_id;
    const isRevoking   = revokingId === link.link_id;
    const isConfirming = confirmId === link.link_id;

    return (
        <div className={`bg-white border rounded-2xl p-5 transition-all ${dimmed ? 'border-slate-100 opacity-60' : 'border-slate-200 shadow-sm'}`}>
            <div className="flex items-start gap-4">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${dimmed ? 'bg-slate-100' : 'bg-indigo-50'}`}>
                    <Link2 className={`w-5 h-5 ${dimmed ? 'text-slate-300' : 'text-indigo-600'}`} />
                </div>
                <div className="flex-1 min-w-0 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-black text-slate-900 truncate">
                            {link.title || 'Untitled graph link'}
                        </span>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${STATUS_STYLES[link.status]}`}>
                            {link.status}
                        </span>
                    </div>
                    <p className="text-xs text-slate-400 font-mono truncate">{link.shareUrl}</p>
                    <div className="flex items-center gap-4 flex-wrap">
                        <span className="flex items-center gap-1 text-xs text-slate-500">
                            <Eye className="w-3 h-3" />{link.view_count} view{link.view_count !== 1 ? 's' : ''}
                        </span>
                        <span className="flex items-center gap-1 text-xs text-slate-500">
                            <Calendar className="w-3 h-3" />Created {fmt(link.created_at)}
                        </span>
                        <span className="text-xs text-slate-400">{link.node_count} node{link.node_count !== 1 ? 's' : ''}</span>
                        <ExpiryLabel expiresAt={link.expires_at} revokedAt={link.revoked_at} />
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => onCopy(link)}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-50 hover:bg-indigo-50 border border-slate-200 hover:border-indigo-200 text-xs font-bold text-slate-600 hover:text-indigo-600 transition-all">
                        {isCopied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                        {isCopied ? 'Copied' : 'Copy'}
                    </button>
                    {link.status === 'active' && (
                        <a href={link.shareUrl} target="_blank" rel="noopener noreferrer"
                            className="p-2 rounded-xl bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-400 hover:text-slate-700 transition-all">
                            <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                    )}
                    {link.status === 'active' && (
                        isConfirming ? (
                            <div className="flex items-center gap-1.5">
                                <button onClick={() => onRevoke(link.link_id)} disabled={isRevoking}
                                    className="flex items-center gap-1 px-3 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition-all disabled:opacity-40">
                                    {isRevoking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                                    Confirm
                                </button>
                                <button onClick={() => onConfirm(null)} className="px-2 py-2 rounded-xl text-xs text-slate-400 hover:text-slate-700 transition-colors">
                                    Cancel
                                </button>
                            </div>
                        ) : (
                            <button onClick={() => onConfirm(link.link_id)}
                                className="p-2 rounded-xl bg-slate-50 hover:bg-red-50 border border-slate-200 hover:border-red-200 text-slate-400 hover:text-red-600 transition-all">
                                <Trash2 className="w-3.5 h-3.5" />
                            </button>
                        )
                    )}
                </div>
            </div>
        </div>
    );
}

// ── Grant card (Named Shares tab) — grouped, with per-audience actions ─────────

function GrantCard({ grant, revokingId, confirmId, cancellingId, resendingId,
    onConfirm, onRevokeGrant, onRevokeAudience, onCancelPending, onResendPending }: {
    grant: NamedGrant;
    revokingId: string | null; confirmId: string | null;
    cancellingId: string | null; resendingId: string | null;
    onConfirm: (id: string | null) => void;
    onRevokeGrant: (grantId: string) => void;
    onRevokeAudience: (grantId: string, assignmentId: string) => void;
    onCancelPending: (grantId: string, invitationId: string) => void;
    onResendPending: (grantId: string) => void;
}) {
    const grantConfirmKey = `grant:${grant.grant_id}`;
    const isRevokingGrant = revokingId === grant.grant_id;
    const isConfirmingRevoke = confirmId === grantConfirmKey;
    const totalAudience = grant.audience.length + grant.pending_audience.length;

    return (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
            {/* Grant header */}
            <div className="flex items-center gap-4 px-5 pt-5 pb-4">
                <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center shrink-0">
                    <Shield className="w-5 h-5 text-emerald-600" />
                </div>
                <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                        <GrantTypeBadge type={grant.grant_type} />
                        <span className="text-xs text-slate-500">
                            {grant.node_count ?? '?'} node{grant.node_count !== 1 ? 's' : ''}
                        </span>
                        <span className="text-slate-200">·</span>
                        <span className="flex items-center gap-1 text-xs text-slate-500">
                            <Calendar className="w-3 h-3" />Issued {fmt(grant.issued_at)}
                        </span>
                        <ExpiryLabel expiresAt={grant.expires_at} />
                    </div>
                    <p className="text-[10px] text-slate-300 font-mono truncate">{grant.root_node_id}</p>
                </div>
                <div className="shrink-0">
                    {isConfirmingRevoke ? (
                        <div className="flex items-center gap-1.5">
                            <button onClick={() => onRevokeGrant(grant.grant_id)} disabled={isRevokingGrant}
                                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition-all disabled:opacity-40">
                                {isRevokingGrant ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3" />}
                                Revoke all
                            </button>
                            <button onClick={() => onConfirm(null)}
                                className="px-2 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-700 transition-colors">
                                Keep
                            </button>
                        </div>
                    ) : (
                        <button onClick={() => onConfirm(grantConfirmKey)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-50 hover:bg-red-50 border border-slate-200 hover:border-red-200 text-slate-400 hover:text-red-600 text-xs font-bold transition-all"
                            title="Revoke access for all audience members">
                            <Trash2 className="w-3 h-3" />
                            Revoke grant
                        </button>
                    )}
                </div>
            </div>

            {/* Audience list */}
            {totalAudience > 0 && (
                <div className="border-t border-slate-100 divide-y divide-slate-50">
                    {grant.audience.map(member => {
                        const memberKey = member.assignment_id;
                        const isRevokingMember = revokingId === memberKey;
                        const isConfirmingMember = confirmId === memberKey;
                        return (
                            <div key={member.assignment_id}
                                className="flex items-center gap-3 px-5 py-3">
                                <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                                    member.assignee_type === 'group' ? 'bg-emerald-50' : 'bg-sky-50'
                                }`}>
                                    {member.assignee_type === 'group'
                                        ? <Users className="w-3.5 h-3.5 text-emerald-600" />
                                        : <UserCheck className="w-3.5 h-3.5 text-sky-600" />
                                    }
                                </div>
                                <span className="flex-1 text-sm text-slate-700 truncate">
                                    {audienceDisplayName(member)}
                                </span>
                                <span className="text-xs text-slate-400">
                                    {fmt(member.assigned_at)}
                                </span>
                                {isConfirmingMember ? (
                                    <div className="flex items-center gap-1.5">
                                        <button onClick={() => onRevokeAudience(grant.grant_id, member.assignment_id)}
                                            disabled={isRevokingMember}
                                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition-all disabled:opacity-40">
                                            {isRevokingMember ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserMinus className="w-3 h-3" />}
                                            Remove
                                        </button>
                                        <button onClick={() => onConfirm(null)}
                                            className="px-2 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-700">
                                            Keep
                                        </button>
                                    </div>
                                ) : (
                                    <button onClick={() => onConfirm(memberKey)}
                                        className="p-1.5 rounded-lg hover:bg-red-50 text-slate-300 hover:text-red-500 transition-all"
                                        title="Remove from grant">
                                        <UserMinus className="w-3.5 h-3.5" />
                                    </button>
                                )}
                            </div>
                        );
                    })}
                    {grant.pending_audience.map(pend => {
                        const isCancelling = cancellingId === pend.invitation_id;
                        const isResending  = resendingId === grant.grant_id;
                        return (
                            <div key={pend.invitation_id}
                                className="flex items-center gap-3 px-5 py-3 bg-amber-50/40">
                                <div className="w-7 h-7 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
                                    <Clock className="w-3.5 h-3.5 text-amber-500" />
                                </div>
                                <span className="flex-1 text-sm text-slate-600 truncate">{pend.invited_email}</span>
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold uppercase border bg-amber-50 text-amber-700 border-amber-200">
                                    pending
                                </span>
                                <button onClick={() => onResendPending(grant.grant_id)} disabled={isResending}
                                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-50 hover:bg-amber-50 border border-slate-200 hover:border-amber-300 text-xs font-bold text-slate-500 hover:text-amber-700 transition-all disabled:opacity-40">
                                    {isResending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                                    Resend
                                </button>
                                <button onClick={() => onCancelPending(grant.grant_id, pend.invitation_id)}
                                    disabled={isCancelling}
                                    className="p-1.5 rounded-lg hover:bg-red-50 text-slate-300 hover:text-red-500 transition-all disabled:opacity-40"
                                    title="Cancel invite">
                                    {isCancelling ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}

            {totalAudience === 0 && (
                <div className="border-t border-slate-100 px-5 py-3">
                    <p className="text-xs text-slate-400 italic">No audience — grant content bundle only.</p>
                </div>
            )}
        </div>
    );
}

// ── Invite card (Pending Invites tab) ──────────────────────────────────────────

function InviteCard({ invite, resendingId, cancellingId, confirmId, onResend, onConfirm, onCancel }: {
    invite: PendingInvite;
    resendingId: string | null; cancellingId: string | null; confirmId: string | null;
    onResend: (invite: PendingInvite) => void;
    onConfirm: (id: string | null) => void;
    onCancel: (invite: PendingInvite) => void;
}) {
    const isResending  = resendingId === invite.id;
    const isCancelling = cancellingId === invite.id;
    const isConfirming = confirmId === invite.id;
    const isGroup      = invite.record_type === 'group';

    return (
        <div className="bg-white border border-amber-200 rounded-2xl p-5 shadow-sm">
            <div className="flex items-start gap-4">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${isGroup ? 'bg-emerald-50' : 'bg-amber-50'}`}>
                    {isGroup
                        ? <Users className="w-5 h-5 text-emerald-600" />
                        : <Clock className="w-5 h-5 text-amber-500" />
                    }
                </div>
                <div className="flex-1 min-w-0 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-black text-slate-900 truncate">{invite.pending_email}</span>
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border bg-amber-50 text-amber-700 border-amber-200">
                            pending
                        </span>
                        {isGroup ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border bg-emerald-50 text-emerald-700 border-emerald-200">
                                <Users className="w-2.5 h-2.5" />Group
                            </span>
                        ) : (
                            invite.grant_type && <GrantTypeBadge type={invite.grant_type} />
                        )}
                    </div>
                    <div className="flex items-center gap-4 flex-wrap">
                        {isGroup ? (
                            <span className="flex items-center gap-1 text-xs text-slate-500">
                                <Users className="w-3 h-3" />
                                {invite.group_name} — joins group on sign-up
                            </span>
                        ) : (
                            <span className="text-xs text-slate-500">
                                {invite.node_count ?? '?'} node{invite.node_count !== 1 ? 's' : ''} — activates on sign-up
                            </span>
                        )}
                        <span className="flex items-center gap-1 text-xs text-slate-500">
                            <Calendar className="w-3 h-3" />Sent {fmt(invite.issued_at)}
                        </span>
                        {!isGroup && <ExpiryLabel expiresAt={invite.expires_at} />}
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => onResend(invite)} disabled={isResending}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-50 hover:bg-amber-50 border border-slate-200 hover:border-amber-300 text-xs font-bold text-slate-600 hover:text-amber-700 transition-all disabled:opacity-40">
                        {isResending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                        Resend
                    </button>
                    {isConfirming ? (
                        <div className="flex items-center gap-1.5">
                            <button onClick={() => onCancel(invite)} disabled={isCancelling}
                                className="flex items-center gap-1 px-3 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition-all disabled:opacity-40">
                                {isCancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                                Cancel invite
                            </button>
                            <button onClick={() => onConfirm(null)} className="px-2 py-2 rounded-xl text-xs text-slate-400 hover:text-slate-700 transition-colors">
                                Keep
                            </button>
                        </div>
                    ) : (
                        <button onClick={() => onConfirm(invite.id)}
                            className="p-2 rounded-xl bg-slate-50 hover:bg-red-50 border border-slate-200 hover:border-red-200 text-slate-400 hover:text-red-600 transition-all"
                            title="Cancel invite">
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
