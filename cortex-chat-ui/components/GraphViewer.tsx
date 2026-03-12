"use client";

import dynamic from 'next/dynamic';
import { useEffect, useState, useRef, useMemo } from 'react';
import { BrainCircuit, Loader2 } from "lucide-react";

// Dynamically import the graph to avoid SSR issues
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

interface GraphNode {
    id: string;
    name: string;
    type: string;
    val?: number;
    [key: string]: any;
}

interface GraphLink {
    source: string;
    target: string;
    type?: string;
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
    const containerRef = useRef<HTMLDivElement>(null);

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

    // Memoize the graph to avoid unnecessary re-renders
    const graphInstance = useMemo(() => {
        if (dimensions.width === 0) return null;

        return (
            <ForceGraph2D
                graphData={data}
                width={dimensions.width}
                height={dimensions.height}
                nodeLabel="name"
                nodeRelSize={6}
                nodeAutoColorBy="type"
                backgroundColor="#020617" // Slate 950
                linkColor={() => "rgba(255, 255, 255, 0.08)"}
                linkDirectionalParticles={2}
                linkDirectionalParticleSpeed={d => 0.005}
                nodeCanvasObject={(node: any, ctx, globalScale) => {
                    const label = node.name;
                    const fontSize = 12 / globalScale;
                    ctx.font = `${fontSize}px Inter, sans-serif`;
                    const textWidth = ctx.measureText(label).width;
                    
                    // Node Color Logic
                    let color = '#6366f1'; // Default Indigo
                    if (node.type === 'Episode') color = '#0ea5e9'; // Cyan
                    if (node.type === 'Topic') color = '#a855f7'; // Purple
                    if (node.type === 'Person') color = '#10b981'; // Emerald

                    // Drawing Node
                    ctx.beginPath();
                    ctx.arc(node.x, node.y, 4, 0, 2 * Math.PI, false);
                    ctx.fillStyle = color;
                    ctx.shadowColor = color;
                    ctx.shadowBlur = 15;
                    ctx.fill();
                    ctx.shadowBlur = 0;

                    // Drawing Label (if scale is high enough)
                    if (globalScale > 1.5) {
                        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
                        ctx.fillText(label, node.x - textWidth / 2, node.y + 10);
                    }
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
                    <p className="text-sm font-medium">Ask a question to visualize your Knowledge Graph</p>
                </div>
            )}

            {/* Processing Overlay */}
            {isProcessing && (
                <div className="absolute inset-x-0 top-0 p-4 z-10 flex justify-center">
                    <div className="bg-indigo-600/10 backdrop-blur-md border border-indigo-500/20 px-4 py-2 rounded-full flex items-center gap-2 text-indigo-400 text-xs font-semibold shadow-lg">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Exploring Mental Model...
                    </div>
                </div>
            )}

            {graphInstance}
        </div>
    );
}
