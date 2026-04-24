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

// Progressive Discovery: High-Fidelity backbone nodes that serve as primary landmarks.
const BACKBONE_LANDMARKS = [
    'Category', 'Company', 'Startup', 'Hackathon', 'ThoughtLeadership', 
    'Institution', 'Degree', 'Certification', 'Podcast', 'Publication', 'Role', 'Year', 'Person',
    'Episode', 'Topic', 'Chunk'
];

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
    const [viewMode, setViewMode] = useState<'brain' | 'spine'>('brain');
    const [selectedNode, setSelectedNode] = useState<any | null>(null);
    const [focusYear, setFocusYear] = useState<string | null>(null);
    const [autoClear, setAutoClear] = useState(true); // TDD: Focus Mode (Clear Map between queries)
    const [contextualFusion, setContextualFusion] = useState(true); // Always on: Intent-Based Bridge Discovery
    const [hasMounted, setHasMounted] = useState(false);
    const isResizing = useRef(false);

    useEffect(() => {
        setHasMounted(true);
    }, []);

    // Helper to parse tool data into graph format
    const parseDataToGraph = (rawData: any, existingData?: any, backboneOnly: boolean = false) => {
        try {
            if (!rawData) return existingData || { nodes: [], links: [] };
            const parsedRaw = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
            
            // Start with existing data for additive hydration
            const nodes = existingData ? [...existingData.nodes] : [];
            const links = existingData ? [...existingData.links] : [];

            // Helper to decide if a node should even be added in backbone-only mode
            const isAllowed = (nodeType: string) => {
                if (!backboneOnly) return true;
                return BACKBONE_LANDMARKS.includes(nodeType);
            };

            // Direct Graph Fragment Handling (e.g. from expand_node_topology)
            if (parsedRaw.nodes && Array.isArray(parsedRaw.nodes)) {
                parsedRaw.nodes.forEach((n: any) => {
                    if (!n.id) return;
                    const existingIdx = nodes.findIndex(node => node.id === n.id);
                    if (existingIdx === -1) nodes.push(n);
                    else nodes[existingIdx] = { ...nodes[existingIdx], ...n };
                });
                if (parsedRaw.links && Array.isArray(parsedRaw.links)) {
                    parsedRaw.links.forEach((l: any) => {
                        const exists = links.some(link => 
                            (link.source === l.source && link.target === l.target) ||
                            (link.source === l.target && link.target === l.source)
                        );
                        if (!exists) links.push({
                            ...l,
                            isVirtual: l.type === 'VIRTUAL_BRIDGE',
                            label: l.type === 'VIRTUAL_BRIDGE' ? { show: true, formatter: l.discovery_reason } : undefined
                        });
                    });
                }
                return { nodes, links };
            }

            const rawResults = Array.isArray(parsedRaw) ? parsedRaw : [parsedRaw];

            const addNode = (node: any) => {
                if (!node.id || node.type === 'PreparatoryNote') return null;
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

                // 3. Metadata Enrichment (Topics/People) - Removed Tech to stop floating nodes
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

            // Interaction Affordance Pass: Tag nodes so the graph can render visual cues.
            // isExpandable: node is a hub type AND has at least one linked neighbor → shows ⊕ badge + indigo aura
            // isBentoEligible: all named nodes support single-click Bento → shows glow
            const HUB_TYPES = new Set([
                'Company', 'Category', 'Startup', 'Role', 'Person',
                'Episode', 'Topic', 'Institution', 'Podcast', 'Degree'
            ]);
            nodes.forEach(node => {
                node.isBentoEligible = !!(node.name);
                const hasLinks = finalLinks.some(l => l.source === node.id || l.target === node.id);
                node.isExpandable = HUB_TYPES.has(node.type) && hasLinks;
            });

            return { nodes, links: finalLinks };
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

            // Use the orchestration query with history and Fusion preference
            const result = await query(userMsg, history, forceRefresh, contextualFusion);
            
            // 1. Add assistant text answer
            setMessages(prev => [...prev, { 
                role: "assistant", 
                content: result.answer 
            }]);

            if (result.raw_data) {
                // Focus Mode: Clear existing graph if autoClear is enabled
                const contextGraph = autoClear ? { nodes: [], links: [] } : graphData;
                // Initial Load Enrichment: Use backboneOnly: true to prevent map flooding
                const newGraph = parseDataToGraph(result.raw_data, contextGraph, true);
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
    };

    const handleNodeClick = async (node: any) => {
        // Optimistically open Bento instantly
        setSelectedNode(node);
        
        try {
            console.log("Hydrating node (High-Speed Path via Gateway):", node.id || node.name);
            const token = await getToken();
            const response = await fetch('http://localhost:4000/api/get_node_details', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ 
                    node_name: node.name, 
                    node_id: node.element_id || node.id 
                })
            });

            if (response.ok) {
                const results = await response.json();
                // handle direct result or tool-wrapped result
                const payload = Array.isArray(results) ? results[0] : (results.result?.content ? JSON.parse(results.result.content[0].text)[0] : results);
                
                if (payload && !payload.error) {
                    setSelectedNode((prev: any) => {
                        if (!prev || prev.id !== node.id) return prev;
                        
                        // DEEP PROPERTY EXTRACTION: Handle nested properties or tool-specific keys
                        const p = payload.properties || payload;
                        const narratives = payload.narratives || (p.text ? [p.text] : (p.description ? [p.description] : []));
                        const description = narratives.length > 0 ? narratives.join('\n\n') : (p.description || prev.description);
                        const tech = p.technologies || p.tech_stack || p.tools || prev.technologies;
                        const refLinks = payload.ref_urls || p.links || p.ref_urls || [];
                        
                        return {
                            ...prev,
                            ...p,
                            description,
                            text: description,
                            technologies: Array.isArray(tech) ? tech : (tech ? [tech] : []),
                            links: Array.from(new Set([...(prev.links || []), ...refLinks]))
                        };
                    });
                }
            }
        } catch (e) {
            console.error("Progressive hydration failed:", e);
        }
    };

    const handleNodeDoubleClick = async (node: any) => {
        try {
            console.log("Expanding topology for:", node.id || node.name);
            setIsProcessing(true);
            
            // Use get_cluster_context for high-fidelity backbone expansion
            // depth=1, backbone_only=false to hydrate with local details
            const toolResponse = await callTool("get_cluster_context", {
                node_name: node.name,
                depth: 1,
                backbone_only: false
            });

            if (toolResponse && toolResponse.content && toolResponse.content[0]) {
                const results = JSON.parse(toolResponse.content[0].text);
                // ADDITIVE HYDRATION: Pass current graphData to parseDataToGraph
                const newGraph = parseDataToGraph(results, graphData);
                setGraphData(newGraph);
            }
        } catch (e) {
            console.error("Progressive hydration failed:", e);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleDiscoverBridge = async (nodeId: string) => {
        try {
            console.log("Identifying cross-domain bridges for:", nodeId);
            setIsProcessing(true);
            const toolResponse = await callTool("connect_knowledge_on_demand", { 
                source_node_id: nodeId,
                target_domain: "podcast" // Cross-silo to podcasts by default
            });
            
            if (toolResponse && toolResponse.content && toolResponse.content[0]) {
                const results = JSON.parse(toolResponse.content[0].text);
                if (results.virtual_links && results.virtual_links.length > 0) {
                    const newGraph = parseDataToGraph(results, graphData);
                    setGraphData(newGraph);
                }
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
                <section 
                    style={{ width: isGraphVisible ? `${chatWidth}%` : '100%' }}
                    className="flex flex-col border-r border-border relative bg-white shrink-0 z-10"
                >
                    <header className="h-16 border-b border-border flex items-center justify-between px-8 bg-white/80 backdrop-blur-md z-10 shrink-0">
                        <div className="flex items-center gap-4">
                            <History className="w-4 h-4 text-primary" />
                            <span className="text-xs font-black uppercase tracking-widest text-primary">Institutional Memory</span>
                        </div>
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

                {/* Resizable Divider */}
                {isGraphVisible && (
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
                                        onDiscoverBridge={(nodeId) => handleDiscoverBridge(nodeId)}
                                    />
                                </div>
                            )}
                        </div>

                        {/* Visual Ontology Legend */}
                        {graphData.nodes.length > 0 && (
                            <div className="absolute top-[80px] left-6 z-20 bg-white/90 backdrop-blur-xl border border-border rounded-2xl p-5 flex flex-col gap-3 pointer-events-none transition-all shadow-2xl ring-1 ring-primary/5">
                                <div className="flex items-center gap-3 text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">
                                     Active Context Domain
                                </div>
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
                    </section>
                )}
            </div>
        </div>
    );
}
