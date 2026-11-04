"use client";

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ExternalLink, Target, Cpu, History, MessageSquare, Share2, Network, Mic, CalendarDays, Tag, Hash, Radio, Loader2, FileText, ListTree } from 'lucide-react';
import { useAuth } from '@clerk/nextjs';
import ShareModal from './ShareModal';
import { useCapabilities } from '@/hooks/use-capabilities';
import type { BridgeOptions } from '@/utils/bridgeTypes';
import { groupHalfSections, type PanelSection } from '@/utils/graphConstants';

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:4000';

// Layout (design 2026-11-03 §4.2): the server picks the sections for a node from its labels
// (domain_registry.PANEL_LAYOUTS) and returns them as `panel_layout`; this panel only knows how to draw
// each section (PANEL_SECTIONS below) and holds no node-type lists. Used before the details arrive or
// with an older server that sends no layout:
const PANEL_FALLBACK_SECTIONS: PanelSection[] = [
    { id: 'description', title: 'Summary' }, { id: 'narrative', title: 'Narrative' },
    { id: 'resources', title: 'Resource Gallery' }, { id: 'bridge', title: 'Knowledge Bridge' },
];
const PANEL_DEFAULT_PRIMARY_ACTION = 'Open Resource';

// Relationship types that indicate a person appeared on or hosted an episode/podcast.
const APPEARANCE_RELS = new Set(['GUEST_ON', 'INTERVIEWED_BY', 'FEATURE_GUEST', 'HOSTS']);

// Node types that represent subject-matter tags on an episode.
const TOPIC_NODE_TYPES = new Set(['Topic', 'Technology', 'Concept']);

interface BentoDetailPanelProps {
    node: any | null;
    allNodes?: any[];
    allLinks?: any[];
    onClose: () => void;
    onDiscoverBridge?: (nodeId: string, domains: string[]) => void;
    // Bridge target domains from the server (list_bridge_domains); null until loaded.
    bridgeOptions?: BridgeOptions | null;
    isBentoHydrating?: boolean;
}

