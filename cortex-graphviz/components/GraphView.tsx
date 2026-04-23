'use client';
import dynamic from 'next/dynamic';
import { useCortex } from '@/context/CortexContext';
import { useEffect, useState, useRef } from 'react';

// Dynamically import the graph to avoid SSR issues
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

export default function GraphView() {
    const { graphData, setSelectedNodeId } = useCortex();
    const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (containerRef.current) {
            setDimensions({
                width: containerRef.current.offsetWidth,
                height: containerRef.current.offsetHeight
            });
        }
    }, []);

    const handleNodeClick = (node: any) => {
        setSelectedNodeId(node.id);
    };

    return (
        <div className="graph-viewport" ref={containerRef} style={{ width: '100%', height: '100%' }}>
            {dimensions.width > 0 && (
                <ForceGraph2D
                    graphData={graphData}
                    width={dimensions.width}
                    height={dimensions.height}
                    onNodeClick={handleNodeClick}
                    nodeLabel="name"
                    nodeColor={(node: any) => {
                        switch (node.type) {
                            case 'Episode': return '#00d2ff';
                            case 'Topic': return '#9d50bb';
                            case 'Company': return '#34A853';
                            case 'Role': return '#FBBC04';
                            default: return '#ffffff';
                        }
                    }}
                    linkColor={() => 'rgba(255,255,255,0.1)'}
                    backgroundColor="#08080c"
                    nodeCanvasObject={(node: any, ctx, globalScale) => {
                        const label = node.name || 'Anonymous';
                        const fontSize = 12 / globalScale;
                        ctx.font = `${fontSize}px Inter`;
                        const textWidth = ctx.measureText(label).width;

                        // Node Circle
                        ctx.beginPath();
                        ctx.arc(node.x, node.y, 5, 0, 2 * Math.PI, false);
                        
                        // Color based on type
                        let color = '#ffffff';
                        if (node.type === 'Episode') color = '#00d2ff';
                        else if (node.type === 'Topic') color = '#9d50bb';
                        else if (node.type === 'Company') color = '#34A853';
                        else if (node.type === 'Role') color = '#FBBC04';
                        
                        ctx.fillStyle = color;
                        ctx.fill();

                        // Neon Glow if selected
                        ctx.shadowColor = color;
                        ctx.shadowBlur = 10;
                        ctx.stroke();
                        ctx.shadowBlur = 0;

                        // Label
                        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
                        ctx.fillText(label, node.x - textWidth / 2, node.y + 10);
                    }}
                />
            )}
        </div>
    );
}
