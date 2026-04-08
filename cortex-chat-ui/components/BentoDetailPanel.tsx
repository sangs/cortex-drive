"use client";

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ExternalLink, Target, Cpu, MessageSquare, History, CheckCircle2 } from 'lucide-react';

interface BentoDetailPanelProps {
    node: any | null;
    allNodes?: any[];
    allLinks?: any[];
    onClose: () => void;
}

const BentoDetailPanel: React.FC<BentoDetailPanelProps> = ({ node, allNodes = [], allLinks = [], onClose }) => {
    if (!node) return null;

    // Detect Persona: Podcast vs Professional
    const isPodcast = node.type === 'Episode';
    const persona = isPodcast ? 'podcast' : 'professional';

    // Label Mapping
    const labels = {
        professional: {
            impact: "Professional Impact",
            tech: "Core Stack",
            timeline: "Tenure Window",
            narrative: "The \"Why\" (Professional Narrative)",
            trace: "Governance Trace",
            traceSub: "Vetted Architecture",
            placeholder: "Synthesizing professional impact metrics for this initiative..."
        },
        podcast: {
            impact: "Knowledge Takeaway",
            tech: "Discussed Tech",
            timeline: "Air Date",
            narrative: "Episode Hook (Insight)",
            trace: "Discovery Path",
            traceSub: "Knowledge Evolution",
            placeholder: "Extracting key technical insights from this episode transcript..."
        }
    }[persona];

    // Consolidate links from both the node.links array and any specific neighbor ReferenceLinks
    const displayLinks = React.useMemo(() => {
        const links = new Set<string>();
        
        // 1. Primary Source: Consolidated links array from backend
        if (Array.isArray(node.links)) {
            node.links.forEach((l: string) => { if (l) links.add(l); });
        }

        // 2. Fallbacks: Single link/url properties
        if (node.link) links.add(node.link);
        if (node.url) links.add(node.url);

        // 3. Legacy: Check neighbor nodes (ReferenceLink) - already filtered by backend but good for safety
        if (allNodes.length && allLinks.length) {
            const nodeId = node.id || node.name;
            const relatedIds = allLinks
                .filter(l => l.source === nodeId || l.target === nodeId)
                .map(l => l.source === nodeId ? l.target : l.source);
            
            allNodes
                .filter(n => relatedIds.includes(n.id) && (n.type === 'ReferenceLink' || n.labels?.includes('ReferenceLink')))
                .forEach(n => {
                    const url = n.url || n.link;
                    if (url) links.add(url);
                });
        }

        return Array.from(links).map(url => ({
            url,
            label: (url.includes('github.com')) ? 'GitHub Repository' :
                   (url.includes('linkedin.com') || url.includes('lnkd.in')) ? 'LinkedIn Profile' :
                   (url.includes('infoq.com')) ? 'InfoQ Publication' :
                   (url.includes('aws.amazon.com')) ? 'AWS Case Study' :
                   (url.includes('medium.com')) ? 'Engineering Blog' :
                   (url.includes('drive.proton.me')) ? 'Secure Document (Proton)' :
                   (url.includes('sites.google.com')) ? 'Project Website' :
                   url.match(/\.(pdf|doc|docx)$/i) ? 'Whitepaper / Doc' :
                   'External Resource'
        }));
    }, [node, allNodes, allLinks]);

    return (
        <AnimatePresence>
            <motion.aside
                initial={{ x: '100%', opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: '100%', opacity: 0 }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                className="absolute right-0 top-0 bottom-0 w-[450px] bg-slate-900/60 backdrop-blur-3xl border-l border-white/10 z-40 flex flex-col shadow-2xl p-8"
            >
                {/* Header */}
                <header className="flex items-start justify-between mb-8">
                    <div className="flex flex-col gap-1">
                        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-indigo-400">
                            {node.type} Context
                        </span>
                        <h2 className="text-2xl font-bold text-white tracking-tight leading-tight">
                            {node.name}
                        </h2>
                    </div>
                    <button 
                        onClick={onClose}
                        className="p-2 hover:bg-white/5 rounded-xl transition-all text-slate-500 hover:text-white"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </header>

                {/* The Bento Grid */}
                <div className="flex-1 overflow-y-auto pr-2 space-y-4">
                    
                    {/* Primary Merit Card (Full Width) */}
                    <div className="grid grid-cols-2 gap-4">
                        <div className="col-span-2 p-6 rounded-2xl bg-indigo-600/10 border border-indigo-500/10 flex flex-col gap-4">
                            <div className="flex items-center gap-3 text-indigo-300">
                                <Target className="w-4 h-4" />
                                <span className="text-xs font-semibold uppercase tracking-wider">{labels.impact}</span>
                            </div>
                            <p className="text-slate-200 text-sm leading-relaxed font-medium">
                                {node.description || labels.placeholder}
                            </p>
                        </div>

                        {/* Tech Stack / Attribute Card */}
                        <div className="p-5 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-3">
                            <div className="flex items-center gap-3 text-emerald-400">
                                <Cpu className="w-4 h-4" />
                                <span className="text-[10px] font-bold uppercase tracking-wider">{labels.tech}</span>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {node.technologies ? (
                                    (Array.isArray(node.technologies) ? node.technologies : [node.technologies]).map((t: string) => (
                                        <span key={t} className="px-2 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-mono">
                                            {t}
                                        </span>
                                    ))
                                ) : (
                                    <span className="text-slate-500 text-[10px] italic">Metadata pending...</span>
                                )}
                            </div>
                        </div>

                        {/* Status / Year Card */}
                        <div className="p-5 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-3">
                            <div className="flex items-center gap-3 text-amber-400">
                                <History className="w-4 h-4" />
                                <span className="text-[10px] font-bold uppercase tracking-wider">{labels.timeline}</span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-xl font-bold text-amber-200">{node.year || node.date?.split('-')[0] || "Active"}</span>
                                <span className="text-[10px] text-slate-500 uppercase tracking-tighter">{node.date || "Active Context"}</span>
                            </div>
                        </div>
                    </div>

                    {/* Resources / Links Gallery */}
                    {displayLinks.length > 0 && (
                        <div className="p-6 rounded-2xl bg-sky-500/5 border border-sky-500/10 flex flex-col gap-4">
                            <div className="flex items-center gap-3 text-sky-400">
                                <ExternalLink className="w-4 h-4" />
                                <span className="text-xs font-semibold uppercase tracking-wider text-sky-300">Resource Gallery</span>
                            </div>
                            <div className="flex flex-col gap-2">
                                {displayLinks.map((link, idx) => (
                                    <a 
                                        key={idx}
                                        href={link.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/5 hover:bg-white/10 hover:border-sky-500/30 transition-all group"
                                    >
                                        <span className="text-xs text-slate-300 group-hover:text-white truncate pr-4">
                                            {link.label}
                                        </span>
                                        <ExternalLink className="w-3 h-3 text-slate-500 group-hover:text-sky-400 shrink-0" />
                                    </a>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Narrative Card (Full Width) */}
                    <div className="p-6 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-4">
                        <div className="flex items-center gap-3 text-rose-400">
                            <MessageSquare className="w-4 h-4" />
                            <span className="text-xs font-semibold uppercase tracking-wider">{labels.narrative}</span>
                        </div>
                        <div className="text-slate-300 text-sm leading-relaxed space-y-3">
                           {node.text ? (
                               node.text.split('\n\n').map((para: string, i: number) => (
                                   <p key={i}>{para}</p>
                               ))
                           ) : (
                               <p className="italic text-slate-500">Narrative context is available for deeper audit. Click below to explore source data.</p>
                           )}
                        </div>
                    </div>

                    {/* Decision Trace / Relationship Hint */}
                    <div className="p-6 rounded-2xl bg-slate-400/5 border border-slate-700/20 flex items-center justify-between group cursor-help">
                        <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center">
                                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                            </div>
                            <div className="flex flex-col">
                                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{labels.trace}</span>
                                <span className="text-xs text-emerald-300 font-medium italic">{labels.traceSub}</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Footer Action */}
                <footer className="mt-8 pt-6 border-t border-white/5">
                    {displayLinks.length > 0 ? (
                        <a 
                            href={displayLinks[0].url} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="w-full flex items-center justify-center gap-3 px-6 py-4 rounded-2xl bg-indigo-600 hover:bg-indigo-500 transition-all font-bold group shadow-lg shadow-indigo-600/20 text-white"
                        >
                            {displayLinks.length === 1 ? 'Open Documentation' : 'View Primary Resource'}
                            <ExternalLink className="w-4 h-4 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                        </a>
                    ) : (
                        <button 
                            disabled
                            className="w-full flex items-center justify-center gap-3 px-6 py-4 rounded-2xl bg-white/5 border border-white/5 text-slate-500 font-bold opacity-50 cursor-not-allowed"
                        >
                            No External Link Available
                        </button>
                    )}
                </footer>
            </motion.aside>
        </AnimatePresence>
    );
};

export default BentoDetailPanel;
