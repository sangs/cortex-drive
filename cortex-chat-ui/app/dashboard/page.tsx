"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useUser, useAuth, UserButton, OrganizationSwitcher } from "@clerk/nextjs";
import { 
    BrainCircuit, 
    Send, 
    History, 
    Plus, 
    Database, 
    Network, 
    Wifi, 
    WifiOff, 
    Maximize2, 
    Settings,
    MoreHorizontal,
    ChevronRight,
    ChevronLeft,
    Search,
    Cpu,
    Target,
    Activity,
    Trash2,
    SendHorizontal,
    GripVertical,
    Square,
    X
} from 'lucide-react';
import A2UIRenderer from "@/components/a2ui/A2UIRenderer";
import dynamic from "next/dynamic";
import { useMCP } from "@/hooks/use-mcp";

// 1. Dynamic Imports for heavy/client-only UI components to prevent Hydration errors
const EnterpriseGraph = dynamic(() => import("@/components/EnterpriseGraph"), { ssr: false });
const BentoDetailPanel = dynamic(() => import("@/components/BentoDetailPanel"), { ssr: false });
import { getThemeForType } from "@/utils/GraphTheme";
import {
    CAREER_BACKBONE,
    PODCAST_BACKBONE,
    GRAPH_VISUAL_EXCLUDE,
    TAG_LEAF_TYPES,
    ALWAYS_EXPANDABLE,
    HUB_TYPES,
    CATEGORY_CHILD_TYPES,
    GROUPER_LABELS,
    GROUPABLE_TYPES,
    GROUPER_MIN_COUNT,
    PROFESSIONAL_EXPERIENCE_CATEGORY,
    collapseToGroupers,
    buildCompanyGroupers,
    deduplicateNodes,
    inferBackbone,
    domainToBackbone,
} from "@/utils/graphConstants";

