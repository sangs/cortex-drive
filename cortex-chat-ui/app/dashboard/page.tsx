"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { UserButton, OrganizationSwitcher } from "@clerk/nextjs";
import {
    Plus,
    Search,
    BrainCircuit,
    History,
    Settings,
    SendHorizontal,
    Wifi,
    WifiOff,
    Maximize2,
    Database,
    Network,
    GripVertical,
    ChevronRight,
    ChevronLeft,
    Trash2
} from "lucide-react";
import A2UIRenderer from "@/components/a2ui/A2UIRenderer";
import dynamic from "next/dynamic";
import { useMCP } from "@/hooks/use-mcp";

// 1. Dynamic Imports for heavy/client-only UI components to prevent Hydration errors
const EnterpriseGraph = dynamic(() => import("@/components/EnterpriseGraph"), { ssr: false });
const BentoDetailPanel = dynamic(() => import("@/components/BentoDetailPanel"), { ssr: false });
import { getThemeForType } from "@/utils/GraphTheme";

export default function DashboardPage() {
    const { isConnected, query, callTool } = useMCP();
    const [messages, setMessages] = useState<any[]>([
        {
            role: "assistant",
            content: "Cortex-Drive: Grounded Intelligence at Scale. Ask me anything across your enterprise context graph or explore your portfolio.",
        }
    ]);
    const [graphData, setGraphData] = useState<{ nodes: any[], links: any[] }>({ nodes: [], links: [] });
    const [input, setInput] = useState("");
    const [isProcessing, setIsProcessing] = useState(false);
    
    // Layout State
    const [chatWidth, setChatWidth] = useState(40); // percentage
    const [isGraphVisible, setIsGraphVisible] = useState(true);
    const [selectedNode, setSelectedNode] = useState<any | null>(null);
    const [focusYear, setFocusYear] = useState<string | null>(null);
    const [autoClear, setAutoClear] = useState(true); // TDD: Focus Mode (Clear Map between queries)
    const isResizing = useRef(false);

    // Helper to parse tool data into graph format
    const parseDataToGraph = (rawData: string, currentGraph: { nodes: any[], links: any[] }) => {
        try {
            const parsedRaw = JSON.parse(rawData);
            
            const nodes = [...currentGraph.nodes];
            const links = [...currentGraph.links];

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
                        if (!exists) links.push(l);
                    });
                }
                return { nodes, links };
            }

            const rawResults = Array.isArray(parsedRaw) ? parsedRaw : [rawData];

            const addNode = (node: any) => {
                if (!node.id || node.type === 'PreparatoryNote') return null;
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
                
                // Ensure both source and target exist in the current node set
                const sourceExists = nodes.some(n => n.id === link.source);
                const targetExists = nodes.some(n => n.id === link.target);
                if (!sourceExists || !targetExists) return;

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

                const id = name; // Standardize on name for cross-layer parity
                
                // Identify normalized time marker
                const timeValue = extractValue(seedDetails, dateKeys);
                const year = timeValue ? (String(timeValue).match(/\d{4}/)?.[0] || null) : null;
                const date = timeValue || null;

                // Smart Type Inference: Only use 'Episode' if keywords match, otherwise default to 'Node' 
                // for professional entities to prevent visual misidentification.
                const type = (name.toLowerCase().includes('mcp') || name.toLowerCase().includes('baml')) ? 'Episode' : (seedDetails.type || 'Node');
                addNode({ id, name, type, val: 10, year, date, ...seedDetails });

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
                        const targetId = targetName; // Standardize on name
                        
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
                            data.links.forEach((l: any) => addLink(l));
                        }
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

            return { nodes, links: finalLinks };
        } catch (e) {
            console.error("Failed to parse graph data", e);
            return currentGraph;
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

            // Use the orchestration query with history
            const result = await query(userMsg, history);
            
            // 1. Add assistant text answer
            setMessages(prev => [...prev, { 
                role: "assistant", 
                content: result.answer 
            }]);

            if (result.raw_data) {
                // Focus Mode: Clear existing graph if autoClear is enabled
                const contextGraph = autoClear ? { nodes: [], links: [] } : graphData;
                const newGraph = parseDataToGraph(result.raw_data, contextGraph);
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
            console.log("Hydrating node:", node.id || node.name);
            const toolResponse = await callTool("get_node_details", { node_name: node.id || node.name });
            if (toolResponse && toolResponse.content && toolResponse.content[0]) {
                const payload = JSON.parse(toolResponse.content[0].text);
                if (!payload.message) {
                    setSelectedNode((prev: any) => {
                        // Ensure we haven't clicked away during the await
                        if (!prev || (prev.id !== node.id && prev.name !== node.name)) return prev;
                        return {
                            ...prev,
                            technologies: payload.technologies || prev.technologies,
                            description: (payload.narratives && payload.narratives.length > 0) ? payload.narratives.join('\n\n') : prev.description,
                            links: Array.from(new Set([...(prev.links || []), ...(payload.ref_urls || [])]))
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
            const toolResponse = await callTool("expand_node_topology", { node_name: node.id || node.name });
            if (toolResponse && toolResponse.content && toolResponse.content[0]) {
                const newGraph = parseDataToGraph(toolResponse.content[0].text, graphData);
                setGraphData(newGraph);
            }
        } catch (e) {
            console.error("Graph expansion failed:", e);
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
        <div className="flex h-screen bg-slate-950 overflow-hidden text-slate-100">
            {/* Sidebar (Fixed Width) */}
            <aside className="w-72 border-r border-white/5 flex flex-col bg-slate-900/50 backdrop-blur-xl z-20 shrink-0">
                <div className="p-6 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
                        <BrainCircuit className="text-white w-6 h-6" />
                    </div>
                    <span className="text-xl font-bold tracking-tight">CortexDrive</span>
                </div>

                <nav className="flex-1 px-4 space-y-2 py-4">
                    <button 
                        onClick={startNewAnalysis}
                        className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition-all group"
                    >
                        <Plus className="w-5 h-5 text-indigo-400 group-hover:scale-110 transition-transform" />
                        <span className="font-medium">New Analysis</span>
                    </button>

                    <div className="pt-6 pb-2 px-4 text-xs font-semibold text-slate-500 uppercase tracking-widest flex items-center justify-between">
                        <span>System Health</span>
                        {isConnected ? <Wifi className="w-3 h-3 text-emerald-500" /> : <WifiOff className="w-3 h-3 text-red-500" />}
                    </div>

                    <div className="space-y-1 px-2">
                        <div className="flex items-center gap-3 px-4 py-2 text-sm text-slate-400">
                            <Database className="w-4 h-4" />
                            <span>Neo4j Instance</span>
                        </div>
                        <div className="flex items-center gap-3 px-4 py-2 text-sm text-slate-400">
                            <Network className="w-4 h-4" />
                            <span>MCP Server</span>
                        </div>
                    </div>

                    <div className="pt-6 pb-2 px-4 text-xs font-semibold text-slate-500 uppercase tracking-widest flex items-center justify-between">
                        <span>Graph Mode</span>
                    </div>
                    <div className="px-4 py-2">
                        <button 
                            onClick={() => setAutoClear(!autoClear)}
                            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all ${
                                autoClear 
                                ? 'bg-indigo-600/10 border-indigo-500/30 text-indigo-400' 
                                : 'bg-white/5 border-white/5 text-slate-400'
                            }`}
                        >
                            <div className="flex items-center gap-2 text-sm font-medium">
                                <Trash2 className={`w-4 h-4 ${autoClear ? 'animate-pulse' : ''}`} />
                                <span>Focus Mode</span>
                            </div>
                            <div className={`w-8 h-4 rounded-full relative transition-colors ${autoClear ? 'bg-indigo-600' : 'bg-slate-700'}`}>
                                <div className={`absolute top-1 w-2 h-2 bg-white rounded-full transition-all ${autoClear ? 'left-5' : 'left-1'}`} />
                            </div>
                        </button>
                        <p className="mt-2 text-[10px] text-slate-500 leading-tight">
                            {autoClear 
                                ? "Graph clears automatically between answers to ensure focus." 
                                : "Accumulate nodes across multiple queries for discovery."}
                        </p>
                    </div>

                    {!isGraphVisible && (
                        <div className="pt-8 px-2">
                             <button 
                                onClick={() => setIsGraphVisible(true)}
                                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-indigo-600/10 border border-indigo-500/20 text-indigo-400 hover:bg-indigo-600/20 transition-all"
                            >
                                <Maximize2 className="w-4 h-4" />
                                <span className="text-sm font-medium">Show Graph</span>
                            </button>
                        </div>
                    )}
                </nav>

                <div className="p-4 border-t border-white/5 flex flex-col gap-4">
                    <div className="px-2">
                        <OrganizationSwitcher 
                            afterCreateOrganizationUrl="/dashboard"
                            afterLeaveOrganizationUrl="/dashboard"
                            afterSelectOrganizationUrl="/dashboard"
                            appearance={{
                                baseTheme: undefined,
                                elements: {
                                    rootBox: "w-full",
                                    organizationSwitcherTrigger: "w-full bg-white/5 border border-white/5 px-4 py-2 rounded-xl text-white hover:bg-white/10 transition-all",
                                    organizationPreviewTextContainer: "text-white",
                                    organizationPreviewMainIdentifier: "text-white font-medium",
                                }
                            }}
                        />
                    </div>
                    
                    <div className="flex items-center justify-between px-2">
                        <div className="flex items-center gap-3">
                            <UserButton afterSignOutUrl="/" />
                            <div className="flex flex-col">
                                <span className="text-sm font-medium">My Brain</span>
                                <span className="text-xs text-slate-500 truncate max-w-[120px]">Authenticated</span>
                            </div>
                        </div>
                        <button className="p-2 text-slate-500 hover:text-white transition-colors">
                            <Settings className="w-5 h-5" />
                        </button>
                    </div>
                </div>
            </aside>

            {/* Split Content Layer */}
            <div className="flex-1 flex overflow-hidden relative">
                {/* Chat Section */}
                <section 
                    style={{ width: isGraphVisible ? `${chatWidth}%` : '100%' }}
                    className="flex flex-col border-r border-white/5 relative bg-slate-950/20 backdrop-blur-sm shrink-0"
                >
                    {/* Header */}
                    <header className="h-16 border-b border-white/5 flex items-center justify-between px-8 bg-slate-950/50 backdrop-blur-md z-10 shrink-0">
                        <div className="flex items-center gap-4">
                            <History className="w-5 h-5 text-slate-500" />
                            <span className="text-sm font-medium text-slate-400">Intelligent Orchestration</span>
                        </div>
                    </header>

                    {/* Messages */}
                    <div className="flex-1 overflow-y-auto p-8 space-y-8 pb-32">
                        {messages.map((msg, i) => (
                            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                <div className={`max-w-[90%] ${msg.role === 'user' ? 'bg-indigo-600/10 border border-indigo-500/20 p-4 rounded-2xl' : ''}`}>
                                    <A2UIRenderer message={msg.content} />
                                </div>
                            </div>
                        ))}
                        {isProcessing && (
                            <div className="flex justify-start">
                                <div className="flex items-center gap-2 text-slate-500 text-sm animate-pulse">
                                    <BrainCircuit className="w-4 h-4" />
                                    Synthesizing graph response...
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Chat Input */}
                    <div className="absolute bottom-0 left-0 right-0 p-8 pt-0 bg-gradient-to-t from-slate-950 via-slate-950 to-transparent">
                        <div className="relative">
                            <input
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                                disabled={!isConnected || isProcessing}
                                placeholder={isConnected ? "Query your Mental Model..." : "Connecting..."}
                                className="w-full bg-slate-900/80 backdrop-blur-xl border border-white/10 rounded-2xl p-4 pr-16 focus:outline-none focus:border-indigo-500/50 transition-all text-slate-200"
                            />
                            <button
                                onClick={handleSend}
                                disabled={!isConnected || isProcessing || !input.trim()}
                                className="absolute right-3 top-2.5 p-2 bg-indigo-600 hover:bg-indigo-500 rounded-xl transition-all"
                            >
                                <SendHorizontal className="w-5 h-5 text-white" />
                            </button>
                        </div>
                    </div>
                </section>

                {/* Resizable Divider */}
                {isGraphVisible && (
                    <div 
                        onMouseDown={startResizing}
                        className="w-1 cursor-col-resize bg-white/5 hover:bg-indigo-500/30 transition-colors flex items-center justify-center group"
                    >
                        <div className="h-8 w-px bg-white/20 group-hover:bg-indigo-400" />
                        <GripVertical className="absolute w-3 h-3 text-white/20 group-hover:text-indigo-400 opacity-0 group-hover:opacity-100" />
                    </div>
                )}

                {/* Graph Visualization Section */}
                {isGraphVisible && (
                    <section className="flex-1 bg-slate-950 relative overflow-hidden group min-w-0">
                        <div className="absolute top-6 right-6 z-20 flex gap-2">
                            <button 
                                onClick={() => setIsGraphVisible(false)}
                                title="Minimize Graph"
                                className="p-2 bg-slate-900/80 backdrop-blur border border-white/10 rounded-xl text-slate-400 hover:text-white transition-colors"
                            >
                                <ChevronRight className="w-4 h-4" />
                            </button>
                        </div>
                        
                        {/* The Visual Engine */}
                        <div className="w-full h-full relative group">
                            {/* Manual Clear Control Overlay */}
                            {graphData.nodes.length > 0 && (
                                <div className="absolute top-4 left-4 z-20 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button 
                                        onClick={() => {
                                            setGraphData({ nodes: [], links: [] });
                                            setSelectedNode(null);
                                        }}
                                        className="bg-slate-800/80 hover:bg-rose-500/20 text-slate-300 hover:text-rose-400 border border-slate-700 hover:border-rose-500/50 px-3 py-1.5 rounded-md text-xs font-semibold backdrop-blur-md transition-all flex items-center gap-2 shadow-xl"
                                        title="Manually clear the visual canvas"
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                        Clear Map
                                    </button>
                                </div>
                            )}

                        <EnterpriseGraph 
                                data={graphData} 
                                focusYear={focusYear}
                                selectedNodeId={selectedNode?.id}
                                onNodeClick={handleNodeClick}
                                onNodeDoubleClick={handleNodeDoubleClick}
                                onTimelineChange={(year) => setFocusYear(year)}
                            />

                            {/* Bento Vault (Slide-out) */}
                            <BentoDetailPanel 
                                node={selectedNode}
                                allNodes={graphData.nodes}
                                allLinks={graphData.links}
                                onClose={() => setSelectedNode(null)}
                            />
                        </div>

                        {/* Status Legend (Absolute but offset to prevent covering timeline) */}
                        {graphData.nodes.length > 0 && (
                            <div className="absolute top-[80px] left-6 z-20 bg-slate-900/80 backdrop-blur border border-white/5 rounded-2xl p-4 flex flex-col gap-2 pointer-events-none transition-all">
                                <div className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                                     Visible Knowledge Nodes
                                </div>
                                <div className="flex flex-wrap gap-4">
                                    {Array.from(new Set(graphData.nodes.map(n => n.type)))
                                        .filter(type => type !== "PreparatoryNote")
                                        .map(type => {
                                        const theme = getThemeForType(type);
                                        const colorClass = theme.tailwind;
                                        
                                        return (
                                            <div key={type} className="flex items-center gap-2">
                                                <div className={`w-2.5 h-2.5 rounded-full ${colorClass} ring-1 ring-white/10`} />
                                                <span className="text-[10px] text-slate-300 font-medium capitalize">{type}</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </section>
                )}
            </div>
        </div>
    );
}
