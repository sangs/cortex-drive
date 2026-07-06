"use client";

import React, { useEffect, useState, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { useUser, useAuth } from '@clerk/nextjs';
import {
    Lock, ExternalLink, X, Calendar, ChevronRight,
    Sparkles, Network, Loader2
} from 'lucide-react';

const EnterpriseGraph = dynamic(() => import('@/components/EnterpriseGraph'), { ssr: false });
const BentoDetailPanel = dynamic(() => import('@/components/BentoDetailPanel'), { ssr: false });

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:4000';

interface SnapshotNode {
    id: string;
    node_id?: string;
    name: string;
    type: string;
    description?: string;
    links?: string[];
    link_titles?: string[];
    // injected at load time
    isBentoEligible?: boolean;
}

interface SnapshotLink {
    source: string;
    target: string;
    type?: string;
}

interface GraphMeta {
    title?: string;
    ownerName: string;
    createdAt: string;
    nodeCount: number;
}

// Mirror of BentoDetailPanel's fallback label logic so links are labelled consistently
function fallbackLinkLabel(url: string) {
    if (url.includes('github.com'))          return 'GitHub Repository';
    if (url.includes('linkedin.com') || url.includes('lnkd.in')) return 'LinkedIn';
    if (url.includes('infoq.com'))           return 'InfoQ Publication';
    if (url.includes('jpmorganchase.com'))   return 'JPMorgan Chase Tech Blog';
    if (url.includes('aws.amazon.com'))      return 'AWS Case Study';
    if (url.includes('medium.com'))          return 'Engineering Blog';
    if (url.includes('drive.proton.me'))     return 'Secure Document (Proton)';
    if (url.includes('sites.google.com'))    return 'Project Website';
    if (/\.(pdf|doc|docx)$/i.test(url))      return 'Whitepaper / Doc';
    return 'External Resource';
}

// ── Snapshot node detail panel (anonymous path) ──────────────────────────────

function SnapshotPanel({
    node,
    allNodes,
    allLinks,
    onClose,
    onSelectNode,
}: {
    node: SnapshotNode;
    allNodes: SnapshotNode[];
    allLinks: SnapshotLink[];
    onClose: () => void;
    onSelectNode: (n: SnapshotNode) => void;
}) {
    const nodeId = node.id || node.node_id || node.name;

    const displayLinks = React.useMemo(() => {
        const titleMap = new Map<string, string>();
        if (Array.isArray(node.links) && Array.isArray(node.link_titles)) {
            node.links.forEach((url, i) => { if (url && node.link_titles![i]) titleMap.set(url, node.link_titles![i]); });
        }
        const urls = new Set<string>();
        (node.links || []).forEach(l => { if (l) urls.add(l); });
        return Array.from(urls).map(url => ({ url, label: titleMap.get(url) || fallbackLinkLabel(url) }));
    }, [node]);

    const neighbors = React.useMemo(() => {
        const neighborIds = new Map<string, string>(); // id → edge type
        allLinks.forEach(l => {
            if (l.source === nodeId && l.target !== nodeId) neighborIds.set(l.target, l.type || '');
            if (l.target === nodeId && l.source !== nodeId) neighborIds.set(l.source, l.type || '');
        });
        return allNodes
            .filter(n => neighborIds.has(n.id || n.node_id || n.name))
            .map(n => ({ ...n, _edgeType: neighborIds.get(n.id || n.node_id || n.name) || '' }));
    }, [node, allNodes, allLinks, nodeId]);

    return (
        <div className="w-80 shrink-0 border-l border-white/5 bg-[#0b0d14] flex flex-col overflow-y-auto">
            {/* Header */}
            <div className="flex items-start justify-between p-4 border-b border-white/5 gap-2">
                <div className="space-y-1.5 flex-1 min-w-0">
                    <span className="inline-block text-[10px] font-bold uppercase tracking-wider text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 rounded-md">
                        {node.type}
                    </span>
                    <h2 className="text-sm font-bold text-white leading-snug">{node.name}</h2>
                </div>
                <button onClick={onClose}
                    className="ml-1 p-1.5 rounded-lg hover:bg-white/5 text-slate-500 hover:text-white transition-all shrink-0">
                    <X className="w-4 h-4" />
                </button>
            </div>

            {/* Description */}
            {node.description && (
                <div className="p-4 border-b border-white/5">
                    <p className="text-xs text-slate-300 leading-relaxed">{node.description}</p>
                </div>
            )}

            {/* Neighbors */}
            {neighbors.length > 0 && (
                <div className="p-4 border-b border-white/5 space-y-2">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 flex items-center gap-1">
                        <Network className="w-3 h-3" />
                        {neighbors.length} Connection{neighbors.length !== 1 ? 's' : ''} in this graph
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                        {neighbors.map(n => (
                            <button
                                key={n.id || n.node_id || n.name}
                                onClick={() => onSelectNode(n)}
                                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-white/5 hover:bg-indigo-500/15 border border-white/5 hover:border-indigo-500/30 transition-all group max-w-full">
                                <span className="text-[9px] font-bold uppercase tracking-wide text-indigo-400 group-hover:text-indigo-300 shrink-0">
                                    {n.type}
                                </span>
                                <ChevronRight className="w-2.5 h-2.5 text-slate-600 shrink-0" />
                                <span className="text-[11px] text-slate-300 group-hover:text-white truncate">{n.name}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Resource links */}
            {displayLinks.length > 0 && (
                <div className="p-4 space-y-2">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Resources</p>
                    {displayLinks.map(({ url, label }) => (
                        <a key={url} href={url} target="_blank" rel="noopener noreferrer"
                            className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 hover:border-sky-500/30 transition-all group">
                            <span className="text-xs text-slate-300 group-hover:text-white truncate pr-3">{label}</span>
                            <ExternalLink className="w-3 h-3 text-slate-500 group-hover:text-sky-400 shrink-0" />
                        </a>
                    ))}
                </div>
            )}

            {/* Sign-up CTA in panel */}
            <div className="mt-auto p-4 border-t border-white/5 space-y-3">
                <div className="flex items-start gap-2.5 p-3 rounded-xl bg-indigo-500/8 border border-indigo-500/20">
                    <Sparkles className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                        Sign in to ask questions, expand connections, and explore the full knowledge graph.
                    </p>
                </div>
                <a href="/sign-up"
                    className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all">
                    Create free account →
                </a>
                <a href="/sign-in"
                    className="flex items-center justify-center gap-2 w-full py-2 rounded-xl text-slate-400 hover:text-white text-xs transition-colors">
                    Sign in
                </a>
            </div>
        </div>
    );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function GraphViewPage() {
    const params = useParams<{ token: string }>();
    const { user } = useUser();
    const { getToken } = useAuth();

    const [status, setStatus]       = useState<'loading' | 'ok' | 'error'>('loading');
    const [meta, setMeta]           = useState<GraphMeta | null>(null);
    const [graphData, setGraphData] = useState<{ nodes: any[]; links: any[] }>({ nodes: [], links: [] });
    const [selectedNode, setSelectedNode]           = useState<any | null>(null);
    const [isBentoHydrating, setIsBentoHydrating]  = useState(false);

    const bentoAbortRef  = useRef<AbortController | null>(null);
    const bentoCache     = useRef<Map<string, any>>(new Map());

    // Load the shared graph
    useEffect(() => {
        fetch(`${GATEWAY}/api/share/graph-link/${params.token}`)
            .then(async res => {
                if (!res.ok) { setStatus('error'); return; }
                const data = await res.json();
                setMeta(data.meta);
                // Tag all nodes so labels are always visible (not hover-only)
                const taggedNodes = (data.nodes || []).map((n: any) => ({ ...n, isBentoEligible: true }));
                setGraphData({ nodes: taggedNodes, links: data.links || [] });
                setStatus('ok');
            })
            .catch(() => setStatus('error'));
    }, [params.token]);

    // Bento hydration — only runs when the user is authenticated
    const hydrateNode = useCallback(async (freshNode: any) => {
        if (!user) return; // anonymous: no hydration, snapshot panel handles it
        bentoAbortRef.current?.abort();
        bentoAbortRef.current = new AbortController();

        const cacheKey = freshNode.node_id || freshNode.id || freshNode.name;
        if (bentoCache.current.has(cacheKey)) {
            setSelectedNode({ ...freshNode, ...bentoCache.current.get(cacheKey) });
            return;
        }

        setSelectedNode(freshNode);
        setIsBentoHydrating(true);
        try {
            const token = await getToken();
            const resp = await fetch(`${GATEWAY}/api/get_node_details`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ node_name: freshNode.name, node_id: freshNode.node_id }),
                signal: bentoAbortRef.current.signal,
            });
            if (resp.ok) {
                const results = await resp.json();
                const payload = Array.isArray(results)
                    ? results[0]
                    : (results.result?.content ? JSON.parse(results.result.content[0].text)[0] : results);
                if (payload && !payload.error) {
                    const p = payload.properties || payload;
                    const narratives = payload.narratives || (p.text ? [p.text] : (p.description ? [p.description] : []));
                    const hydratedDesc = narratives.length > 0
                        ? narratives.join('\n\n')
                        : (p.description && p.description.length > (freshNode.description?.length ?? 0) ? p.description : undefined);
                    const tech = payload.technologies || p.technologies || p.tech_stack || p.tools || freshNode.technologies;
                    const refLinks = payload.ref_urls || p.links || p.ref_urls || [];
                    const directLinks = [p.link, p.url].filter(Boolean);
                    const hydrated = {
                        ...p,
                        ...(hydratedDesc ? { description: hydratedDesc, text: hydratedDesc } : {}),
                        technologies: Array.isArray(tech) ? tech : (tech ? [tech] : []),
                        links: Array.from(new Set([...(freshNode.links || []), ...refLinks, ...directLinks])),
                        guests: payload.guests || [],
                    };
                    bentoCache.current.set(cacheKey, hydrated);
                    setSelectedNode((prev: any) => {
                        if (!prev || (prev.id !== freshNode.id && prev.name !== freshNode.name)) return prev;
                        return { ...prev, ...hydrated };
                    });
                }
            }
        } catch (e: any) {
            if (e?.name !== 'AbortError') console.error('[graph-view] Bento hydration failed:', e);
        } finally {
            setIsBentoHydrating(false);
        }
    }, [user, getToken]);

    const handleNodeClick = useCallback((node: any) => {
        setSelectedNode(node);
        if (user) hydrateNode(node);
    }, [user, hydrateNode]);

    const formattedDate = meta?.createdAt
        ? new Date(meta.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
        : '';

    return (
        <div className="min-h-screen bg-[#080a0f] text-white flex flex-col">
            {/* Header */}
            <header className="flex items-center justify-between px-6 py-3.5 border-b border-white/5 shrink-0">
                <div className="flex items-center gap-3">
                    <div className="w-6 h-6 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0">
                        <Lock className="w-3.5 h-3.5 text-white" />
                    </div>
                    <div>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-indigo-400">Shared Graph · Cortex-Drive</p>
                        {meta && (
                            <p className="text-xs text-slate-300 font-medium leading-tight mt-0.5">
                                {meta.title || 'Knowledge Graph'} — {meta.nodeCount} nodes
                            </p>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    {meta && (
                        <div className="hidden sm:flex items-center gap-3 text-[11px] text-slate-500">
                            <span className="flex items-center gap-1">
                                <Calendar className="w-3 h-3" />
                                {formattedDate}
                            </span>
                            <span>Shared by {meta.ownerName}</span>
                        </div>
                    )}
                    <a href={user ? '/dashboard' : '/sign-up'}
                        className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all whitespace-nowrap">
                        {user ? 'Open in Cortex-Drive' : 'Get Started →'}
                    </a>
                </div>
            </header>

            {/* Authenticated banner — contextual, non-intrusive */}
            {user && status === 'ok' && (
                <div className="flex items-center justify-between px-6 py-2 bg-indigo-950/60 border-b border-indigo-500/20 shrink-0">
                    <p className="text-[11px] text-indigo-300">
                        You're signed in. Click any node for full Bento details.
                    </p>
                    <a href="/dashboard"
                        className="text-[11px] text-indigo-400 hover:text-indigo-200 transition-colors font-bold">
                        Open Dashboard →
                    </a>
                </div>
            )}

            {/* Main */}
            <div className="flex-1 flex overflow-hidden relative">
                {status === 'loading' && (
                    <div className="flex-1 flex items-center justify-center">
                        <div className="flex flex-col items-center gap-3 text-slate-500">
                            <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
                            <p className="text-sm">Loading knowledge graph…</p>
                        </div>
                    </div>
                )}

                {status === 'error' && (
                    <div className="flex-1 flex items-center justify-center p-6">
                        <div className="flex flex-col items-center gap-4 max-w-sm text-center">
                            <div className="w-12 h-12 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
                                <Lock className="w-6 h-6 text-red-400" />
                            </div>
                            <div>
                                <h2 className="text-lg font-bold text-white mb-1">Link unavailable</h2>
                                <p className="text-sm text-slate-400">This link may have expired, been revoked, or is no longer valid.</p>
                            </div>
                            <a href="/" className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">Go to Cortex-Drive</a>
                        </div>
                    </div>
                )}

                {status === 'ok' && (
                    <>
                        {/* Graph canvas */}
                        <div className="flex-1 min-w-0">
                            <EnterpriseGraph
                                data={graphData}
                                onNodeClick={handleNodeClick}
                                viewMode="brain"
                            />
                        </div>

                        {/* Side panel — Bento for auth, Snapshot panel for anonymous */}
                        {selectedNode && (
                            <div className="absolute inset-y-0 right-0 z-40 pointer-events-auto">
                                {user ? (
                                    <BentoDetailPanel
                                        node={selectedNode}
                                        allNodes={graphData.nodes}
                                        allLinks={graphData.links}
                                        onClose={() => setSelectedNode(null)}
                                        isBentoHydrating={isBentoHydrating}
                                    />
                                ) : (
                                    <SnapshotPanel
                                        node={selectedNode}
                                        allNodes={graphData.nodes}
                                        allLinks={graphData.links}
                                        onClose={() => setSelectedNode(null)}
                                        onSelectNode={n => setSelectedNode(n)}
                                    />
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Footer — anonymous only: persistent sign-up nudge */}
            {!user && status === 'ok' && (
                <div className="shrink-0 border-t border-white/5 bg-[#0a0c13] px-6 py-3 flex items-center justify-between gap-4">
                    <p className="text-xs text-slate-500">
                        Read-only view · Sign in to query, expand connections, and explore the full knowledge graph.
                    </p>
                    <div className="flex items-center gap-2 shrink-0">
                        <a href="/sign-in"
                            className="px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-white border border-white/10 hover:border-white/20 transition-all">
                            Sign in
                        </a>
                        <a href="/sign-up"
                            className="px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all">
                            Create account →
                        </a>
                    </div>
                </div>
            )}
        </div>
    );
}
