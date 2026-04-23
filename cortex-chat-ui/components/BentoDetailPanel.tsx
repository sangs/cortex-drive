"use client";

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ExternalLink, Target, Cpu, MessageSquare, History, CheckCircle2, Share2, Check, Network } from 'lucide-react';

interface BentoDetailPanelProps {
    node: any | null;
    allNodes?: any[];
    allLinks?: any[];
    onClose: () => void;
    onDiscoverBridge?: (nodeId: string) => void;
}

const BentoDetailPanel: React.FC<BentoDetailPanelProps> = ({ node, allNodes = [], allLinks = [], onClose, onDiscoverBridge }) => {
    const [shareStatus, setShareStatus] = React.useState<'idle' | 'loading' | 'success'>('idle');
    
    const handleShare = async () => {
        if (!node) return;
        setShareStatus('loading');
        try {
            const nodeId = node.id || node.name;
            const response = await fetch(`/api/share?nodeId=${encodeURIComponent(nodeId)}`);
            const data = await response.json();
            
            if (data.shareUrl) {
                await navigator.clipboard.writeText(data.shareUrl);
                setShareStatus('success');
                setTimeout(() => setShareStatus('idle'), 3000);
            }
        } catch (err) {
            console.error("Failed to generate share link:", err);
            setShareStatus('idle');
        }
    };

    // 1. Hooks MUST be called before any early returns
    const displayLinks = React.useMemo(() => {
        const links = new Set<string>();
        
        if (node && Array.isArray(node.links)) {
            node.links.forEach((l: string) => { if (l) links.add(l); });
        }

        if (node?.link) links.add(node.link);
        if (node?.url) links.add(node.url);

        if (node && allNodes.length && allLinks.length) {
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

    const careerLedger = React.useMemo(() => {
        if (!node || node.type !== 'Company') return [];
        const nodeId = node.id || node.name;
        
        // Extract roles from relationship properties
        const roles = allLinks
            .filter(l => (l.target === nodeId || l.source === nodeId) && (l.type === 'HELD_ROLE' || l.title))
            .map(l => ({
                title: l.title || l.role || "Professional Role",
                dates: l.displayDate || (l.start && l.end ? `${l.start} - ${l.end}` : l.year || "Term Active"),
                epoch: l.startEpoch || 0
            }))
            .sort((a, b) => b.epoch - a.epoch); // Most recent first
            
        return roles;
    }, [node, allLinks]);

    // 2. Early return after all hooks
    if (!node) return null;

    const persona = node.persona || 'professional';
    const labels = node.ui_hints || {
        impact_label: "Impact Context",
        tech_label: "Core Stack",
        timeline_label: "Timeline",
        narrative_label: "Narrative",
        trace_label: "Trace",
        trace_sub_label: "Vetted Path",
        placeholder: "Metadata pending..."
    };

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
                        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-indigo-400 flex items-center gap-2">
                            {node.type} Context
                            <span className="text-[8px] text-slate-500 lowercase font-normal tracking-normal">(Double-click map to expand)</span>
                        </span>
                        <h2 className="text-2xl font-bold text-white tracking-tight leading-tight">
                            {node.name}
                        </h2>
                    </div>
                    <div className="flex items-center gap-2">
                        <button 
                            onClick={handleShare}
                            disabled={shareStatus === 'loading'}
                            className={`p-2 rounded-xl transition-all flex items-center gap-2 text-xs font-bold uppercase tracking-wider ${
                                shareStatus === 'success' 
                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/20' 
                                : 'bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 border border-transparent'
                            }`}
                        >
                            {shareStatus === 'success' ? (
                                <>
                                    <Check className="w-4 h-4" />
                                    Link Copied
                                </>
                            ) : (
                                <>
                                    <Share2 className="w-4 h-4" />
                                    Share
                                </>
                            )}
                        </button>
                        <button 
                            onClick={onClose}
                            className="p-2 hover:bg-white/5 rounded-xl transition-all text-slate-500 hover:text-white"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                </header>

                {/* The Bento Grid */}
                <div className="flex-1 overflow-y-auto pr-2 space-y-4">
                    
                    {/* Primary Merit Card (Full Width) */}
                    <div className="grid grid-cols-2 gap-4">
                        <div className="col-span-2 p-6 rounded-2xl bg-indigo-600/10 border border-indigo-500/10 flex flex-col gap-4">
                            <div className="flex items-center gap-3 text-indigo-300">
                                <Target className="w-4 h-4" />
                                <span className="text-xs font-semibold uppercase tracking-wider">{labels.impact_label}</span>
                            </div>
                            <p className="text-sm font-medium leading-relaxed text-slate-200">
                                {node.description || labels.placeholder}
                            </p>
                        </div>

                        {/* Tech Stack / Attribute Card */}
                        <div className="p-5 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-3">
                            <div className="flex items-center gap-3 text-emerald-400">
                                <Cpu className="w-4 h-4" />
                                <span className="text-[10px] font-bold uppercase tracking-wider">{labels.tech_label}</span>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {node.technologies ? (
                                    (Array.isArray(node.technologies) ? node.technologies : [node.technologies]).map((t: string) => (
                                        <span key={t} className="px-2 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-mono">
                                            {t}
                                        </span>
                                    ))
                                ) : (
                                    <span className="text-slate-500 text-[10px] italic">
                                        {persona === 'structural' ? "N/A for structural anchor." : "Metadata pending..."}
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Status / Year Card */}
                        <div className="p-5 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-3">
                            <div className="flex items-center gap-3 text-amber-400">
                                <History className="w-4 h-4" />
                                <span className="text-[10px] font-bold uppercase tracking-wider">{labels.timeline_label}</span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-xl font-bold text-amber-200">{node.aired_date || node.displayDate || node.year || "Active"}</span>
                                <span className="text-[10px] text-slate-500 uppercase tracking-tighter">
                                    {node.aired_date ? "Aired Date" : (node.isPresent ? "Currently Active" : (node.startYear && node.endYear ? `${node.startYear} → ${node.endYear}` : "Active Context"))}
                                </span>
                            </div>
                        </div>

                        {/* Career Ledger (Conditional for Companies) */}
                        {careerLedger.length > 0 && (
                            <div className="col-span-2 p-6 rounded-2xl bg-slate-800/40 border border-white/5 flex flex-col gap-4">
                                <div className="flex items-center gap-3 text-indigo-400">
                                    <History className="w-4 h-4" />
                                    <span className="text-xs font-semibold uppercase tracking-wider">Career Ledger</span>
                                </div>
                                <div className="space-y-4">
                                    {careerLedger.map((entry, idx) => (
                                        <div key={idx} className="flex flex-col border-l-2 border-indigo-500/30 pl-4 py-1 relative">
                                            <div className="absolute -left-[5px] top-2 w-2 h-2 rounded-full bg-indigo-500 shadow-sm shadow-indigo-500/50" />
                                            <span className="text-sm font-bold text-white leading-tight">{entry.title}</span>
                                            <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">{entry.dates}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
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
                            <span className="text-xs font-semibold uppercase tracking-wider">{labels.narrative_label}</span>
                        </div>
                        <div className="text-slate-300 text-sm leading-relaxed space-y-3">
                           {node.text ? (
                               node.text.split('\n\n').map((para: string, i: number) => (
                                   <p key={i}>{para}</p>
                               ))
                           ) : (
                               <p className="italic text-slate-500">
                                   {persona === 'structural' 
                                       ? "Structure nodes organize relationships; they do not contain distinct narratives." 
                                       : "Narrative context is available for deeper audit. Click below to explore source data."}
                               </p>
                           )}
                        </div>
                    </div>

                    {/* Bridge Discovery Trigger (The "Premium" Action) */}
                    <div className="p-6 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex flex-col gap-4">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3 text-indigo-400">
                                <Network className="w-4 h-4" />
                                <span className="text-xs font-bold uppercase tracking-widest text-indigo-300">Knowledge Bridge</span>
                            </div>
                            <span className="text-[8px] bg-indigo-500/20 px-2 py-0.5 rounded-full text-indigo-400 font-bold uppercase">GDS / Inferred</span>
                        </div>
                        <p className="text-[10px] text-slate-400 leading-relaxed italic">
                            Disparity discovery: Identify semantic anchors (shared tech/concepts) across disparate silos (Resume ↔ Podcast).
                        </p>
                        <button 
                            onClick={() => onDiscoverBridge?.(node.id || node.name)}
                            className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl bg-indigo-600/40 hover:bg-indigo-600 border border-indigo-500/40 text-white transition-all font-bold text-xs uppercase tracking-widest shadow-lg shadow-indigo-600/10"
                        >
                            Trigger Bridge Discovery
                        </button>
                    </div>
                </div>

                {/* Footer Action */}
                {displayLinks.length > 0 && (
                    <footer className="mt-8 pt-6 border-t border-white/5">
                        <a 
                            href={displayLinks[0].url} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="w-full flex items-center justify-center gap-3 px-6 py-4 rounded-2xl bg-indigo-600 hover:bg-indigo-500 transition-all font-bold group shadow-lg shadow-indigo-600/20 text-white"
                        >
                            {displayLinks.length === 1 ? 'Open Documentation' : 'View Primary Resource'}
                            <ExternalLink className="w-4 h-4 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                        </a>
                    </footer>
                )}
            </motion.aside>
        </AnimatePresence>
    );
};

export default BentoDetailPanel;