const BentoDetailPanel: React.FC<BentoDetailPanelProps> = ({ node, allNodes = [], allLinks = [], onClose, onDiscoverBridge, bridgeOptions = null, isBentoHydrating = false }) => {
    const [shareModalOpen, setShareModalOpen] = React.useState(false);
    // Selected bridge target domains: [auto] by default; picking a domain replaces Auto, clearing
    // every domain returns to Auto. Ids come from the server; the panel holds no domain list.
    const [bridgeSelection, setBridgeSelection] = React.useState<string[]>([]);
    const bridgeAuto = bridgeOptions?.auto ?? null;
    const selectedBridgeDomains = bridgeSelection.length ? bridgeSelection : (bridgeAuto ? [bridgeAuto] : []);
    const toggleBridgeDomain = (id: string) => setBridgeSelection(prev => {
        if (id === bridgeAuto) return [];
        const next = prev.includes(id) ? prev.filter(d => d !== id) : [...prev, id];
        return next;
    });
    const { getToken } = useAuth();
    const caps = useCapabilities();   // S2-69: Share only for users who can own nodes

    // --- A1: on-demand live re-fetch for WebsiteSource nodes ---
    const [liveContent, setLiveContent] = React.useState<{ content: string; image_urls: string[] } | null>(null);
    const [liveLoading, setLiveLoading] = React.useState(false);
    const [liveError, setLiveError] = React.useState('');

    const handleViewLive = React.useCallback(async () => {
        if (!node?.base_url) return;
        setLiveLoading(true);
        setLiveError('');
        try {
            const token = await getToken();
            const resp = await fetch(`${GATEWAY}/api/view_source_live`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify({ url: node.base_url }),
            });
            const data = await resp.json();
            const payload = data.content?.[0]?.text ? JSON.parse(data.content[0].text) : data;
            if (payload.error) {
                setLiveError(payload.error);
            } else {
                setLiveContent({ content: payload.content, image_urls: payload.image_urls || [] });
            }
        } catch (e: any) {
            setLiveError(e?.message || 'Failed to fetch live content.');
        } finally {
            setLiveLoading(false);
        }
    }, [node, getToken]);

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
        if (!node) return [];
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

    // --- People / topics / excerpts linked to the node on screen (shown only where the layout has them) ---
    const podcastPeople = React.useMemo(() => {
        if (!node) return [];
        const nodeId = node.id || node.name;
        const connectedPairs = allLinks
            .filter(l => (l.source === nodeId || l.target === nodeId) && APPEARANCE_RELS.has(l.type));
        const seen = new Set<string>();
        const people: { name: string; role: string }[] = [];
        connectedPairs.forEach(l => {
            const peerId = l.source === nodeId ? l.target : l.source;
            const peer = allNodes.find(n => n.id === peerId && n.type === 'Person' && !n.isGrouper);
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
        if (!node) return [];
        const nodeId = node.id || node.name;
        const connectedIds = new Set(
            allLinks
                .filter(l => l.source === nodeId || l.target === nodeId)
                .map(l => l.source === nodeId ? l.target : l.source)
        );
        // Group nodes ("Topics (4)") carry their members' type; they are not topics themselves.
        return allNodes.filter(n => connectedIds.has(n.id) && TOPIC_NODE_TYPES.has(n.type) && !n.isGrouper);
    }, [node, allNodes, allLinks]);

    const transcriptChunks = React.useMemo(() => {
        if (!node) return [];
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

    const layout: { sections?: PanelSection[]; primary_action?: string } | undefined = node.panel_layout;
    const sections: PanelSection[] = Array.isArray(layout?.sections) && layout.sections.length
        ? layout.sections
        : (isBentoHydrating ? PANEL_FALLBACK_SECTIONS.filter(sec => sec.id === 'description' || sec.id === 'narrative')
                            : PANEL_FALLBACK_SECTIONS);

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
                {caps.share && (
                <button
                    onClick={() => setShareModalOpen(true)}
                    className="p-2 rounded-xl transition-all flex items-center gap-2 text-xs font-bold uppercase tracking-wider bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 border border-transparent"
                >
                    <Share2 className="w-4 h-4" />Share
                </button>
                )}
                <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-xl transition-all text-slate-500 hover:text-white">
                    <X className="w-5 h-5" />
                </button>
            </div>
        </header>
    );

    const resourceGallery = (title: string) => displayLinks.length > 0 && (
        <div className="p-6 rounded-2xl bg-sky-500/5 border border-sky-500/10 flex flex-col gap-4">
            <div className="flex items-center gap-3 text-sky-400">
                <ExternalLink className="w-4 h-4" />
                <span className="text-xs font-semibold uppercase tracking-wider text-sky-300">{title}</span>
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

    // --- A1/A2: live re-fetch + captured diagram images, for nodes with a registered base_url ---
    const websiteSourceCard = (title: string) => node.base_url && (
        <div className="p-6 rounded-2xl bg-teal-500/5 border border-teal-500/10 flex flex-col gap-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 text-teal-400">
                    <Radio className="w-4 h-4" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-teal-300">{title}</span>
                </div>
                <button
                    onClick={handleViewLive}
                    disabled={liveLoading}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-teal-500/10 hover:bg-teal-500/20 border border-teal-500/20 text-teal-300 text-[10px] font-bold uppercase tracking-wider transition-all disabled:opacity-50"
                >
                    {liveLoading && <Loader2 className="w-3 h-3 animate-spin" />}
                    {liveLoading ? 'Fetching…' : 'View Live'}
                </button>
            </div>

            {Array.isArray(node.image_urls) && node.image_urls.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1">
                    {node.image_urls.map((src: string, i: number) => (
                        <img key={i} src={src} alt="" className="h-16 w-16 object-cover rounded-lg border border-white/10 shrink-0" />
                    ))}
                </div>
            )}

            {liveError && <p className="text-[10px] text-rose-400 italic">{liveError}</p>}

            {liveContent && (
                <div className="flex flex-col gap-3">
                    {liveContent.image_urls.length > 0 && (
                        <div className="flex gap-2 overflow-x-auto pb-1">
                            {liveContent.image_urls.map((src, i) => (
                                <img key={i} src={src} alt="" className="h-16 w-16 object-cover rounded-lg border border-white/10 shrink-0" />
                            ))}
                        </div>
                    )}
                    <p className="text-xs text-slate-300 leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap">
                        {liveContent.content}
                    </p>
                </div>
            )}
        </div>
    );

    // Narrative (design 2026-11-03 §3.2 A): panel_narrative is the node's authored notes plus a
    // plain-language summary of what it connects to and what it shares with the nodes on screen, with
    // inline "Authored:"/"Inferred from graph:" labels. combined_narrative is the fallback from an older
    // server. Rendered as plain paragraphs, so this stays uncoupled from the backend's exact wording.
    const narrativeText: string | undefined = node.panel_narrative || node.combined_narrative || node.text;
    const narrativeBlock = (title: string) => (
        <div className="p-6 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-4">
            <div className="flex items-center gap-3 text-rose-400">
                <MessageSquare className="w-4 h-4" />
                <span className="text-xs font-semibold uppercase tracking-wider">{title}</span>
                {isBentoHydrating && (
                    <span className="ml-auto text-[9px] text-rose-400/60 animate-pulse uppercase tracking-widest">loading…</span>
                )}
            </div>
            <div className="text-slate-100 text-sm leading-relaxed space-y-3">
                {isBentoHydrating ? (
                    // Same skeleton as the podcast summary box: the summary is still being fetched.
                    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading narrative">
                        <div className="animate-pulse h-3 rounded bg-white/10 w-full" />
                        <div className="animate-pulse h-3 rounded bg-white/10 w-5/6" />
                        <div className="animate-pulse h-3 rounded bg-white/10 w-4/6" />
                    </div>
                ) : narrativeText ? (
                    narrativeText.split('\n\n').map((para: string, i: number) => <p key={i}>{para}</p>)
                ) : (
                    <p className="italic text-slate-500">
                        {node.persona === 'structural'
                            ? 'Structure nodes organize relationships; they do not contain distinct narratives.'
                            : 'Narrative context is available for deeper audit. Click below to explore source data.'}
                    </p>
                )}
            </div>
        </div>
    );

    // Rendered only where a bridge handler exists (the guest graph-view page passes none).
    const knowledgeBridge = (title: string) => onDiscoverBridge ? (
        <div className="p-6 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex flex-col gap-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 text-indigo-400">
                    <Network className="w-4 h-4" />
                    <span className="text-xs font-bold uppercase tracking-widest text-indigo-300">{title}</span>
                </div>
                <span className="text-[8px] bg-indigo-500/20 px-2 py-0.5 rounded-full text-indigo-400 font-bold uppercase">Shortest-Path / Inferred</span>
            </div>
            <p className="text-[10px] text-slate-400 leading-relaxed italic">
                Trace the shortest connected path (via any relationship) from this node into other domains.
                Auto searches every domain except this node&apos;s own.
            </p>
            {bridgeOptions && bridgeAuto && (
                <div className="flex flex-wrap gap-2" role="group" aria-label="Bridge target domains">
                    {[{ id: bridgeAuto, display_name: 'Auto', has_visible_content: true }, ...bridgeOptions.domains].map(d => {
                        const selected = selectedBridgeDomains.includes(d.id);
                        return (
                            <button
                                key={d.id}
                                type="button"
                                onClick={() => toggleBridgeDomain(d.id)}
                                disabled={!d.has_visible_content}
                                aria-pressed={selected}
                                title={!d.has_visible_content ? `Nothing you can see in ${d.display_name}` : undefined}
                                className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border transition-all ${
                                    selected
                                        ? 'bg-indigo-500 border-indigo-400 text-white'
                                        : 'bg-transparent border-indigo-500/30 text-indigo-300 hover:border-indigo-400'
                                } disabled:opacity-30 disabled:cursor-not-allowed`}
                            >
                                {d.display_name}
                            </button>
                        );
                    })}
                </div>
            )}
            <button
                onClick={() => onDiscoverBridge(node.node_id || node.id || node.name, selectedBridgeDomains)}
                className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl bg-indigo-600/40 hover:bg-indigo-600 border border-indigo-500/40 text-white transition-all font-bold text-xs uppercase tracking-widest shadow-lg shadow-indigo-600/10"
            >
                Trigger Bridge Discovery
            </button>
        </div>
    ) : null;

    const primaryActionLabel = displayLinks.length === 1
        ? (layout?.primary_action || PANEL_DEFAULT_PRIMARY_ACTION)
        : 'View Resources';

    const footer = displayLinks.length > 0 && (
        <footer className="mt-8 pt-6 border-t border-white/5">
            <a href={displayLinks[0].url} target="_blank" rel="noopener noreferrer"
                className="w-full flex items-center justify-center gap-3 px-6 py-4 rounded-2xl bg-indigo-600 hover:bg-indigo-500 transition-all font-bold group shadow-lg shadow-indigo-600/20 text-white">
                {primaryActionLabel}
                <ExternalLink className="w-4 h-4 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
            </a>
        </footer>
    );

    const skeleton = (
        <div className="flex flex-col gap-2" aria-busy="true">
            <div className="animate-pulse h-3 rounded bg-white/10 w-full" />
            <div className="animate-pulse h-3 rounded bg-white/10 w-5/6" />
            <div className="animate-pulse h-3 rounded bg-white/10 w-4/6" />
        </div>
    );
    const hasText = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
    const publishedDate = node.published_date || node.aired_date || node.published_at;
    const timelineDate = node.displayDate || node.year;
    const outline: { sections?: { title: string; page_start?: number | null }[]; total?: number } | undefined = node.outline;
    const technologies: string[] = node.technologies
        ? (Array.isArray(node.technologies) ? node.technologies : [node.technologies]) : [];
    const sourceFacts = ([
        ['File', node.filename], ['Type', node.mime_type], ['Pages', node.page_count],
        ['Last synced', typeof node.last_synced_at === 'string' ? node.last_synced_at.slice(0, 10) : null],
    ] as [string, unknown][]).filter(([, v]) => v !== undefined && v !== null && v !== '') as [string, string | number][];

    // One renderer per section id (domain_registry.PANEL_SECTION_IDS; a test keeps the two equal). A
    // renderer returns nothing when it has no data for this node and user, which hides the section.
    const PANEL_SECTIONS: Record<string, (title: string) => React.ReactNode> = {
        'description': (title) => (hasText(node.description) || isBentoHydrating) && (
            <div className="p-6 rounded-2xl bg-indigo-600/10 border border-indigo-500/10 flex flex-col gap-4">
                <div className="flex items-center gap-3 text-indigo-300">
                    <Target className="w-4 h-4" />
                    <span className="text-xs font-semibold uppercase tracking-wider">{title}</span>
                    {isBentoHydrating && (
                        <span className="ml-auto text-[9px] text-indigo-400/60 animate-pulse uppercase tracking-widest">loading…</span>
                    )}
                </div>
                {isBentoHydrating && !hasText(node.description) ? skeleton : (
                    <p className="text-sm font-medium leading-relaxed text-slate-100 pr-1 max-h-48 overflow-y-auto">{node.description}</p>
                )}
            </div>
        ),
        'people': (title) => podcastPeople.length > 0 && (
            <div className="p-5 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-3">
                <div className="flex items-center gap-3 text-emerald-400">
                    <Mic className="w-4 h-4" />
                    <span className="text-[10px] font-bold uppercase tracking-wider">{title}</span>
                </div>
                <div className="flex flex-col gap-2">
                    {podcastPeople.map((p: { name: string; role: string }, i: number) => (
                        <div key={i} className="flex items-center justify-between">
                            <span className="text-xs text-slate-100">{p.name}</span>
                            <span className="text-[9px] px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 uppercase tracking-wider">{p.role}</span>
                        </div>
                    ))}
                </div>
            </div>
        ),
        'published': (title) => (publishedDate || node.number != null) && (
            <div className="p-5 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-3">
                <div className="flex items-center gap-3 text-amber-400">
                    <CalendarDays className="w-4 h-4" />
                    <span className="text-[10px] font-bold uppercase tracking-wider">{title}</span>
                </div>
                <div className="flex flex-col gap-1">
                    {node.number != null && (
                        <div className="flex items-center gap-2 text-indigo-300">
                            <Hash className="w-3 h-3" />
                            <span className="text-sm font-bold">Episode {node.number}</span>
                        </div>
                    )}
                    {publishedDate && <span className="text-xl font-bold text-amber-200">{publishedDate}</span>}
                </div>
            </div>
        ),
        'topics': (title) => podcastTopics.length > 0 && (
            <div className="p-5 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-3">
                <div className="flex items-center gap-3 text-teal-400">
                    <Tag className="w-4 h-4" />
                    <span className="text-[10px] font-bold uppercase tracking-wider">{title}</span>
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
        ),
        'excerpts': (title) => transcriptChunks.length > 0 && (
            <div className="p-6 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-4">
                <div className="flex items-center gap-3 text-rose-400">
                    <MessageSquare className="w-4 h-4" />
                    <span className="text-xs font-semibold uppercase tracking-wider">{title}</span>
                </div>
                <div className="flex flex-col gap-3">
                    {transcriptChunks.map((chunk, i) => (
                        <p key={i} className="text-slate-300 text-sm leading-relaxed border-l-2 border-rose-500/30 pl-3 italic">
                            &quot;{chunk.text?.slice(0, 220)}{chunk.text?.length > 220 ? '…' : ''}&quot;
                        </p>
                    ))}
                </div>
            </div>
        ),
        'tech_stack': (title) => technologies.length > 0 && (
            <div className="p-5 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-3">
                <div className="flex items-center gap-3 text-emerald-400">
                    <Cpu className="w-4 h-4" />
                    <span className="text-[10px] font-bold uppercase tracking-wider">{title}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                    {technologies.map((t: string) => (
                        <span key={t} className="px-2 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-mono">{t}</span>
                    ))}
                </div>
            </div>
        ),
        'timeline': (title) => (timelineDate || node.isPresent || (node.startYear && node.endYear)) && (
            <div className="p-5 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-3">
                <div className="flex items-center gap-3 text-amber-400">
                    <History className="w-4 h-4" />
                    <span className="text-[10px] font-bold uppercase tracking-wider">{title}</span>
                </div>
                <div className="flex flex-col">
                    <span className="text-xl font-bold text-amber-200">{timelineDate || 'Active'}</span>
                    <span className="text-[10px] text-slate-500 uppercase tracking-tighter">
                        {node.isPresent ? 'Currently Active' : node.startYear && node.endYear ? `${node.startYear} → ${node.endYear}` : ''}
                    </span>
                </div>
            </div>
        ),
        'career_ledger': (title) => careerLedger.length > 0 && (
            <div className="p-6 rounded-2xl bg-slate-800/40 border border-white/5 flex flex-col gap-4">
                <div className="flex items-center gap-3 text-indigo-400">
                    <History className="w-4 h-4" />
                    <span className="text-xs font-semibold uppercase tracking-wider">{title}</span>
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
        ),
        'source_document': (title) => sourceFacts.length > 0 && (
            <div className="p-5 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-3">
                <div className="flex items-center gap-3 text-sky-400">
                    <FileText className="w-4 h-4" />
                    <span className="text-[10px] font-bold uppercase tracking-wider">{title}</span>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                    {sourceFacts.map(([k, v]) => (
                        <React.Fragment key={k}>
                            <dt className="text-slate-500">{k}</dt>
                            <dd className="text-slate-100 break-all">{v}</dd>
                        </React.Fragment>
                    ))}
                </dl>
            </div>
        ),
        'sections_outline': (title) => outline?.sections && outline.sections.length > 0 && (
            <div className="p-5 rounded-2xl bg-white/5 border border-white/5 flex flex-col gap-3">
                <div className="flex items-center gap-3 text-violet-400">
                    <ListTree className="w-4 h-4" />
                    <span className="text-[10px] font-bold uppercase tracking-wider">{title}</span>
                    {(outline.total ?? 0) > outline.sections.length && (
                        <span className="ml-auto text-[9px] text-slate-500">{outline.sections.length} of {outline.total}</span>
                    )}
                </div>
                <ol className="flex flex-col gap-1 text-xs text-slate-200">
                    {outline.sections.map((sec, i) => (
                        <li key={i} className="flex justify-between gap-3">
                            <span className="truncate">{sec.title}</span>
                            {sec.page_start != null && <span className="text-slate-500 shrink-0">p. {sec.page_start}</span>}
                        </li>
                    ))}
                </ol>
            </div>
        ),
        'live_source': (title) => websiteSourceCard(title),
        'resources': (title) => resourceGallery(title),
        'narrative': (title) => narrativeBlock(title),
        'bridge': (title) => knowledgeBridge(title),
    };

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
                    {groupHalfSections(sections).map((group, gi) => {
                        const rendered = group.map(sec => {
                            const render = PANEL_SECTIONS[sec.id];
                            const el = render ? render(sec.title) : null;
                            return el ? <React.Fragment key={sec.id}>{el}</React.Fragment> : null;
                        }).filter(Boolean);
                        if (rendered.length === 0) return null;
                        return rendered.length > 1
                            ? <div key={gi} className="grid grid-cols-2 gap-4">{rendered}</div>
                            : <React.Fragment key={gi}>{rendered}</React.Fragment>;
                    })}
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
