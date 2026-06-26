"use client";

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ExternalLink, Target, Cpu, History, MessageSquare, Share2, Network, Mic, CalendarDays, Tag, Hash } from 'lucide-react';
import ShareModal from './ShareModal';

// Node types that belong to the podcast domain — bento layout differs from career domain.
const PODCAST_DOMAIN_TYPES = new Set(['Episode', 'Podcast']);

// Relationship types that indicate a person appeared on or hosted an episode/podcast.
const APPEARANCE_RELS = new Set(['GUEST_ON', 'INTERVIEWED_BY', 'FEATURE_GUEST', 'HOSTS']);

// Node types that represent subject-matter tags on an episode.
const TOPIC_NODE_TYPES = new Set(['Topic', 'Technology', 'Concept']);

interface BentoDetailPanelProps {
    node: any | null;
    allNodes?: any[];
    allLinks?: any[];
    onClose: () => void;
    onDiscoverBridge?: (nodeId: string) => void;
    domainSignal?: string;
    isBentoHydrating?: boolean;
}

const BentoDetailPanel: React.FC<BentoDetailPanelProps> = ({ node, allNodes = [], allLinks = [], onClose, onDiscoverBridge, domainSignal, isBentoHydrating = false }) => {
    const [shareModalOpen, setShareModalOpen] = React.useState(false);

    // --- Shared derived data ---
    const displayLinks = React.useMemo(() => {
        // Build a url→title map from node.link_titles (parallel to node.links).
        const titleMap = new Map<string, string>();
        if (node && Array.isArray(node.links) && Array.isArray(node.link_titles)) {
            node.links.forEach((url: string, i: number) => {
                if (url && node.link_titles[i]) titleMap.set(url, node.link_titles[i]);
            });
        }
        // Also pick up titles from connected ReferenceLink nodes (name = title set by seeder).
        if (node && allNodes.length && allLinks.length) {
            const nodeId = node.id || node.name;
            const relatedIds = allLinks
                .filter(l => l.source === nodeId || l.target === nodeId)
                .map(l => l.source === nodeId ? l.target : l.source);
            allNodes
                .filter(n => relatedIds.includes(n.id) && (n.type === 'ReferenceLink' || n.labels?.includes('ReferenceLink')))
                .forEach(n => {
                    const url = n.url || n.link;
                    if (url && n.name && n.name !== url) titleMap.set(url, n.name);
                });
        }

        const urls = new Set<string>();
        if (node && Array.isArray(node.links)) node.links.forEach((l: string) => { if (l) urls.add(l); });
        if (node?.link) urls.add(node.link);
        if (node?.url) urls.add(node.url);

        const fallbackLabel = (url: string) =>
            url.includes('github.com') ? 'GitHub Repository' :
            url.includes('linkedin.com') || url.includes('lnkd.in') ? 'LinkedIn' :
            url.includes('infoq.com') ? 'InfoQ Publication' :
            url.includes('jpmorganchase.com') ? 'JPMorgan Chase Tech Blog' :
            url.includes('aws.amazon.com') ? 'AWS Case Study' :
            url.includes('medium.com') ? 'Engineering Blog' :
            url.includes('drive.proton.me') ? 'Secure Document (Proton)' :
            url.includes('sites.google.com') ? 'Project Website' :
            url.match(/\.(pdf|doc|docx)$/i) ? 'Whitepaper / Doc' :
            'External Resource';

        return Array.from(urls).map(url => ({
            url,
            label: titleMap.get(url) || fallbackLabel(url)
        }));
    }, [node, allNodes, allLinks]);

    // --- Career-domain derived data ---
    const careerLedger = React.useMemo(() => {
        if (!node || node.type !== 'Company') return [];
        const nodeId = node.id || node.name;
        return allLinks
            .filter(l => (l.target === nodeId || l.source === nodeId) && (l.type === 'HELD_ROLE' || l.title))
            .map(l => ({
                title: l.title || l.role || "Professional Role",
                dates: l.displayDate || (l.start && l.end ? `${l.start} - ${l.end}` : l.year || "Term Active"),
                epoch: l.startEpoch || 0
            }))
            .sort((a, b) => b.epoch - a.epoch);
    }, [node, allLinks]);

    // --- Podcast-domain derived data ---
    const podcastPeople = React.useMemo(() => {
        if (!node || !(domainSignal === 'podcast' || PODCAST_DOMAIN_TYPES.has(node.type))) return [];
        const nodeId = node.id || node.name;
        const connectedPairs = allLinks
            .filter(l => (l.source === nodeId || l.target === nodeId) && APPEARANCE_RELS.has(l.type));
        const seen = new Set<string>();
        const people: { name: string; role: string }[] = [];
        connectedPairs.forEach(l => {
            const peerId = l.source === nodeId ? l.target : l.source;
            const peer = allNodes.find(n => n.id === peerId && n.type === 'Person');
            if (peer && !seen.has(peerId)) {
                seen.add(peerId);
                const role = (l.type === 'HOSTS' || peer.role === 'Host') ? 'Host' : 'Guest';
                people.push({ name: peer.name, role });
            }
        });
        // Fall back to hydrated guests from get_node_details when episode hasn't been expanded yet.
        if (people.length === 0 && Array.isArray(node.guests)) {
            return node.guests.filter((g: any) => g?.name).map((g: any) => ({
                name: g.name,
                role: (g.role === 'HOSTS') ? 'Host' : 'Guest'
            }));
        }
        return people;
    }, [node, allNodes, allLinks]);

    const podcastTopics = React.useMemo(() => {
        if (!node || !(domainSignal === 'podcast' || PODCAST_DOMAIN_TYPES.has(node.type))) return [];
        const nodeId = node.id || node.name;
        const connectedIds = new Set(
            allLinks
                .filter(l => l.source === nodeId || l.target === nodeId)
                .map(l => l.source === nodeId ? l.target : l.source)
        );
        return allNodes.filter(n => connectedIds.has(n.id) && TOPIC_NODE_TYPES.has(n.type));
    }, [node, allNodes, allLinks]);

    const transcriptChunks = React.useMemo(() => {
        if (!node || !(domainSignal === 'podcast' || PODCAST_DOMAIN_TYPES.has(node.type))) return [];
        const nodeId = node.id || node.name;
        const chunkIds = new Set(
            allLinks
                .filter(l => (l.source === nodeId || l.target === nodeId) && l.type === 'HAS_CHUNK')
                .map(l => l.source === nodeId ? l.target : l.source)
        );
        return allNodes
            .filter(n => chunkIds.has(n.id) && n.type === 'Chunk')
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .slice(0, 2);
    }, [node, allNodes, allLinks]);

    // All hooks must be above this early return.
    if (!node) return null;

    // domainSignal from the active query is the primary discriminator — handles Person nodes
    // that exist in both domains. Fallback to node.type for cases where signal isn't set.
    const isPodcastDomain = domainSignal === 'podcast' || (!domainSignal && PODCAST_DOMAIN_TYPES.has(node.type));

    // --- Shared UI: header, resource gallery, knowledge bridge ---
    const header = (
        <header className="flex items-start justify-between mb-8">
            <div className="flex flex-col gap-1">
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-indigo-400 flex items-center gap-2">
                    {node.type} Context
                    <span className="text-[8px] text-slate-500 lowercase font-normal tracking-normal">(Double-click map to expand)</span>
                </span>
                <h2 className="text-2xl font-bold text-white tracking-tight leading-tight">{node.name}</h2>
            </div>
            <div className="flex items-center gap-2">
                <button
                    onClick={() => setShareModalOpen(true)}
                    className="p-2 rounded-xl transition-all flex items-center gap-2 text-xs font-bold uppercase tracking-wider bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 border border-transparent"
                >
                    <Share2 className="w-4 h-4" />Share
                </button>
                <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-xl transition-all text-slate-500 hover:text-white">
                    <X className="w-5 h-5" />
                </button>
            </div>
        </header>
    );

    const resourceGallery = displayLinks.length > 0 && (
        <div className="p-6 rounded-2xl bg-sky-500/5 border border-sky-500/10 flex flex-col gap-4">
            <div className="flex items-center gap-3 text-sky-400">
                <ExternalLink className="w-4 h-4" />
                <span className="text-xs font-semibold uppercase tracking-wider text-sky-300">Resource Gallery</span>
            </div>
            <div className="flex flex-col gap-2">
                {displayLinks.map((link, idx) => (
                    <a key={idx} href={link.url} target="_blank" rel="noopener noreferrer"
                        className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/5 hover:bg-white/10 hover:border-sky-500/30 transition-all group">
                        <span className="text-xs text-slate-300 group-hover:text-white truncate pr-4">{link.label}</span>
                        <ExternalLink className="w-3 h-3 text-slate-500 group-hover:text-sky-400 shrink-0" />
                    </a>
                ))}
            </div>
        </div>
    );

    const knowledgeBridge = (
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
    );

    const primaryActionLabel = isPodcastDomain
        ? (displayLinks.length === 1 ? 'Open Episode' : 'View Resources')
        : (displayLinks.length === 1 ? 'Open Resource' : 'View Resources');

    const footer = displayLinks.length > 0 && (
        <footer className="mt-8 pt-6 border-t border-white/5">
            <a href={displayLinks[0].url} target="_blank" rel="noopener noreferrer"
                className="w-full flex items-center justify-center gap-3 px-6 py-4 rounded-2xl bg-indigo-600 hover:bg-indigo-500 transition-all font-bold group shadow-lg shadow-indigo-600/20 text-white">
                {primaryActionLabel}
                <ExternalLink className="w-4 h-4 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
            </a>
        </footer>
    );

    return (
        <>
        <AnimatePresence>
            <motion.aside
                initial={{ x: '100%', opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: '100%', opacity: 0 }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                className="absolute right-0 top-0 bottom-0 w-[450px] bg-slate-950 backdrop-blur-xl border-l border-white/10 z-40 flex flex-col shadow-2xl p-8"
            >
                {header}

                <div className="flex-1 overflow-y-auto pr-2 space-y-4">
                    {isPodcastDomain ? (
                        // ── Podcast Domain Layout ──────────────────────────────
                        <>
                            {/* Episode / Podcast Summary */}
                            <div className="col-span-2 p-6 rounded-2xl bg-indigo-600/10 border border-indigo-500/10 flex flex-col gap-4">
                                <div className="flex items-center gap-3 text-indigo-300">
                                    <Target className="w-4 h-4" />
                                    <span className="text-xs font-semibold uppercase tracking-wider">
                                        {node.type === 'Podcast' ? 'About This Podcast' : 'Episode Summary'}
                                    </span>
                                    {isBentoHydrating && (
                                        <span className="ml-auto text-[9px] text-indigo-400/60 animate-pulse uppercase tracking-widest">loading…</span>
                                    )}
                                </div>
                                {isBentoHydrating ? (
                                    <div className="flex flex-col gap-2">
                                        <div className="animate-pulse h-3 rounded bg-white/10 w-full" />
                                        <div className="animate-pulse h-3 rounded bg-white/10 w-5/6" />
                                        <div className="animate-pulse h-3 rounded bg-white/10 w-4/6" />
                                    </div>
                                ) : (
                                    <p className="text-sm font-medium leading-relaxed text-slate-100 pr-1 max-h-48 overflow-y-auto">
                                        {node.description || 'No summary available.'}
                                    </p>
                                )}
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                {/* Guests / Hosts */}
                                <div className="p-5 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-3">
                                    <div className="flex items-center gap-3 text-emerald-400">
                                        <Mic className="w-4 h-4" />
                                        <span className="text-[10px] font-bold uppercase tracking-wider">
                                            {node.type === 'Podcast' ? 'Hosts' : 'Guests'}
                                        </span>
                                    </div>
                                    {podcastPeople.length > 0 ? (
                                        <div className="flex flex-col gap-2">
                                            {podcastPeople.map((p: { name: string; role: string }, i: number) => (
                                                <div key={i} className="flex items-center justify-between">
                                                    <span className="text-xs text-slate-100">{p.name}</span>
                                                    <span className="text-[9px] px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 uppercase tracking-wider">{p.role}</span>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="flex flex-col gap-1">
                                            <span className="text-slate-300 text-xs font-medium">No guests found</span>
                                        </div>
                                    )}
                                </div>

                                {/* Published Date / Episode Number */}
                                <div className="p-5 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-3">
                                    <div className="flex items-center gap-3 text-amber-400">
                                        <CalendarDays className="w-4 h-4" />
                                        <span className="text-[10px] font-bold uppercase tracking-wider">Published</span>
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        {node.number != null && (
                                            <div className="flex items-center gap-2 text-indigo-300">
                                                <Hash className="w-3 h-3" />
                                                <span className="text-sm font-bold">Episode {node.number}</span>
                                            </div>
                                        )}
                                        <span className="text-xl font-bold text-amber-200">
                                            {node.published_date || node.aired_date || node.published_at || '—'}
                                        </span>
                                        {!node.published_date && !node.aired_date && !node.published_at && (
                                            <span className="text-[10px] text-slate-500 italic">Date unavailable</span>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Topics & Concepts */}
                            {podcastTopics.length > 0 && (
                                <div className="p-5 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-3">
                                    <div className="flex items-center gap-3 text-teal-400">
                                        <Tag className="w-4 h-4" />
                                        <span className="text-[10px] font-bold uppercase tracking-wider">Topics & Concepts</span>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        {podcastTopics.map((t, i) => (
                                            <span key={i} className={`px-2 py-1 rounded-md text-[10px] font-mono border ${
                                                t.type === 'Technology'
                                                    ? 'bg-teal-500/10 border-teal-500/20 text-teal-400'
                                                    : t.type === 'Concept'
                                                    ? 'bg-violet-500/10 border-violet-500/20 text-violet-400'
                                                    : 'bg-sky-500/10 border-sky-500/20 text-sky-400'
                                            }`}>
                                                {t.name}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Transcript Highlights */}
                            {transcriptChunks.length > 0 && (
                                <div className="p-6 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-4">
                                    <div className="flex items-center gap-3 text-rose-400">
                                        <MessageSquare className="w-4 h-4" />
                                        <span className="text-xs font-semibold uppercase tracking-wider">Transcript Highlights</span>
                                    </div>
                                    <div className="flex flex-col gap-3">
                                        {transcriptChunks.map((chunk, i) => (
                                            <p key={i} className="text-slate-300 text-sm leading-relaxed border-l-2 border-rose-500/30 pl-3 italic">
                                                "{chunk.text?.slice(0, 220)}{chunk.text?.length > 220 ? '…' : ''}"
                                            </p>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {resourceGallery}
                            {knowledgeBridge}
                        </>
                    ) : (
                        // ── Career Domain Layout ───────────────────────────────
                        <>
                            <div className="grid grid-cols-2 gap-4">
                                {/* Impact Context */}
                                <div className="col-span-2 p-6 rounded-2xl bg-indigo-600/10 border border-indigo-500/10 flex flex-col gap-4">
                                    <div className="flex items-center gap-3 text-indigo-300">
                                        <Target className="w-4 h-4" />
                                        <span className="text-xs font-semibold uppercase tracking-wider">Impact Context</span>
                                    </div>
                                    <p className="text-sm font-medium leading-relaxed text-slate-100">
                                        {node.description || 'Metadata pending...'}
                                    </p>
                                </div>

                                {/* Core Stack */}
                                <div className="p-5 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-3">
                                    <div className="flex items-center gap-3 text-emerald-400">
                                        <Cpu className="w-4 h-4" />
                                        <span className="text-[10px] font-bold uppercase tracking-wider">Core Stack</span>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        {node.technologies ? (
                                            (Array.isArray(node.technologies) ? node.technologies : [node.technologies]).map((t: string) => (
                                                <span key={t} className="px-2 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-mono">{t}</span>
                                            ))
                                        ) : (
                                            <span className="text-slate-500 text-[10px] italic">
                                                {node.persona === 'structural' ? 'N/A for structural anchor.' : 'Metadata pending...'}
                                            </span>
                                        )}
                                    </div>
                                </div>

                                {/* Timeline */}
                                <div className="p-5 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-3">
                                    <div className="flex items-center gap-3 text-amber-400">
                                        <History className="w-4 h-4" />
                                        <span className="text-[10px] font-bold uppercase tracking-wider">Timeline</span>
                                    </div>
                                    <div className="flex flex-col">
                                        <span className="text-xl font-bold text-amber-200">
                                            {node.type === 'Episode' ? node.aired_date || node.year || '—' : node.displayDate || node.year || 'Active'}
                                        </span>
                                        <span className="text-[10px] text-slate-500 uppercase tracking-tighter">
                                            {node.type === 'Episode' ? 'Aired' : node.isPresent ? 'Currently Active' : node.startYear && node.endYear ? `${node.startYear} → ${node.endYear}` : 'Active Context'}
                                        </span>
                                    </div>
                                </div>

                                {/* Career Ledger (Company nodes only) */}
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

                            {resourceGallery}

                            {/* Narrative */}
                            <div className="p-6 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-4">
                                <div className="flex items-center gap-3 text-rose-400">
                                    <MessageSquare className="w-4 h-4" />
                                    <span className="text-xs font-semibold uppercase tracking-wider">Narrative</span>
                                </div>
                                <div className="text-slate-100 text-sm leading-relaxed space-y-3">
                                    {node.text ? (
                                        node.text.split('\n\n').map((para: string, i: number) => <p key={i}>{para}</p>)
                                    ) : (
                                        <p className="italic text-slate-500">
                                            {node.persona === 'structural'
                                                ? 'Structure nodes organize relationships; they do not contain distinct narratives.'
                                                : 'Narrative context is available for deeper audit. Click below to explore source data.'}
                                        </p>
                                    )}
                                </div>
                            </div>

                            {knowledgeBridge}
                        </>
                    )}
                </div>

                {footer}
            </motion.aside>
        </AnimatePresence>
        <ShareModal
            node={node}
            open={shareModalOpen}
            onClose={() => setShareModalOpen(false)}
        />
        </>
    );
};

export default BentoDetailPanel;
