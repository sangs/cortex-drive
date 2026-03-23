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
    ChevronLeft
} from "lucide-react";
import A2UIRenderer from "@/components/a2ui/A2UIRenderer";
import GraphViewer from "@/components/GraphViewer";
import { useMCP } from "@/hooks/use-mcp";

export default function DashboardPage() {
    const { isConnected, query } = useMCP();
    const [messages, setMessages] = useState<any[]>([
        {
            role: "assistant",
            content: "Hello! I'm your Cortex Brain. Ask me anything about your podcast library, or start an analysis.",
        }
    ]);
    const [graphData, setGraphData] = useState<{ nodes: any[], links: any[] }>({ nodes: [], links: [] });
    const [input, setInput] = useState("");
    const [isProcessing, setIsProcessing] = useState(false);
    
    // Layout State
    const [chatWidth, setChatWidth] = useState(40); // percentage
    const [isGraphVisible, setIsGraphVisible] = useState(true);
    const isResizing = useRef(false);

    // Helper to parse tool data into graph format
    const parseDataToGraph = (rawData: string, currentGraph: { nodes: any[], links: any[] }) => {
        try {
            const data = JSON.parse(rawData);
            const nodes = [...currentGraph.nodes];
            const links = [...currentGraph.links];

            const addNode = (node: any) => {
                if (!node.id) return null;
                const existing = nodes.find(n => n.id === node.id);
                if (!existing) {
                    nodes.push(node);
                    return true;
                }
                return false;
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
                const nameKeys = ['episode_name', 'name', 'SeedEpisode', 'EpisodeTitle', 'e.name', 'n.name', 'title'];
                const idKeys = ['episode_number', 'SeedEpisodeNumber', 'EpisodeNumber', 'id', 'e.episode_number'];
                
                const name = extractValue(item, nameKeys);
                if (!name) return;

                const num = extractValue(item, idKeys) || `node-${idx}-${Date.now()}`;
                const type = (name.toLowerCase().includes('mcp') || name.toLowerCase().includes('baml')) ? 'Episode' : (item.type || 'Episode');
                const id = `node-${num}`;
                
                const seedDetails = item.Details || item;
                addNode({ id, name, type, val: 10, ...seedDetails });

                // 2. Handle GDS/Hybrid Search "Similar" nodes
                const simName = extractValue(item, ['SimilarEpisode', 'target_name', 'related_name']);
                if (simName) {
                    const simNum = extractValue(item, ['SimilarEpisodeNumber', 'target_id']) || `sim-${idx}`;
                    const simId = `node-${simNum}`;
                    addNode({ id: simId, name: simName, type: 'Episode', val: 8 });
                    addLink({ source: id, target: simId, type: 'SIMILAR' });
                }

                // 3. Metadata Enrichment (Topics/People/Tech)
                const metadata = [
                    { key: ['topics', 'Topics', 'topic'], type: 'Topic', linkType: 'HAS_TOPIC' },
                    { key: ['person_name', 'Person', 'people'], type: 'Person', linkType: 'HAS_PARTICIPANT' },
                    { key: ['technologies', 'Technology', 'tech'], type: 'Technology', linkType: 'COVERS_TECHNOLOGY' }
                ];

                metadata.forEach(m => {
                    const vals = extractValue(item, m.key);
                    if (vals) {
                        const valsArray = Array.isArray(vals) ? vals : [vals];
                        valsArray.forEach((v: string) => {
                            if (typeof v !== 'string') return;
                            const vId = `${m.type.toLowerCase()}-${v}`;
                            addNode({ id: vId, name: v, type: m.type, val: 5 });
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
                        const relType = extractValue(rel, ['rel_type', 'relationship', 'type']) || 'RELATED_TO';
                        const targetId = rel.target_id || `${targetType.toLowerCase()}-${targetName.replace(/\\s+/g, '-')}`;
                        
                        addNode({ id: targetId, name: targetName, type: targetType, val: 5, ...rel });
                        addLink({ source: id, target: targetId, type: relType });
                    });
                }
            };

            if (Array.isArray(data)) {
                data.forEach((item, idx) => processItem(item, idx));
            } else if (typeof data === 'object' && data !== null) {
                processItem(data, 0);
            }

            return { nodes, links };
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

            // 2. Update graph data if raw_data is present
            if (result.raw_data) {
                const newGraph = parseDataToGraph(result.raw_data, graphData);
                setGraphData(newGraph);
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
                content: "Hello! I'm your Cortex Brain. Ask me anything about your podcast library, or start an analysis.",
            }
        ]);
        setGraphData({ nodes: [], links: [] });
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
                        <div className="w-full h-full">
                            <GraphViewer 
                                data={graphData} 
                                isProcessing={isProcessing} 
                            />
                        </div>

                        {/* Status Legend */}
                        {graphData.nodes.length > 0 && (
                            <div className="absolute bottom-6 left-6 z-20 bg-slate-900/80 backdrop-blur border border-white/5 rounded-2xl p-4 flex flex-col gap-2 pointer-events-none">
                                <div className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                                     Visible Knowledge Nodes
                                </div>
                                <div className="flex flex-wrap gap-4">
                                    {Array.from(new Set(graphData.nodes.map(n => n.type))).map(type => {
                                        const colors: Record<string, string> = {
                                            Episode: "bg-sky-500 shadow-[0_0_8px_rgba(14,165,233,0.5)]",
                                            Topic: "bg-purple-500 shadow-[0_0_8px_rgba(168,85,247,0.5)]",
                                            Person: "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]",
                                            Chunk: "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]",
                                            Technology: "bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)]",
                                            ReferenceLink: "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]"
                                        };
                                        const colorClass = colors[type] || "bg-slate-400 shadow-[0_0_8px_rgba(148,163,184,0.5)]";
                                        
                                        return (
                                            <div key={type} className="flex items-center gap-2">
                                                <div className={`w-2 h-2 rounded-full ${colorClass}`} />
                                                <span className="text-[10px] text-slate-400 capitalize">{type}</span>
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