export default function DashboardPage() {
    const { user } = useUser();
    const { getToken } = useAuth();
    const { isConnected, query, callTool, abortQuery } = useMCP();
    const [messages, setMessages] = useState<any[]>([]);
    const [graphData, setGraphData] = useState<{ nodes: any[], links: any[] }>({ nodes: [], links: [] });
    const [input, setInput] = useState("");
    const [isProcessing, setIsProcessing] = useState(false);
    
    // Layout State
    const [chatWidth, setChatWidth] = useState(40); // percentage
    const [isGraphVisible, setIsGraphVisible] = useState(true);
    const [isChatVisible, setIsChatVisible] = useState(true);
    const [viewMode, setViewMode] = useState<'brain' | 'spine'>('brain');
    const [selectedNode, setSelectedNode] = useState<any | null>(null);
    const [focusYear, setFocusYear] = useState<string | null>(null);
    const [autoClear, setAutoClear] = useState(true); // TDD: Focus Mode (Clear Map between queries)
    const [hasMounted, setHasMounted] = useState(false);
    const [nodeExpansionDepth, setNodeExpansionDepth] = useState<Map<string, number>>(new Map());
    const [domainSignal, setDomainSignal] = useState<string>('career');
    const [focusedNodeIds, setFocusedNodeIds] = useState<Set<string> | null>(null);
    const expansionCache = useRef<Map<string, any>>(new Map());
    const expandedNodes = useRef<Set<string>>(new Set());
    const expansionContributions = useRef<Map<string, Set<string>>>(new Map());
    const isResizing = useRef(false);

    const computeFocusedIds = (): Set<string> | null => {
        if (expandedNodes.current.size === 0) return null;
        const ids = new Set<string>();
        expandedNodes.current.forEach(key => ids.add(key));
        expansionContributions.current.forEach(contributed => {
            contributed.forEach(id => ids.add(id));
        });
        return ids;
    };
    const singleClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const bentoAbortController = useRef<AbortController | null>(null);
    const bentoCache = useRef<Map<string, any>>(new Map());
    const [isBentoHydrating, setIsBentoHydrating] = useState(false);
    const [legendOpen, setLegendOpen] = useState(false);

    useEffect(() => {
        setHasMounted(true);
    }, []);

    // Helper to parse tool data into graph format
    const parseDataToGraph = (rawData: any, existingData?: any, backboneOnly: boolean = false, backboneSet?: Set<string>) => {
        try {
            if (!rawData) return existingData || { nodes: [], links: [] };
            const parsedRaw = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;

            // Start with existing data for additive hydration
            const nodes = existingData ? [...existingData.nodes] : [];
            const links = existingData ? [...existingData.links] : [];

            // Helper to decide if a node should even be added in backbone-only mode
            const allowedSet = backboneSet || new Set([...CAREER_BACKBONE, ...PODCAST_BACKBONE]);
            const isAllowed = (nodeType: string) => {
                if (!backboneOnly) return true;
                return allowedSet.has(nodeType);
            };

            // Affordance constants are imported from graphConstants — not re-declared here.
            const applyAffordanceFlags = (nodeList: any[], linkList: any[]) => {
                nodeList.forEach(node => {
                    if (TAG_LEAF_TYPES.has(node.type)) {
                        node.isBentoEligible = false;
                        node.isExpandable = false;
                        return;
                    }
                    if (node.type === 'Topic') {
                        node.isBentoEligible = false;
                        const hasLinks = linkList.some(l => l.source === node.id || l.target === node.id);
                        node.isExpandable = hasLinks;
                        return;
                    }
                    // Category nodes are structural groupers — expand-only, no bento detail panel.
                    if (node.type === 'Category') {
                        node.isBentoEligible = false;
                        node.isExpandable = true;
                        return;
                    }
                    node.isBentoEligible = !!(node.name) && !node.isGrouper;
                    const hasLinks = linkList.some(l => l.source === node.id || l.target === node.id);
                    node.isExpandable = node.isGrouper || ALWAYS_EXPANDABLE.has(node.type) || (HUB_TYPES.has(node.type) && hasLinks);
                });
            };

            // Direct Graph Fragment Handling (e.g. from get_cluster_context / expand_node_topology)
            if (parsedRaw.nodes && Array.isArray(parsedRaw.nodes)) {
                const allowedIds = new Set<string>();
                parsedRaw.nodes.forEach((n: any) => {
                    if (!n.id) return;
                    if (GRAPH_VISUAL_EXCLUDE.has(n.type)) return;
                    if (!isAllowed(n.type)) return;
                    allowedIds.add(n.id);
                    const existingIdx = nodes.findIndex(node => node.id === n.id);
                    if (existingIdx === -1) nodes.push(n);
                    else nodes[existingIdx] = { ...nodes[existingIdx], ...n };
                });

                const addLinkToArray = (l: any) => {
                    const exists = links.some(link =>
                        (link.source === l.source && link.target === l.target) ||
                        (link.source === l.target && link.target === l.source)
                    );
                    if (!exists) links.push({
                        ...l,
                        isVirtual: l.isVirtual || l.type === 'VIRTUAL_BRIDGE',
                        label: l.type === 'VIRTUAL_BRIDGE' ? { show: true, formatter: l.discovery_reason } : undefined
                    });
                };

                if (parsedRaw.links && Array.isArray(parsedRaw.links)) {
                    parsedRaw.links.forEach((l: any) => {
                        if (backboneOnly && (!allowedIds.has(l.source) || !allowedIds.has(l.target))) return;
                        addLinkToArray(l);
                    });
                }
                if (parsedRaw.virtual_links && Array.isArray(parsedRaw.virtual_links)) {
                    parsedRaw.virtual_links.forEach((l: any) => addLinkToArray({ ...l, isVirtual: true }));
                }

                // Identity anchor detection (mirrors legacy path — needed when gateway returns { nodes, links })
                if (backboneOnly) {
                    const degreeCounts = new Map<string, number>();
                    links.forEach(l => {
                        degreeCounts.set(l.source, (degreeCounts.get(l.source) || 0) + 1);
                        degreeCounts.set(l.target, (degreeCounts.get(l.target) || 0) + 1);
                    });
                    let maxDegree = 0; let anchorId: string | null = null;
                    nodes.filter(n => n.type === 'Person').forEach(n => {
                        const d = degreeCounts.get(n.id) || 0;
                        if (d > maxDegree) { maxDegree = d; anchorId = n.id; }
                    });
                    if (anchorId && maxDegree >= 3) {
                        const anchor = nodes.find(n => n.id === anchorId);
                        if (anchor) anchor.isIdentityAnchor = true;
                    }
                }
                // Career backbone: hide individual instances — only Category groupers visible initially (Fix Q2).
                if (backboneOnly && backboneSet === CAREER_BACKBONE) {
                    const hasCategoryNodes = nodes.some(n => n.type === 'Category');
                    if (hasCategoryNodes) {
                        const filteredNodes = nodes.filter(n => !CATEGORY_CHILD_TYPES.has(n.type));
                        const filteredLinks = links.filter(l =>
                            filteredNodes.some(n => n.id === l.source) &&
                            filteredNodes.some(n => n.id === l.target)
                        );
                        applyAffordanceFlags(filteredNodes, filteredLinks);
                        return { nodes: filteredNodes, links: filteredLinks };
                    }
                }
                applyAffordanceFlags(nodes, links);
                return { nodes, links };
            }

            const rawResults = Array.isArray(parsedRaw) ? parsedRaw : [parsedRaw];

            const addNode = (node: any) => {
                if (!node.id || GRAPH_VISUAL_EXCLUDE.has(node.type)) return null;
                if (!isAllowed(node.type)) return null; // Backbone-only filter

                const existingIndex = nodes.findIndex(n => n.id === node.id);
                if (existingIndex === -1) {
                    nodes.push(node);
                    return true;
                } else {
                    // Update existing node with potentially newer/more complete data
                    nodes[existingIndex] = { ...nodes[existingIndex], ...node };
                    return false;
                }
            };

            const addLink = (link: any) => {
                if (!link.source || !link.target) return;
                
                const existing = links.find(l => 
                    (l.source === link.source && l.target === link.target) ||
                    (l.source === link.target && l.target === link.source)
                );
                if (!existing) {
                    links.push(link);
                }
            };

            // Enhanced Normalizer Helper
            const extractValue = (obj: any, keys: string[]) => {
                for (const key of keys) {
                    if (obj[key] !== undefined) return obj[key];
                    // Handle Cypher keys like 'e.name' or 'n.name'
                    const bracketKey = key.includes('.') ? key : null;
                    if (bracketKey && obj[bracketKey] !== undefined) return obj[bracketKey];
                    // Case insensitive check
                    const k = Object.keys(obj).find(k => k.toLowerCase() === key.toLowerCase());
                    if (k) return obj[k];
                }
                return null;
            };

            const processItem = (item: any, idx: number) => {
                // 1. Identify "Seed" node (The Primary Subject)
                const nameKeys = ['episode_name', 'name', 'SeedEpisode', 'EpisodeTitle', 'e.name', 'n.name', 'title', 'target_name'];
                const idKeys = ['episode_number', 'SeedEpisodeNumber', 'EpisodeNumber', 'id', 'e.episode_number', 'target_id'];
                const dateKeys = ['date', 'air_date', 'startDate', 'published_at', 'year'];
                
                const seedDetails = item.Details || item;
                const name = extractValue(seedDetails, nameKeys);
                if (!name) return;

                const id = seedDetails.element_id || seedDetails.id || name; // Prioritize element_id for Neo4j stability
                
                // Identify normalized time marker
                const timeValue = extractValue(seedDetails, dateKeys);
                const year = timeValue ? (String(timeValue).match(/\d{4}/)?.[0] || null) : null;
                const date = timeValue || null;

                // Smart Type Inference: Only use 'Episode' if keywords match, otherwise default to 'Node' 
                // for professional entities to prevent visual misidentification.
                const type = (name.toLowerCase().includes('mcp') || name.toLowerCase().includes('baml')) ? 'Episode' : (seedDetails.type || 'Node');
                const description = seedDetails.ChunkContent || seedDetails.description || '';
                addNode({ id, name, type, val: 10, year, date, description, text: description, ...seedDetails });

                // 2. Handle GDS/Hybrid Search "Similar" nodes
                const simName = extractValue(item, ['SimilarEpisode', 'target_name', 'related_name']);
                if (simName) {
                    const simNum = extractValue(item, ['SimilarEpisodeNumber', 'target_id']) || `sim-${idx}`;
                    const simId = `node-${simNum}`;
                    addNode({ id: simId, name: simName, type: item.type || 'Episode', val: 8, year, date });
                    addLink({ source: id, target: simId, type: 'SIMILAR' });
                }

                // 3. Metadata Enrichment (Topics/People) — suppressed in backbone-only mode to prevent Q1 over-expansion
                if (!backboneOnly) {
                const metadata = [
                    { key: ['topics', 'Topics', 'topic'], type: 'Topic', linkType: 'HAS_TOPIC' },
                    { key: ['person_name', 'Person', 'people'], type: 'Person', linkType: 'HAS_PARTICIPANT' }
                ];

                metadata.forEach(m => {
                    const vals = extractValue(item, m.key);
                    if (vals) {
                        const valsArray = Array.isArray(vals) ? (Array.isArray(vals[0]) ? vals[0] : vals) : [vals];
                        valsArray.forEach((v: any) => {
                            const vName = typeof v === 'string' ? v : (v.name || v.text);
                            if (!vName) return;
                            const vId = vName; // Standardize on name
                            addNode({ id: vId, name: vName, type: m.type, val: 5, year, date });
                            addLink({ source: id, target: vId, type: m.linkType });
                        });
                    }
                });
                }

                // 4. Universal Schema-Agnostic Relationships Array (For Resumes, Projects, etc)
                const relationships = extractValue(item, ['relationships', 'Relationships', 'edges']);
                if (relationships && Array.isArray(relationships)) {
                    relationships.forEach((rel, rIdx) => {
                        const targetName = extractValue(rel, ['target_name', 'name', 'target']);
                        if (!targetName) return;
                        
                        const targetType = extractValue(rel, ['target_type', 'type', 'label']) || 'Node';
                        if (targetType === 'PreparatoryNote') return;
                        
                        const type = (targetName.toLowerCase().includes('mcp') || targetName.toLowerCase().includes('baml')) ? 'Episode' : (targetType || 'Node');
                        const relType = extractValue(rel, ['rel_type', 'relationship', 'type']) || 'RELATED_TO';
                        const targetId = rel.element_id || rel.target_id || rel.id || targetName; 
                        
                        // Pass temporal metadata to relationship targets
                        const relTimeValue = extractValue(rel, ['date', 'year', 'startDate']);
                        const relYear = relTimeValue ? (String(relTimeValue).match(/\d{4}/)?.[0] || year) : year;
                        const relDate = relTimeValue || date;

                        addNode({ id: targetId, name: targetName, type: targetType, val: 5, year: relYear, date: relDate, ...rel });
                        addLink({ source: id, target: targetId, type: relType, ...rel });
                    });
                }
            };

            // Process each individual tool result found in the aggregated raw results
            rawResults.forEach(rawStr => {
                try {
                    const data = typeof rawStr === 'string' ? JSON.parse(rawStr) : rawStr;
                    
                    // 1. Check for Topology Payload (nodes/links)
                    if (data && data.nodes && Array.isArray(data.nodes)) {
                        data.nodes.forEach((n: any) => addNode(n));
                        if (data.links && Array.isArray(data.links)) {
                            data.links.forEach((l: any) => addLink({
                                ...l,
                                isVirtual: l.type === 'VIRTUAL_BRIDGE' || data.isVirtual
                            }));
                        }
                    }
                    if (data && data.virtual_links && Array.isArray(data.virtual_links)) {
                        data.virtual_links.forEach((vl: any) => addLink({
                            ...vl,
                            isVirtual: true,
                            type: 'VIRTUAL_BRIDGE'
                        }));
                    }
                    // 2. Handle Legacy Node Envelopes
                    else if (Array.isArray(data)) {
                        data.forEach((item, idx) => processItem(item, idx));
                    } else if (typeof data === 'object' && data !== null) {
                        processItem(data, 0);
                    }
                } catch (e) {
                    console.warn("Skipping non-JSON result in aggregator", rawStr);
                }
            });

            // Final Integrity Pass: Remove links pointing to non-existent nodes
            const finalLinks = links.filter(l =>
                nodes.some(n => n.id === l.source) &&
                nodes.some(n => n.id === l.target)
            );

            // Fix #5: Identity Anchor Detection — the Person node with highest degree is the career map root.
            // EnterpriseGraph pins it to center (x:0, y:0) in brain mode.
            if (backboneOnly) {
                const degreeCounts = new Map<string, number>();
                finalLinks.forEach(l => {
                    degreeCounts.set(l.source, (degreeCounts.get(l.source) || 0) + 1);
                    degreeCounts.set(l.target, (degreeCounts.get(l.target) || 0) + 1);
                });
                let maxDegree = 0; let anchorId: string | null = null;
                nodes.filter(n => n.type === 'Person').forEach(n => {
                    const d = degreeCounts.get(n.id) || 0;
                    if (d > maxDegree) { maxDegree = d; anchorId = n.id; }
                });
                if (anchorId && maxDegree >= 3) {
                    const anchor = nodes.find(n => n.id === anchorId);
                    if (anchor) anchor.isIdentityAnchor = true;
                }
            }

            // Grouper logic — three cases:
            let processedNodes = nodes;
            let processedLinks = finalLinks;

            if (backboneOnly && backboneSet === CAREER_BACKBONE) {
                // Q2: Career backbone mode.
                // If real Career Category nodes came back from the DB (e.g. "Education & Continuous Learning"),
                // they ARE the top-level groupers. Hide individual instances — they're revealed by double-clicking.
                const hasCategoryNodes = nodes.some(n => n.type === 'Category');
                if (hasCategoryNodes) {
                    const CATEGORY_CHILD_TYPES = new Set([
                        'ThoughtLeadership', 'Degree', 'Certification', 'Hackathon',
                        'Company', 'Startup', 'Role', 'Institution', 'Publication', 'Project'
                    ]);
                    processedNodes = nodes.filter(n => !CATEGORY_CHILD_TYPES.has(n.type));
                    processedLinks = finalLinks.filter(l =>
                        processedNodes.some(n => n.id === l.source) &&
                        processedNodes.some(n => n.id === l.target)
                    );
                } else {
                    // No Category nodes — fall back to virtual groupers from collapseToGroupers
                    const collapsed = collapseToGroupers(nodes, finalLinks);
                    processedNodes = collapsed.nodes;
                    processedLinks = collapsed.links;
                }
            } else if (!backboneOnly && nodes.some(n => n.type === 'Person') &&
                       nodes.some(n => n.type === 'ThoughtLeadership' || n.type === 'Hackathon')) {
                // Q3: Cross-domain mode with ThoughtLeadership/Hackathon present.
                // Collapse them so the graph starts at grouper level, not individual instances.
                const collapsed = collapseToGroupers(nodes, finalLinks);
                processedNodes = collapsed.nodes;
                processedLinks = collapsed.links;
            }

            applyAffordanceFlags(processedNodes, processedLinks);
            return { nodes: processedNodes, links: processedLinks };
        } catch (e) {
            console.error("Failed to parse graph data", e);
            return existingData || { nodes: [], links: [] };
        }
    };

    const handleSend = async () => {
        if (!input.trim() || !isConnected || isProcessing) return;

        const userMsg = input;
        const currentMessages = [...messages];
        setMessages(prev => [...prev, { role: "user", content: userMsg }]);
        setInput("");
        setIsProcessing(true);

        try {
            // Filter out system messages or complex components for history
            const history = currentMessages
                .filter(m => typeof m.content === 'string')
                .map(m => ({ role: m.role, content: m.content }));

            // Check for force-refresh flag (per-message)
            const forceRefresh = userMsg.toLowerCase().includes('--refresh') || userMsg.toLowerCase().includes('!v');

            const result = await query(userMsg, history, forceRefresh);
            
            // 1. Add assistant text answer
            setMessages(prev => [...prev, { 
                role: "assistant", 
                content: result.answer 
            }]);

            if (result.raw_data) {
                // Focus Mode: Clear existing graph if autoClear is enabled
                const contextGraph = autoClear ? { nodes: [], links: [] } : graphData;
                // Backbone selection: explicit domain_signal from gateway, inferBackbone only as fallback
                if (result.domain_signal) setDomainSignal(result.domain_signal);
                const { backbone, backboneOnly } = domainToBackbone(result.domain_signal, result.raw_data);
                const newGraph = parseDataToGraph(result.raw_data, contextGraph, backboneOnly, backbone);
                // New query clears expansion state — cached topology no longer matches new graph
                expansionCache.current = new Map();
                expandedNodes.current = new Set();
                expansionContributions.current = new Map();
                setFocusedNodeIds(null);
                setGraphData(newGraph);
                
                // 3. Auto-Shift Timeline: Scan for the most relevant year in the results
                try {
                    const data = JSON.parse(result.raw_data);
                    const items = Array.isArray(data) ? data : [data];
                    
                    const dateKeys = ['date', 'air_date', 'startDate', 'published_at', 'year'];
                    let detectedYear = null;
                    
                    for (const item of items) {
                        for (const key of dateKeys) {
                            const val = item[key] || item.Details?.[key] || item.properties?.[key];
                            const match = val ? String(val).match(/\d{4}/) : null;
                            if (match) {
                                detectedYear = match[0];
                                break;
                            }
                        }
                        if (detectedYear) break;
                    }
                    
                    if (detectedYear) setFocusYear(detectedYear);
                } catch (e) {
                    console.warn("Auto-shift: raw_data is not valid JSON or missing timeline markers", e);
                }
            }
        } catch (err: any) {
            console.error("Orchestration failed", err);
            const errorMsg = err.response?.error || err.message || "I encountered an error communicating with your Knowledge Graph.";
            setMessages(prev => [...prev, {
                role: "assistant",
                content: `Error: ${errorMsg}`
            }]);
        } finally {
            setIsProcessing(false);
        }
    };

    const startNewAnalysis = () => {
        setMessages([
            {
                role: "assistant",
                content: "Cortex-Drive: Grounded Intelligence at Scale. Ask me anything across your enterprise context graph or explore your portfolio.",
            }
        ]);
        setGraphData({ nodes: [], links: [] });
        setNodeExpansionDepth(new Map());
        setFocusedNodeIds(null);
        expansionCache.current = new Map();
        expandedNodes.current = new Set();
        expansionContributions.current = new Map();
    };

    const handleNodeClick = (node: any) => {
        // Debounce: wait 250ms before opening Bento so a double-click can cancel this first.
        if (singleClickTimer.current) clearTimeout(singleClickTimer.current);
        singleClickTimer.current = setTimeout(async () => {
            singleClickTimer.current = null;
            // ECharts params.data can be stale when lazyUpdate=true defers a render cycle.
            // Always resolve affordance flags from React graphData — it is the source of truth.
            const freshNode = graphData.nodes.find(n => n.id === node.id) ?? node;
            if (!freshNode.isBentoEligible) return;

            // Cancel any in-flight hydration from a previous click (AbortController pattern).
            bentoAbortController.current?.abort();
            bentoAbortController.current = new AbortController();

            // Stale-While-Revalidate: show cached full data immediately if available.
            const cacheKey = freshNode.element_id || freshNode.id || freshNode.name;
            if (bentoCache.current.has(cacheKey)) {
                setSelectedNode({ ...freshNode, ...bentoCache.current.get(cacheKey) });
                return;
            }

            // Show the partial graph node immediately; hydration will replace description.
            setSelectedNode(freshNode);
            setIsBentoHydrating(true);

            try {
                console.log("Hydrating node (High-Speed Path via Gateway):", freshNode.id || freshNode.name);
                const token = await getToken();
                const response = await fetch('http://localhost:4000/api/get_node_details', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        node_name: freshNode.name,
                        node_id: freshNode.element_id || freshNode.id
                    }),
                    signal: bentoAbortController.current.signal
                });

                if (response.ok) {
                    const results = await response.json();
                    const payload = Array.isArray(results) ? results[0] : (results.result?.content ? JSON.parse(results.result.content[0].text)[0] : results);

                    if (payload && !payload.error) {
                        const p = payload.properties || payload;
                        const narratives = payload.narratives || (p.text ? [p.text] : (p.description ? [p.description] : []));
                        // Only use hydrated description if it is richer than what we already have.
                        const hydratedDesc = narratives.length > 0
                            ? narratives.join('\n\n')
                            : (p.description && p.description.length > (freshNode.description?.length ?? 0)
                                ? p.description
                                : undefined);
                        const tech = p.technologies || p.tech_stack || p.tools || freshNode.technologies;
                        const refLinks = payload.ref_urls || p.links || p.ref_urls || [];
                        const directLinks = [p.link, p.url].filter(Boolean);
                        const hydratedFields = {
                            ...p,
                            ...(hydratedDesc ? { description: hydratedDesc, text: hydratedDesc } : {}),
                            technologies: Array.isArray(tech) ? tech : (tech ? [tech] : []),
                            links: Array.from(new Set([...(freshNode.links || []), ...refLinks, ...directLinks]))
                        };
                        // Cache the enriched fields for instant display on revisit.
                        bentoCache.current.set(cacheKey, hydratedFields);
                        setSelectedNode((prev: any) => {
                            if (!prev || prev.id !== freshNode.id) return prev;
                            return { ...prev, ...hydratedFields };
                        });
                    }
                }
            } catch (e: any) {
                if (e?.name !== 'AbortError') console.error("Progressive hydration failed:", e);
            } finally {
                setIsBentoHydrating(false);
            }
        }, 250);
    };

    const handleNodeDoubleClick = async (node: any) => {
        // Cancel any pending single-click (bento open) — double-click takes precedence.
        if (singleClickTimer.current) {
            clearTimeout(singleClickTimer.current);
            singleClickTimer.current = null;
        }

        // Resolve fresh affordance flags from React state — ECharts params.data can be stale.
        const freshNode = graphData.nodes.find(n => n.id === node.id) ?? node;

        // Non-expandable node: open bento if eligible, otherwise ignore double-click.
        if (!freshNode.isGrouper && !freshNode.isExpandable) {
            if (freshNode.isBentoEligible) setSelectedNode(freshNode);
            return;
        }

        const nodeKey = freshNode.id || freshNode.name;

        // Grouper expansion is client-side — bloom children without an API call.
        // Company groupers: keep the company node visible and link children TO it.
        // Other groupers (ThoughtLeadership, Hackathon, etc.): replace grouper with
        // children and rewire parent links, preserving VIRTUAL_BRIDGE gold lines.
        // Guard: if children is empty fall through to server expansion.
        if (freshNode.isGrouper && freshNode.children && freshNode.children.length > 0) {
            const isCompanyGrouper = freshNode.type === 'Company' || freshNode.type === 'Startup';

            if (isCompanyGrouper) {
                // Keep the company node; add children linked TO the company (not to its parent).
                setGraphData(prev => {
                    const expandedCompany = { ...freshNode, isGrouper: false, isExpanded: true, isExpandable: false };
                    const existingIds = new Set(prev.nodes.map((n: any) => n.id));
                    const newChildren = freshNode.children.filter((c: any) => !existingIds.has(c.id));
                    const newNodes = prev.nodes
                        .filter((n: any) => n.id !== freshNode.id)
                        .concat(expandedCompany)
                        .concat(newChildren);
                    const newLinks = [...prev.links];
                    freshNode.children.forEach((child: any) => {
                        if (!newLinks.some((l: any) =>
                            (l.source === freshNode.id && l.target === child.id) ||
                            (l.source === child.id && l.target === freshNode.id)
                        )) {
                            newLinks.push({ source: freshNode.id, target: child.id, type: 'AT' });
                        }
                    });
                    return { ...prev, nodes: newNodes, links: newLinks };
                });
                const contributed = new Set<string>(freshNode.children.map((c: any) => c.id as string));
                expansionContributions.current.set(nodeKey, contributed);
            } else {
                // Non-company groupers: replace grouper with children, rewire parent links.
                // Preserves VIRTUAL_BRIDGE gold lines via spread.
                setGraphData(prev => {
                    const newNodes = prev.nodes.filter((n: any) => n.id !== freshNode.id).concat(freshNode.children);
                    const grouperLinks = prev.links.filter(l => l.source === freshNode.id || l.target === freshNode.id);
                    const remainingLinks = prev.links.filter(l => l.source !== freshNode.id && l.target !== freshNode.id);
                    const expandedLinks = [...remainingLinks];
                    freshNode.children.forEach((child: any) => {
                        grouperLinks.forEach((gl: any) => {
                            const src = gl.source === freshNode.id ? child.id : gl.source;
                            const tgt = gl.target === freshNode.id ? child.id : gl.target;
                            if (!expandedLinks.some(el => el.source === src && el.target === tgt)) {
                                expandedLinks.push({ ...gl, source: src, target: tgt });
                            }
                        });
                    });
                    return { ...prev, nodes: newNodes, links: expandedLinks };
                });
                // Replace grouper with children in contribution tracking.
                expansionContributions.current.forEach(contributed => {
                    if (contributed.has(freshNode.id)) {
                        contributed.delete(freshNode.id);
                        freshNode.children.forEach((child: any) => { if (child.id) contributed.add(child.id); });
                    }
                });
            }

            expandedNodes.current.add(nodeKey);
            setFocusedNodeIds(() => computeFocusedIds());
            return;
        }

        // TOGGLE COLLAPSE: node already expanded → remove its contributed nodes
        if (expandedNodes.current.has(nodeKey)) {
            setGraphData(prev => {
                const contributed = expansionContributions.current.get(nodeKey) || new Set<string>();
                // Nodes shared with other expanded nodes must not be removed
                const sharedIds = new Set<string>();
                expandedNodes.current.forEach(otherId => {
                    if (otherId === nodeKey) return;
                    (expansionContributions.current.get(otherId) || new Set()).forEach(id => sharedIds.add(id));
                });
                const toRemove = new Set([...contributed].filter(id => !sharedIds.has(id)));
                const newNodes = prev.nodes.filter(n => !toRemove.has(n.id));
                const newLinks = prev.links.filter(l =>
                    newNodes.some(n => n.id === l.source) && newNodes.some(n => n.id === l.target)
                );
                return { nodes: newNodes, links: newLinks };
            });
            expandedNodes.current.delete(nodeKey);
            expansionContributions.current.delete(nodeKey);
            setFocusedNodeIds(() => computeFocusedIds());
            return;
        }

        // EXPAND FROM CACHE: no server call
        if (expansionCache.current.has(nodeKey)) {
            console.log("Expanding from cache:", nodeKey);
            setGraphData(prev => {
                const cached = expansionCache.current.get(nodeKey);
                const existingIds = new Set(prev.nodes.map((n: any) => n.id as string));
                const newGraph = parseDataToGraph(cached, prev);
                const contributed = new Set<string>(newGraph.nodes.filter((n: any) => !existingIds.has(n.id)).map((n: any) => n.id as string));
                expansionContributions.current.set(nodeKey, contributed);
                expandedNodes.current.add(nodeKey);
                return newGraph;
            });
            setFocusedNodeIds(() => computeFocusedIds());
            return;
        }

        // PROFESSIONAL EXPERIENCE: two-level bloom — first click shows Companies,
        // second click (on Company) blooms Projects/Roles at that company via grouper logic.
        if (freshNode.type === 'Category' && freshNode.name === PROFESSIONAL_EXPERIENCE_CATEGORY) {
            try {
                setIsProcessing(true);
                const toolResponse = await callTool("get_cluster_context", {
                    node_name: PROFESSIONAL_EXPERIENCE_CATEGORY,
                    depth: 2,
                    backbone_only: false
                });
                if (toolResponse?.content?.[0]) {
                    const results = JSON.parse(toolResponse.content[0].text);
                    const enrichedCompanies = buildCompanyGroupers(
                        results.nodes || [],
                        results.links || []
                    );
                    if (enrichedCompanies.length > 0) {
                        setGraphData(prev => {
                            const existingIds  = new Set(prev.nodes.map((n: any) => n.id as string));
                            const existingNames = new Set(prev.nodes.map((n: any) => n.name as string));
                            const addedCompanies = enrichedCompanies.filter((c: any) =>
                                !existingIds.has(c.id) && !existingNames.has(c.name)
                            );
                            const newLinks = [...prev.links];
                            enrichedCompanies.forEach((c: any) => {
                                if (!newLinks.some(l => (l.source === freshNode.id && l.target === c.id) || (l.source === c.id && l.target === freshNode.id))) {
                                    newLinks.push({ source: freshNode.id, target: c.id, type: 'CONTAINS' });
                                }
                            });
                            const contributed = new Set<string>(addedCompanies.map((c: any) => c.id as string));
                            expansionContributions.current.set(nodeKey, contributed);
                            expandedNodes.current.add(nodeKey);
                            return { nodes: [...prev.nodes, ...addedCompanies], links: newLinks };
                        });
                        setFocusedNodeIds(() => computeFocusedIds());
                    }
                }
            } catch (e) {
                console.error("Professional Experience expansion failed:", e);
            } finally {
                setIsProcessing(false);
            }
            return;
        }

        // EXPAND FROM SERVER: fetch and cache
        try {
            console.log("Expanding topology for:", nodeKey);
            setIsProcessing(true);
            const toolResponse = await callTool("get_cluster_context", {
                node_name: freshNode.name,
                depth: 1,
                backbone_only: false
            });

            if (toolResponse?.content?.[0]) {
                const results = JSON.parse(toolResponse.content[0].text);
                expansionCache.current.set(nodeKey, results);
                setGraphData(prev => {
                    const existingIds = new Set(prev.nodes.map((n: any) => n.id as string));
                    const newGraph = parseDataToGraph(results, prev);
                    const contributed = new Set<string>(newGraph.nodes.filter((n: any) => !existingIds.has(n.id)).map((n: any) => n.id as string));
                    expansionContributions.current.set(nodeKey, contributed);
                    expandedNodes.current.add(nodeKey);
                    return newGraph;
                });
                setFocusedNodeIds(() => computeFocusedIds());
                setNodeExpansionDepth(prev => new Map(prev).set(freshNode.id, (prev.get(freshNode.id) || 0) + 1));
            }
        } catch (e) {
            console.error("Node expansion failed:", e);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleDiscoverBridge = async (nodeId: string, node?: any) => {
        try {
            console.log("Identifying cross-domain bridges for:", node?.name || nodeId);
            setIsProcessing(true);

            // Infer the best target domain: if the source is a podcast type, bridge to professional; vice versa
            const podcastTypes = new Set(['Episode', 'Podcast', 'Topic']);
            const sourceDomain = node?.type && podcastTypes.has(node.type) ? 'professional' : 'podcast';

            const toolResponse = await callTool("connect_knowledge_on_demand", {
                source_node_id: nodeId,
                source_node_name: node?.name || "",   // name-based fallback for robustness
                target_domain: sourceDomain,
                min_anchors: 1,
                limit: 5
            });

            if (toolResponse && toolResponse.content && toolResponse.content[0]) {
                const results = JSON.parse(toolResponse.content[0].text);

                if (results.virtual_links && results.virtual_links.length > 0) {
                    // Merge bridge nodes and virtual links into the current graph (additive)
                    const newGraph = parseDataToGraph(results, graphData);
                    setGraphData(newGraph);
                }

                // Surface the bridge summary in chat so the user understands what was found
                if (results.bridge_summary) {
                    setMessages(prev => [...prev, {
                        role: "assistant",
                        content: `**Knowledge Bridge Discovery**\n\n${results.bridge_summary}\n\nGold dashed connections on the graph show the inferred links. Nothing was written to the graph — these are session-only virtual bridges.`
                    }]);
                } else if (!results.virtual_links?.length) {
                    setMessages(prev => [...prev, {
                        role: "assistant",
                        content: `**Knowledge Bridge Discovery**\n\nNo cross-domain bridges found for **${node?.name || nodeId}** with the current anchor threshold. Try expanding the node first (double-click) to enrich its context, then retry.`
                    }]);
                }
                // Close Bento to reveal the updated graph with gold dashed lines
                setSelectedNode(null);
            }
        } catch (e) {
            console.error("Bridge discovery failed:", e);
        } finally {
            setIsProcessing(false);
        }
    };

    // Resize Logic
    const startResizing = useCallback(() => {
        isResizing.current = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    }, []);

    const stopResizing = useCallback(() => {
        isResizing.current = false;
        document.body.style.cursor = 'default';
        document.body.style.userSelect = 'auto';
    }, []);

    const resize = useCallback((e: MouseEvent) => {
        if (!isResizing.current) return;
        
        // Calculate percentage (subtracting sidebar width which is 288px / 18rem)
        const sidebarWidth = 288;
        const availableWidth = window.innerWidth - sidebarWidth;
        const newWidth = ((e.clientX - sidebarWidth) / availableWidth) * 100;
        
        if (newWidth > 20 && newWidth < 80) {
            setChatWidth(newWidth);
        }
    }, []);

    useEffect(() => {
        window.addEventListener("mousemove", resize);
        window.addEventListener("mouseup", stopResizing);
        return () => {
            window.removeEventListener("mousemove", resize);
            window.removeEventListener("mouseup", stopResizing);
        };
    }, [resize, stopResizing]);

    return (
        <div className="flex h-screen bg-background overflow-hidden text-foreground">
            {/* Sidebar (Fixed Width - 18rem / 72px) */}
            <aside className="w-72 border-r border-slate-200 bg-slate-50/30 flex flex-col shrink-0 relative z-20 transition-all duration-500 overflow-y-auto">
                <div className="h-16 flex items-center gap-3 px-8 border-b border-slate-200 bg-white/50 backdrop-blur-sm sticky top-0 z-10">
                    <div className="w-10 h-10 rounded-2xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-600/20">
                        <BrainCircuit className="w-6 h-6 text-white" />
                    </div>
                    <span className="text-xl font-black tracking-tighter text-slate-900">CortexDrive</span>
                </div>

                <nav className="flex-1 p-4 space-y-8 overflow-y-auto no-scrollbar">
                    {/* Primary Actions */}
                    <div className="px-2">
                         <button 
                            onClick={startNewAnalysis}
                            className="w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl bg-white border border-slate-200 text-slate-900 shadow-sm hover:border-indigo-600 hover:text-indigo-600 transition-all font-bold group"
                         >
                            <Plus className="w-4 h-4 group-hover:rotate-90 transition-transform" />
                            New Analysis
                        </button>
                    </div>

                    {/* System Status Section */}
                    <div className="space-y-4">
                        <div className="px-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center justify-between">
                            System Health
                            <div className="flex items-center gap-1.5 ring-1 ring-slate-200 px-2 py-0.5 rounded-full bg-white">
                                <Activity className="w-2.5 h-2.5 text-indigo-500" />
                                <span className="text-[8px] text-slate-400">Live</span>
                            </div>
                        </div>
                        <div className="space-y-3 px-2">
                            <div className="flex items-center gap-3 p-3 rounded-2xl bg-white border border-slate-200 shadow-sm">
                                <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center">
                                    <Database className="w-4 h-4 text-indigo-500" />
                                </div>
                                <div className="flex flex-col">
                                    <span className="text-[10px] uppercase font-bold text-slate-400 tracking-tight">Neo4j Cloud</span>
                                    <div className="flex items-center gap-1.5">
                                        {hasMounted ? (
                                            isConnected ? <Wifi className="w-3 h-3 text-emerald-500" /> : <WifiOff className="w-3 h-3 text-rose-500" />
                                        ) : (
                                            <div className="w-2 h-2 rounded-full bg-slate-200 animate-pulse" />
                                        )}
                                        <span className={`text-[10px] font-bold ${hasMounted && isConnected ? 'text-emerald-600' : 'text-slate-400'}`}>
                                            {(!hasMounted) ? "Verifying..." : (isConnected ? "Authorized" : "Halted")}
                                        </span>
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-3 p-3 rounded-2xl bg-white border border-slate-200 shadow-sm">
                                <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center">
                                    <Network className="w-4 h-4 text-indigo-500" />
                                </div>
                                <div className="flex flex-col">
                                    <span className="text-[10px] uppercase font-bold text-slate-400 tracking-tight">MCP Server</span>
                                    <div className="flex items-center gap-1.5">
                                        {hasMounted ? (
                                            isConnected ? <Wifi className="w-3 h-3 text-emerald-500" /> : <WifiOff className="w-3 h-3 text-rose-500" />
                                        ) : (
                                            <div className="w-2 h-2 rounded-full bg-slate-200 animate-pulse" />
                                        )}
                                        <span className={`text-[10px] font-bold ${hasMounted && isConnected ? 'text-emerald-600' : 'text-slate-400'}`}>
                                            {(!hasMounted) ? "Verifying..." : (isConnected ? "Responsive" : "Disconnected")}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Graph Controls Section */}
                    <div className="space-y-4">
                        <div className="px-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Graph Controls</div>
                        <div className="px-2">
                            <button 
                                onClick={() => setAutoClear(!autoClear)}
                                className={`w-full flex items-center justify-between px-4 py-3.5 rounded-2xl border transition-all ${
                                    autoClear 
                                    ? 'bg-indigo-600 border-indigo-600 text-white shadow-lg shadow-indigo-600/20' 
                                    : 'bg-white border-slate-200 text-slate-400 hover:border-slate-300'
                                }`}
                            >
                                <div className="flex items-center gap-3 text-sm font-bold">
                                    <Target className={`w-4 h-4 ${autoClear ? 'animate-pulse' : ''}`} />
                                    <span>Focus Mode</span>
                                </div>
                                <div className={`w-8 h-4 rounded-full relative transition-colors ${autoClear ? 'bg-white/20' : 'bg-slate-200'}`}>
                                    <div className={`absolute top-1 w-2 h-2 rounded-full transition-all ${autoClear ? 'left-5 bg-white' : 'left-1 bg-slate-400'}`} />
                                </div>
                            </button>

                            
                            {!isGraphVisible && (
                                <button 
                                    onClick={() => setIsGraphVisible(true)}
                                    className="w-full mt-3 flex items-center gap-3 px-4 py-3.5 rounded-2xl bg-slate-900 text-white shadow-xl hover:bg-black transition-all group"
                                >
                                    <Maximize2 className="w-4 h-4 group-hover:scale-110 transition-transform" />
                                    <span className="text-sm font-bold">Restore Graph</span>
                                </button>
                            )}
                        </div>
                    </div>
                </nav>

                {/* Footer Section */}
                <div className="p-4 border-t border-slate-200 bg-white/50">
                    {hasMounted ? (
                        <div className="flex flex-col gap-3">
                            <div className="px-1">
                                <OrganizationSwitcher
                                    afterCreateOrganizationUrl="/dashboard"
                                    appearance={{
                                        elements: {
                                            rootBox: "w-full",
                                            organizationSwitcherTrigger: "w-full justify-start p-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 transition-colors shadow-sm font-bold text-slate-900",
                                            organizationPreviewMainIdentifier: "font-bold text-slate-900",
                                        }
                                    }}
                                />
                            </div>
                            <div className="flex items-center justify-between px-3 py-2.5 bg-white rounded-xl border border-slate-200 shadow-sm">
                                <div className="flex items-center gap-3">
                                    <UserButton afterSignOutUrl="/" />
                                    <div className="flex flex-col">
                                        <span className="text-xs font-black text-slate-900 truncate max-w-[120px]">
                                            {user?.fullName || "Agent Identity"}
                                        </span>
                                        <span className="text-[10px] text-slate-500 uppercase font-black tracking-tighter">
                                            Enterprise Tier
                                        </span>
                                    </div>
                                </div>
                                <Settings className="w-4 h-4 text-slate-400 hover:text-indigo-600 transition-colors cursor-pointer" />
                            </div>
                        </div>
                    ) : (
                        <div className="h-[92px] w-full bg-slate-100/50 rounded-2xl animate-pulse" />
                    )}
                </div>
            </aside>

            {/* Split Content Layer (30/70) */}
            <div className="flex-1 flex overflow-hidden relative">
                {/* 1. Analysis Pane (Chat/Narrative) */}
                {isChatVisible && (
                <section
                    style={{ width: isGraphVisible ? `${chatWidth}%` : '100%' }}
                    className="flex flex-col border-r border-border relative bg-white shrink-0 z-10"
                >
                    <header className="h-16 border-b border-border flex items-center justify-between px-8 bg-white/80 backdrop-blur-md z-10 shrink-0">
                        <div className="flex items-center gap-4">
                            <History className="w-4 h-4 text-primary" />
                            <span className="text-xs font-black uppercase tracking-widest text-primary">Institutional Memory</span>
                        </div>
                        <button
                            onClick={() => setIsChatVisible(false)}
                            className="p-2 rounded-xl text-slate-400 hover:text-primary hover:bg-slate-100 transition-all"
                            title="Collapse analysis panel"
                        >
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                    </header>

                    <div className="flex-1 overflow-y-auto p-8 space-y-8 pb-32">
                        {messages.map((msg, i) => (
                            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                <div className={`max-w-[95%] ${msg.role === 'user' ? 'bg-secondary p-5 rounded-2xl text-foreground font-medium shadow-sm ring-1 ring-border' : 'text-foreground'}`}>
                                    <A2UIRenderer message={msg.content} />
                                </div>
                            </div>
                        ))}
                        {isProcessing && (
                            <div className="flex justify-start">
                                <div className="flex items-center gap-3 text-primary text-sm font-bold animate-pulse">
                                    <BrainCircuit className="w-4 h-4" />
                                    Synthesizing...
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Chat Input Floating Box */}
                    <div className="absolute bottom-0 left-0 right-0 p-8 pt-0 bg-gradient-to-t from-white via-white to-transparent">
                        <div className="relative shadow-2xl shadow-primary/10 rounded-2xl overflow-hidden ring-1 ring-border">
                            <input
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                                disabled={!isConnected || isProcessing}
                                placeholder="Command your Cognitive Graph..."
                                className="w-full bg-white border-0 p-5 pr-16 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all text-foreground font-medium"
                            />
                            {isProcessing ? (
                                <button
                                    onClick={abortQuery}
                                    className="absolute right-3 top-3 p-2 bg-rose-500 hover:bg-rose-600 text-white rounded-xl transition-all shadow-lg animate-in zoom-in"
                                >
                                    <Square className="w-5 h-5 fill-white" />
                                </button>
                            ) : (
                                <button
                                    onClick={handleSend}
                                    disabled={!isConnected || !input.trim()}
                                    className="absolute right-3 top-3 p-2 bg-primary hover:bg-primary/90 text-white rounded-xl transition-all shadow-lg disabled:opacity-50"
                                >
                                    <SendHorizontal className="w-5 h-5" />
                                </button>
                            )}
                        </div>
                    </div>
                </section>
                )}

                {/* Resizable Divider */}
                {isGraphVisible && isChatVisible && (
                    <div 
                        onMouseDown={startResizing}
                        className="w-1 cursor-col-resize bg-border hover:bg-primary/30 transition-colors flex items-center justify-center group z-30"
                    >
                        <div className="h-10 w-px bg-slate-300" />
                        <GripVertical className="absolute w-4 h-4 text-primary opacity-0 group-hover:opacity-100" />
                    </div>
                )}

                {/* 2. Immersive Visual Section (70%) */}
                {isGraphVisible && (
                    <section className="flex-1 bg-slate-50 relative overflow-hidden group min-w-0">
                        {/* Minimize Control */}
                        <div className="absolute top-6 right-6 z-20">
                            <button 
                                onClick={() => setIsGraphVisible(false)}
                                className="p-3 bg-white border border-border rounded-xl text-slate-400 hover:text-primary shadow-xl hover:scale-110 transition-all"
                            >
                                <ChevronRight className="w-5 h-5" />
                            </button>
                        </div>
                        
                        <div className="w-full h-full relative">
                            {/* Visual Action Bar */}
                            <div className="absolute top-6 left-6 z-20 flex items-center gap-6">
                                {/* Restore Analysis Panel */}
                                {!isChatVisible && (
                                    <button
                                        onClick={() => setIsChatVisible(true)}
                                        className="bg-white/80 hover:bg-indigo-50 border border-border hover:border-indigo-200 text-slate-600 hover:text-primary px-4 py-2.5 rounded-2xl text-xs font-black uppercase tracking-widest backdrop-blur-md transition-all flex items-center gap-2 shadow-lg"
                                    >
                                        <ChevronRight className="w-4 h-4" />
                                        Analysis
                                    </button>
                                )}
                                {/* Perspective Switcher */}
                                <div className="flex bg-white/80 backdrop-blur-md border border-border p-1 rounded-2xl shadow-xl ring-1 ring-primary/5">
                                    <button 
                                        onClick={() => setViewMode('brain')}
                                        className={`px-5 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all gap-2 flex items-center ${
                                            viewMode === 'brain' 
                                            ? 'bg-primary text-white shadow-lg shadow-primary/20' 
                                            : 'text-slate-400 hover:text-primary hover:bg-primary/5'
                                        }`}
                                    >
                                        <BrainCircuit className="w-4 h-4" />
                                        The Brain
                                    </button>
                                    <button 
                                        onClick={() => setViewMode('spine')}
                                        className={`px-5 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all gap-2 flex items-center ${
                                            viewMode === 'spine' 
                                            ? 'bg-primary text-white shadow-lg shadow-primary/20' 
                                            : 'text-slate-400 hover:text-primary hover:bg-primary/5'
                                        }`}
                                    >
                                        <Activity className="w-4 h-4" />
                                        The Spine
                                    </button>
                                </div>

                                {graphData.nodes.length > 0 && (
                                    <button 
                                        onClick={() => {
                                            setGraphData({ nodes: [], links: [] });
                                            setSelectedNode(null);
                                            setNodeExpansionDepth(new Map());
                                            expansionCache.current = new Map();
                                            expandedNodes.current = new Set();
                                            expansionContributions.current = new Map();
                                        }}
                                        className="bg-white/80 hover:bg-rose-50 border border-border hover:border-rose-200 text-slate-600 hover:text-rose-600 px-4 py-2.5 rounded-2xl text-xs font-black uppercase tracking-widest backdrop-blur-md transition-all flex items-center gap-2 shadow-lg"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                        Clear Visual Map
                                    </button>
                                )}
                            </div>

                            <EnterpriseGraph
                                data={graphData}
                                focusYear={focusYear}
                                viewMode={viewMode}
                                selectedNodeId={selectedNode?.id}
                                focusedNodeIds={focusedNodeIds}
                                expandedNodeKeys={expandedNodes.current}
                                onNodeClick={handleNodeClick}
                                onNodeDoubleClick={handleNodeDoubleClick}
                                onTimelineChange={(year) => setFocusYear(year)}
                            />

                            {selectedNode && (
                                <div className="absolute inset-y-0 right-0 z-40 pointer-events-auto">
                                    <BentoDetailPanel
                                        node={selectedNode}
                                        allNodes={graphData.nodes}
                                        allLinks={graphData.links}
                                        onClose={() => setSelectedNode(null)}
                                        onDiscoverBridge={(nodeId) => handleDiscoverBridge(nodeId, selectedNode)}
                                        domainSignal={domainSignal}
                                        isBentoHydrating={isBentoHydrating}
                                    />
                                </div>
                            )}
                        </div>

                        {/* Visual Ontology Legend */}
                        {graphData.nodes.length > 0 && (
                            <div className="absolute top-[80px] left-6 z-20 bg-white/90 backdrop-blur-xl border border-border rounded-2xl shadow-2xl ring-1 ring-primary/5 transition-all">
                                <button
                                    onClick={() => setLegendOpen(o => !o)}
                                    className="flex items-center gap-2 w-full px-4 py-2.5 text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                                >
                                    <span className="flex-1 text-left">Active Context Domain</span>
                                    <span className="text-[11px] text-slate-400">{legendOpen ? "▲" : "▼"}</span>
                                </button>
                                {legendOpen && (
                                    <div className="px-4 pb-4 flex flex-col gap-3">
                                        <div className="flex flex-wrap gap-5 max-w-xs">
                                            {Array.from(new Set(graphData.nodes.map(n => n.type)))
                                                .filter(type => type !== "PreparatoryNote")
                                                .map(type => {
                                                const theme = getThemeForType(type);
                                                return (
                                                    <div key={type} className="flex items-center gap-2.5">
                                                        <div className={`w-3 h-3 rounded-full ${theme.tailwind} ring-2 ring-white shadow-lg`} />
                                                        <span className="text-[11px] text-slate-700 font-bold capitalize tracking-tight">{type}</span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                        {/* Interaction affordance key */}
                                        <div className="pt-2 border-t border-slate-100 flex flex-col gap-1.5">
                                            <div className="flex items-center gap-2">
                                                <span className="text-[10px] font-black text-indigo-600 bg-indigo-50 rounded px-1.5 py-0.5">⊕</span>
                                                <span className="text-[10px] text-slate-500 font-medium">Double-click to expand</span>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className="text-[10px] font-black text-slate-400 bg-slate-50 rounded px-1.5 py-0.5">○</span>
                                                <span className="text-[10px] text-slate-500 font-medium">Click for details</span>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className="text-[10px] font-black text-amber-500 bg-amber-50 rounded px-1.5 py-0.5">✦</span>
                                                <span className="text-[10px] text-slate-500 font-medium">Federated bridge</span>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </section>
                )}
            </div>
        </div>
    );
}
