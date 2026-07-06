"use client";

import React, { useEffect, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { Lock, ExternalLink, X, Calendar, Eye } from 'lucide-react';
import { useUser } from '@clerk/nextjs';

const EnterpriseGraph = dynamic(() => import('@/components/EnterpriseGraph'), { ssr: false });

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:4000';

interface NodeData {
    id: string;
    name: string;
    type: string;
    description?: string;
    links?: string[];
    link_titles?: string[];
}

interface GraphMeta {
    title?: string;
    ownerName: string;
    createdAt: string;
    nodeCount: number;
}

export default function GraphViewPage({ params }: { params: { token: string } }) {
    const { user } = useUser();
    const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
    const [meta, setMeta] = useState<GraphMeta | null>(null);
    const [graphData, setGraphData] = useState<{ nodes: any[]; links: any[] }>({ nodes: [], links: [] });
    const [selectedNode, setSelectedNode] = useState<NodeData | null>(null);

    useEffect(() => {
        fetch(`${GATEWAY}/api/share/graph-link/${params.token}`)
            .then(async res => {
                if (!res.ok) { setStatus('error'); return; }
                const data = await res.json();
                setMeta(data.meta);
                setGraphData({ nodes: data.nodes, links: data.links });
                setStatus('ok');
            })
            .catch(() => setStatus('error'));
    }, [params.token]);

    const handleNodeClick = useCallback((node: any) => {
        setSelectedNode(node as NodeData);
    }, []);

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
                    <a
                        href={user ? '/dashboard' : '/sign-in'}
                        className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all whitespace-nowrap"
                    >
                        {user ? 'Open in Cortex-Drive' : 'Sign In →'}
                    </a>
                </div>
            </header>

            {/* Main */}
            <div className="flex-1 flex overflow-hidden relative">
                {status === 'loading' && (
                    <div className="flex-1 flex items-center justify-center">
                        <div className="flex flex-col items-center gap-3 text-slate-500">
                            <div className="w-8 h-8 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin" />
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
                            <a href="/" className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
                                Go to Cortex-Drive
                            </a>
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

                        {/* Node detail drawer */}
                        {selectedNode && (
                            <div className="w-80 shrink-0 border-l border-white/5 bg-[#0b0d14] flex flex-col overflow-y-auto">
                                <div className="flex items-start justify-between p-4 border-b border-white/5">
                                    <div className="space-y-1 flex-1 min-w-0">
                                        <span className="inline-block text-[10px] font-bold uppercase tracking-wider text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 rounded-md">
                                            {selectedNode.type}
                                        </span>
                                        <h2 className="text-sm font-bold text-white leading-snug">{selectedNode.name}</h2>
                                    </div>
                                    <button
                                        onClick={() => setSelectedNode(null)}
                                        className="ml-2 p-1.5 rounded-lg hover:bg-white/5 text-slate-500 hover:text-white transition-all shrink-0"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>

                                {selectedNode.description && (
                                    <div className="p-4 border-b border-white/5">
                                        <p className="text-xs text-slate-300 leading-relaxed">{selectedNode.description}</p>
                                    </div>
                                )}

                                {selectedNode.links && selectedNode.links.length > 0 && (
                                    <div className="p-4 space-y-2">
                                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Resources</p>
                                        {selectedNode.links.map((url, i) => {
                                            const label = selectedNode.link_titles?.[i] || url;
                                            return (
                                                <a
                                                    key={i}
                                                    href={url}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 hover:border-sky-500/30 transition-all group"
                                                >
                                                    <span className="text-xs text-slate-300 group-hover:text-white truncate pr-3">{label}</span>
                                                    <ExternalLink className="w-3 h-3 text-slate-500 group-hover:text-sky-400 shrink-0" />
                                                </a>
                                            );
                                        })}
                                    </div>
                                )}

                                <div className="mt-auto p-4 border-t border-white/5">
                                    <p className="text-[10px] text-slate-600 text-center">Read-only view</p>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Footer CTA — only when no node is selected */}
            {status === 'ok' && !selectedNode && (
                <div className="shrink-0 border-t border-white/5 bg-[#0a0c13] px-6 py-3 flex items-center justify-between gap-4">
                    <p className="text-xs text-slate-500">
                        Read-only shared view. Sign in to query, expand, and explore the full knowledge graph.
                    </p>
                    <a
                        href={user ? '/dashboard' : '/sign-in'}
                        className="shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all whitespace-nowrap"
                    >
                        {user ? 'Open in Cortex-Drive →' : 'Sign In to Explore →'}
                    </a>
                </div>
            )}
        </div>
    );
}
