"use client";

import dynamic from 'next/dynamic';
import { useEffect, useState, useRef, useMemo } from 'react';
import { 
    BrainCircuit, 
    Loader2, 
    ExternalLink, 
    Link as LinkIcon, 
    Globe, 
    Calendar,
    ChevronRight,
    Search
} from "lucide-react";
import { getThemeForType } from "@/utils/GraphTheme";
// @ts-ignore
import { forceCollide } from 'd3-force-3d';

// Dynamically import the graph to avoid SSR issues
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

interface GraphNode {
    id: string;
    name: string;
    type: string;
    val?: number;
    description?: string;
    link?: string;
    links?: string[];
    url?: string;
    startDate?: string;
    endDate?: string;
    status?: string;
    inferred_year?: number;
    [key: string]: any;
}

interface GraphLink {
    source: any;
    target: any;
    type?: string;
    start?: string;
    end?: string;
}

interface GraphData {
    nodes: GraphNode[];
    links: GraphLink[];
}

interface GraphViewerProps {
    data: GraphData;
    isProcessing?: boolean;
}

export default function GraphViewer({ data, isProcessing }: GraphViewerProps) {
    const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
    const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const fgRef = useRef<any>(null);

    // Initial sizing and resize listener
    useEffect(() => {
        const updateDimensions = () => {
            if (containerRef.current) {
                setDimensions({
                    width: containerRef.current.offsetWidth,
                    height: containerRef.current.offsetHeight
                });
            }
        };

        updateDimensions();
        window.addEventListener('resize', updateDimensions);
        return () => window.removeEventListener('resize', updateDimensions);
    }, []);

    // Configure d3 forces for better separation and chronological sorting
    useEffect(() => {
        if (fgRef.current) {
            // --- SECTION 8: ENHANCED PHYSICS ---
            fgRef.current.d3Force('charge').strength(-250);
            fgRef.current.d3Force('collision', forceCollide(25));
            fgRef.current.d3Force('center').strength(0.05);
            fgRef.current.d3Force('link').distance(80);
            
            // Y-Axis Gravity (Chronological Sorting)
            fgRef.current.d3Force('y', (node: any) => {
                const year = node.inferred_year || 2024;
                const normalizedYear = Math.max(2020, Math.min(2026, year));
                const yPos = ((2026 - normalizedYear) / 6) * (dimensions.height * 0.6) - (dimensions.height * 0.3);
                return yPos;
            });

            fgRef.current.d3ReheatSimulation();
        }
    }, [data, dimensions]);

    // Memoize the graph instance
    const graphInstance = useMemo(() => {
        if (dimensions.width === 0) return null;

        return (
            <ForceGraph2D
                ref={fgRef}
                graphData={data}
                width={dimensions.width}
                height={dimensions.height}
                nodeLabel="name"
                nodeRelSize={6}
                nodeAutoColorBy="type"
                backgroundColor="#020617" // Slate 950
                linkColor={() => "rgba(255, 255, 255, 0.08)"}
                linkDirectionalParticles={2}
                linkDirectionalParticleSpeed={() => 0.005}
                onNodeDragEnd={(node: any) => {
                    node.fx = node.x;
                    node.fy = node.y;
                }}
                cooldownTicks={100}
                onBackgroundClick={() => setSelectedNode(null)}
                // --- INTERACTION: DOUBLE CLICK EXPANSION & SELECTION ---
                onNodeClick={(node: any, event: MouseEvent) => {
                    if (event.detail === 2) {
                        // Double Click - Expansion
                        if (['Category', 'Project', 'Role', 'Hackathon', 'ThoughtLeadership'].includes(node.type)) {
                            const exploreEvent = new CustomEvent('EXPLORE_NODE', { 
                                detail: { nodeId: node.id, nodeName: node.name, nodeType: node.type } 
                            });
                            window.dispatchEvent(exploreEvent);
                        }
                    } else {
                        // Single Click - Selection
                        setSelectedNode(node);
                    }
                }}
                nodeCanvasObject={(node: any, ctx, globalScale) => {
                    const label = node.name;
                    const fontSize = 12 / globalScale;
                    ctx.font = `${fontSize}px Inter, sans-serif`;
                    const textWidth = ctx.measureText(label).width;
                    
                    // --- UNIFIED THEME SYSTEM ---
                    const theme = getThemeForType(node.type);
                    let radius = theme.radius;
                    let color = theme.hsl;

                    if (node.status === 'Active') {
                        radius = 14;
                        color = '#ffffff';
                    }

                    // Draw Node Circle
                    ctx.beginPath();
                    ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
                    ctx.fillStyle = color;
                    ctx.shadowColor = color;
                    ctx.shadowBlur = (node.type === 'Category' ? 40 : 15) / globalScale;
                    ctx.fill();
                    ctx.shadowBlur = 0;

                    // Label Rendering with Progressive Disclosure
                    if (globalScale > 0.8 || node.type === 'Category' || node.status === 'Active') {
                        const bgPadding = 2 / globalScale;
                        const labelYOffset = radius + 11 / globalScale;
                        
                        ctx.fillStyle = 'rgba(2, 6, 23, 0.8)';
                        ctx.fillRect(
                            node.x - textWidth / 2 - bgPadding,
                            node.y + labelYOffset - fontSize + 2,
                            textWidth + bgPadding * 2,
                            fontSize + bgPadding
                        );

                        ctx.fillStyle = (node.type === 'Category' || node.status === 'Active') ? '#ffffff' : 'rgba(255, 255, 255, 0.85)';
                        ctx.fillText(label, node.x - textWidth / 2, node.y + labelYOffset);
                    }
                }}
                // --- SECTION 7: TIMELINE LABELS ON EDGES ---
                linkCanvasObjectMode={() => 'after'}
                linkCanvasObject={(link: any, ctx, globalScale) => {
                    const label = link.start ? `${link.start}${link.end ? ' – ' + link.end : ''}` : '';
                    if (!label || globalScale < 0.6) return;

                    const start = link.source;
                    const end = link.target;
                    if (typeof start !== 'object' || typeof end !== 'object') return;

                    const middlePos = {
                        x: start.x + (end.x - start.x) / 2,
                        y: start.y + (end.y - start.y) / 2
                    };
                    
                    const fontSize = 7 / globalScale;
                    ctx.font = `${fontSize}px Inter, sans-serif`;
                    const textWidth = ctx.measureText(label).width;

                    ctx.save();
                    ctx.translate(middlePos.x, middlePos.y);
                    ctx.fillStyle = 'rgba(2, 6, 23, 0.8)';
                    ctx.beginPath();
                    ctx.roundRect(-textWidth/2 - 2, -fontSize/2 - 1, textWidth + 4, fontSize + 2, 2);
                    ctx.fill();
                    ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(label, 0, 0);
                    ctx.restore();
                }}
            />
        );
    }, [data, dimensions]);

    return (
        <div className="relative w-full h-full bg-slate-950" ref={containerRef}>
            {/* Empty State Overlay */}
            {data.nodes.length === 0 && !isProcessing && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600 gap-4">
                    <BrainCircuit className="w-12 h-12 opacity-20" />
                    <p className="text-sm font-medium">Ask a question to explore your Career Graph</p>
                </div>
            )}

            {/* Processing Overlay */}
            {isProcessing && (
                <div className="absolute inset-x-0 top-0 p-4 z-10 flex justify-center">
                    <div className="bg-indigo-600/10 backdrop-blur-md border border-indigo-500/20 px-4 py-2 rounded-full flex items-center gap-2 text-indigo-400 text-xs font-semibold shadow-lg">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Navigating Career Topology...
                    </div>
                </div>
            )}

            {graphInstance}

            {/* Selected Node Details Panel (Drawer) */}
            {selectedNode && (
                <div className="absolute top-4 right-4 w-80 bg-slate-900/95 backdrop-blur-xl border border-slate-700/50 shadow-2xl rounded-2xl p-5 z-20 text-slate-300 transition-all animate-in slide-in-from-right-4">
                    <div className="flex justify-between items-start mb-4">
                        <div className="flex flex-col gap-1">
                            <h3 className="text-lg font-bold text-white leading-tight pr-4">{selectedNode.name}</h3>
                            <div className="flex items-center gap-2">
                                <span className={`w-2 h-2 rounded-full ${
                                    selectedNode.type === 'Category' ? 'bg-indigo-500' :
                                    (selectedNode.type === 'Hackathon' || selectedNode.type === 'ThoughtLeadership') ? 'bg-purple-500' :
                                    'bg-sky-500'
                                }`} />
                                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{selectedNode.type}</span>
                            </div>
                        </div>
                        <button onClick={() => setSelectedNode(null)} className="text-slate-500 hover:text-white p-1">✕</button>
                    </div>
                    
                    <div className="text-sm space-y-4">
                        {selectedNode.description && (
                            <p className="text-slate-300 leading-relaxed text-xs">{selectedNode.description}</p>
                        )}

                        {/* Date Metadata */}
                        {(selectedNode.startDate || selectedNode.endDate) && (
                            <div className="flex items-center gap-2 text-slate-400 text-xs py-1">
                                <Calendar className="w-3.5 h-3.5" />
                                <span>{selectedNode.startDate || 'Unknown'} – {selectedNode.endDate || 'Present'}</span>
                            </div>
                        )}
                        
                        {/* MULTI-LINK SUITE */}
                        <div className="flex flex-col gap-2 pt-2">
                            {selectedNode.link && (
                                <a href={selectedNode.link} target="_blank" rel="noopener noreferrer" 
                                   className="flex items-center justify-between px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow-lg group">
                                    <div className="flex items-center gap-2">
                                        <ExternalLink className="w-3.5 h-3.5" />
                                        <span>Open Project</span>
                                    </div>
                                    <ChevronRight className="w-3 h-3 opacity-50 group-hover:translate-x-0.5 transition-transform" />
                                </a>
                            )}
                            
                            {selectedNode.url && selectedNode.url !== selectedNode.link && (
                                <a href={selectedNode.url} target="_blank" rel="noopener noreferrer" 
                                   className="flex items-center justify-between px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold border border-slate-700 group">
                                    <div className="flex items-center gap-2">
                                        <Globe className="w-3.5 h-3.5 text-indigo-400" />
                                        <span>External Resource</span>
                                    </div>
                                </a>
                            )}

                            {Array.isArray(selectedNode.links) && selectedNode.links.map((link, i) => (
                                <a key={i} href={link} target="_blank" rel="noopener noreferrer" 
                                   className="flex items-center justify-between px-4 py-2.5 bg-slate-800/50 hover:bg-slate-700/50 text-slate-300 rounded-lg text-xs font-semibold border border-slate-700/50 group">
                                    <div className="flex items-center gap-2">
                                        <LinkIcon className="w-3.5 h-3.5 text-slate-500" />
                                        <span className="truncate max-w-[160px]">Reference {i+1}</span>
                                    </div>
                                </a>
                            ))}
                        </div>
                        
                        {/* More Exploration Prompt */}
                        <div className="pt-4 border-t border-slate-800/50">
                            <div className="flex items-center gap-2 text-indigo-400 text-[10px] font-bold uppercase tracking-widest animate-pulse">
                                <Search className="w-3 h-3" />
                                <span>Double-Click to Explore Topology</span>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
