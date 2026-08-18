"use client";

import React, { useEffect, useState, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { useUser, useAuth } from '@clerk/nextjs';
import {
    Lock, ExternalLink, X, Calendar, ChevronRight,
    Sparkles, Network, Loader2, Sun, Moon
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

// ── Snapshot panel (anonymous path) ─────────────────────────────────────────

function SnapshotPanel({
    node,
    allNodes,
    allLinks,
    onClose,
    onSelectNode,
    isDark,
}: {
    node: SnapshotNode;
    allNodes: SnapshotNode[];
    allLinks: SnapshotLink[];
    onClose: () => void;
    onSelectNode: (n: SnapshotNode) => void;
    isDark: boolean;
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
        const neighborIds = new Map<string, string>();
        allLinks.forEach(l => {
            if (l.source === nodeId && l.target !== nodeId) neighborIds.set(l.target, l.type || '');
            if (l.target === nodeId && l.source !== nodeId) neighborIds.set(l.source, l.type || '');
        });
        return allNodes
            .filter(n => neighborIds.has(n.id || n.node_id || n.name))
            .map(n => ({ ...n, _edgeType: neighborIds.get(n.id || n.node_id || n.name) || '' }));
    }, [node, allNodes, allLinks, nodeId]);

    const panel = isDark
        ? 'border-white/5  bg-[#0b0d14]'
        : 'border-slate-200 bg-white';
    const divider   = isDark ? 'border-white/5'  : 'border-slate-100';
    const heading   = isDark ? 'text-white'       : 'text-slate-900';
    const body      = isDark ? 'text-slate-300'   : 'text-slate-600';
    const meta      = isDark ? 'text-slate-500'   : 'text-slate-400';
    const closeBtn  = isDark ? 'hover:bg-white/5 text-slate-500 hover:text-white' : 'hover:bg-slate-100 text-slate-400 hover:text-slate-700';
    const chip      = isDark
        ? 'bg-white/5  hover:bg-indigo-500/15 border-white/5  hover:border-indigo-500/30 text-slate-300 hover:text-white'
        : 'bg-slate-50 hover:bg-indigo-50     border-slate-200 hover:border-indigo-200  text-slate-700 hover:text-indigo-700';
    const linkCard  = isDark
        ? 'bg-white/5 border-white/5 hover:bg-white/10 hover:border-sky-500/30 text-slate-300 hover:text-white'
        : 'bg-slate-50 border-slate-100 hover:bg-indigo-50 hover:border-indigo-200 text-slate-700 hover:text-slate-900';
    const ctaBox    = isDark ? 'bg-indigo-500/8  border-indigo-500/20 text-slate-400'  : 'bg-indigo-50 border-indigo-100 text-slate-500';
    const ctaFooter = isDark ? 'border-white/5'  : 'border-slate-100';

    return (
        <div className={`w-80 shrink-0 border-l ${panel} flex flex-col overflow-y-auto`}>
            {/* Header */}
            <div className={`flex items-start justify-between p-4 border-b ${divider} gap-2`}>
                <div className="space-y-1.5 flex-1 min-w-0">
                    <span className="inline-block text-[10px] font-bold uppercase tracking-wider text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 rounded-md">
                        {node.type}
                    </span>
                    <h2 className={`text-sm font-bold leading-snug ${heading}`}>{node.name}</h2>
                </div>
                <button onClick={onClose} className={`ml-1 p-1.5 rounded-lg transition-all shrink-0 ${closeBtn}`}>
                    <X className="w-4 h-4" />
                </button>
            </div>

            {/* Description */}
            {node.description && (
                <div className={`p-4 border-b ${divider}`}>
                    <p className={`text-xs leading-relaxed ${body}`}>{node.description}</p>
                </div>
            )}

            {/* Neighbors */}
            {neighbors.length > 0 && (
                <div className={`p-4 border-b ${divider} space-y-2`}>
                    <p className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1 ${meta}`}>
                        <Network className="w-3 h-3" />
                        {neighbors.length} Connection{neighbors.length !== 1 ? 's' : ''} in this graph
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                        {neighbors.map(n => (
                            <button
                                key={n.id || n.node_id || n.name}
                                onClick={() => onSelectNode(n)}
                                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border transition-all group max-w-full ${chip}`}>
                                <span className="text-[9px] font-bold uppercase tracking-wide text-indigo-500 shrink-0">
                                    {n.type}
                                </span>
                                <ChevronRight className="w-2.5 h-2.5 text-slate-400 shrink-0" />
                                <span className="text-[11px] truncate">{n.name}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Resource links */}
            {displayLinks.length > 0 && (
                <div className="p-4 space-y-2">
                    <p className={`text-[10px] font-bold uppercase tracking-widest ${meta}`}>Resources</p>
                    {displayLinks.map(({ url, label }) => (
                        <a key={url} href={url} target="_blank" rel="noopener noreferrer"
                            className={`flex items-center justify-between p-3 rounded-xl border transition-all group ${linkCard}`}>
                            <span className="text-xs truncate pr-3">{label}</span>
                            <ExternalLink className="w-3 h-3 text-slate-400 group-hover:text-sky-500 shrink-0" />
                        </a>
                    ))}
                </div>
            )}

            {/* Sign-up CTA */}
            <div className={`mt-auto p-4 border-t ${ctaFooter} space-y-3`}>
                <div className={`flex items-start gap-2.5 p-3 rounded-xl border ${ctaBox}`}>
                    <Sparkles className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                    <p className="text-[11px] leading-relaxed">
                        Sign in to ask questions, expand connections, and explore the full knowledge graph.
                    </p>
                </div>
                <a href="/sign-up"
                    className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all">
                    Create free account →
                </a>
                <a href="/sign-in"
                    className={`flex items-center justify-center gap-2 w-full py-2 rounded-xl text-xs transition-colors ${isDark ? 'text-slate-400 hover:text-white' : 'text-slate-500 hover:text-slate-800'}`}>
                    Sign in
                </a>
            </div>
        </div>
    );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function GraphViewPage() {
    const params = useParams<{ token: string }>();
    const { user }     = useUser();
    const { getToken } = useAuth();

    const [status, setStatus]       = useState<'loading' | 'ok' | 'error'>('loading');
    const [meta, setMeta]           = useState<GraphMeta | null>(null);
    const [graphData, setGraphData] = useState<{ nodes: any[]; links: any[] }>({ nodes: [], links: [] });
    const [selectedNode, setSelectedNode]          = useState<any | null>(null);
    const [isBentoHydrating, setIsBentoHydrating] = useState(false);
    const [isDark, setIsDark]                      = useState(false); // light by default

    const bentoAbortRef = useRef<AbortController | null>(null);
    const bentoCache    = useRef<Map<string, any>>(new Map());

    useEffect(() => {
        fetch(`${GATEWAY}/api/share/graph-link/${params.token}`)
            .then(async res => {
                if (!res.ok) { setStatus('error'); return; }
                const data = await res.json();
                setMeta(data.meta);
                const taggedNodes = (data.nodes || []).map((n: any) => ({ ...n, isBentoEligible: true }));
                setGraphData({ nodes: taggedNodes, links: data.links || [] });
                setStatus('ok');
            })
            .catch(() => setStatus('error'));
    }, [params.token]);

    const hydrateNode = useCallback(async (freshNode: any) => {
        if (!user) return;
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
                    // combined_narrative (2026-08-06) — authored PreparatoryNote content plus
                    // inferred structural context, inline-labeled "Authored:"/"Inferred from
                    // graph:". Preferred over the raw description fallback (see
                    // documents/architecture/node-context-inference-2026-08-03.md §5 addendum).
                    const hydratedDesc = payload.combined_narrative
                        || (Array.isArray(payload.narratives) && payload.narratives.length > 0
                            ? payload.narratives.join('\n\n')
                            : (p.description && p.description.length > (freshNode.description?.length ?? 0) ? p.description : undefined));
                    const tech = payload.technologies || p.technologies || p.tech_stack || p.tools || freshNode.technologies;
                    const refLinks = payload.ref_urls || p.links || p.ref_urls || [];
                    const directLinks = [p.link, p.url].filter(Boolean);
                    const hydrated = {
                        ...p,
                        ...(hydratedDesc ? { description: hydratedDesc, text: hydratedDesc } : {}),
                        technologies: Array.isArray(tech) ? tech : (tech ? [tech] : []),
                        links: Array.from(new Set([...(freshNode.links || []), ...refLinks, ...directLinks])),
                        guests: payload.guests || [],
                        // Inferred structural context (2026-08-03) — complementary to `text` above,
                        // not a replacement. Rendered as a separate labeled block in BentoDetailPanel.
                        ...(payload.context_summary ? {
                            context_summary: payload.context_summary,
                            context_provenance: payload.context_provenance
                        } : {})
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

    // ── Theme-conditional class sets ─────────────────────────────────────────
    const page    = isDark ? 'bg-[#080a0f] text-white'    : 'bg-slate-50  text-slate-900';
    const header  = isDark ? 'border-white/5  bg-[#080a0f]' : 'border-slate-200 bg-white shadow-sm';
    const hdrMeta = isDark ? 'text-slate-500'              : 'text-slate-400';
    const hdrSub  = isDark ? 'text-slate-300'              : 'text-slate-600';
    const footer  = isDark ? 'border-white/5  bg-[#0a0c13]' : 'border-slate-200 bg-white';
    const canvas  = isDark ? 'bg-[#080a0f]'                : 'bg-slate-50';

    return (
        <div className={`min-h-screen flex flex-col transition-colors duration-200 ${page}`}>
            {/* Header */}
            <header className={`flex items-center justify-between px-6 py-3.5 border-b shrink-0 ${header}`}>
                <div className="flex items-center gap-3">
                    <div className="w-6 h-6 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0">
                        <Lock className="w-3.5 h-3.5 text-white" />
                    </div>
                    <div>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-indigo-500">Shared Graph · Cortex-Drive</p>
                        {meta && (
                            <p className={`text-xs font-medium leading-tight mt-0.5 ${hdrSub}`}>
                                {meta.title || 'Knowledge Graph'} — {meta.nodeCount} nodes
                            </p>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {meta && (
                        <div className={`hidden sm:flex items-center gap-3 text-[11px] ${hdrMeta}`}>
                            <span className="flex items-center gap-1">
                                <Calendar className="w-3 h-3" />
                                {formattedDate}
                            </span>
                            <span>Shared by {meta.ownerName}</span>
                        </div>
                    )}
                    {/* Theme toggle */}
                    <button
                        onClick={() => setIsDark(d => !d)}
                        className={`p-2 rounded-xl border transition-all ${isDark
                            ? 'bg-white/5 border-white/10 text-slate-400 hover:text-white hover:bg-white/10'
                            : 'bg-white border-slate-200 text-slate-400 hover:text-slate-700 hover:border-slate-300'}`}
                        title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}>
                        {isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
                    </button>
                    <a href={user ? '/dashboard' : '/sign-up'}
                        className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all whitespace-nowrap">
                        {user ? 'Open in Cortex-Drive' : 'Get Started →'}
                    </a>
                </div>
            </header>

            {/* Authenticated banner */}
            {user && status === 'ok' && (
                <div className="flex items-center justify-between px-6 py-2 bg-indigo-50 border-b border-indigo-100 shrink-0">
                    <p className="text-[11px] text-indigo-600">
                        You're signed in — click any node for full details.
                    </p>
                    <a href="/dashboard" className="text-[11px] text-indigo-600 hover:text-indigo-800 transition-colors font-bold">
                        Open Dashboard →
                    </a>
                </div>
            )}

            {/* Main */}
            <div className="flex-1 flex overflow-hidden relative">
                {status === 'loading' && (
                    <div className="flex-1 flex items-center justify-center">
                        <div className="flex flex-col items-center gap-3">
                            <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
                            <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Loading knowledge graph…</p>
                        </div>
                    </div>
                )}

                {status === 'error' && (
                    <div className="flex-1 flex items-center justify-center p-6">
                        <div className="flex flex-col items-center gap-4 max-w-sm text-center">
                            <div className="w-12 h-12 rounded-2xl bg-red-50 border border-red-200 flex items-center justify-center">
                                <Lock className="w-6 h-6 text-red-400" />
                            </div>
                            <div>
                                <h2 className={`text-lg font-bold mb-1 ${isDark ? 'text-white' : 'text-slate-900'}`}>Link unavailable</h2>
                                <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                    This link may have expired, been revoked, or is no longer valid.
                                </p>
                            </div>
                            <a href="/" className="text-xs text-indigo-500 hover:text-indigo-600 transition-colors">Go to Cortex-Drive</a>
                        </div>
                    </div>
                )}

                {status === 'ok' && (
                    <>
                        <div className={`flex-1 min-w-0 ${canvas}`}>
                            <EnterpriseGraph
                                data={graphData}
                                onNodeClick={handleNodeClick}
                                viewMode="brain"
                            />
                        </div>

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
                                        isDark={isDark}
                                    />
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Footer — anonymous only */}
            {!user && status === 'ok' && (
                <div className={`shrink-0 border-t px-6 py-3 flex items-center justify-between gap-4 ${footer}`}>
                    <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                        Read-only view · Sign in to query, expand connections, and explore the full knowledge graph.
                    </p>
                    <div className="flex items-center gap-2 shrink-0">
                        <a href="/sign-in"
                            className={`px-3 py-1.5 rounded-lg text-xs border transition-all ${isDark
                                ? 'text-slate-400 hover:text-white border-white/10 hover:border-white/20'
                                : 'text-slate-500 hover:text-slate-800 border-slate-200 hover:border-slate-300'}`}>
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
