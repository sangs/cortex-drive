'use client';
import dynamic from 'next/dynamic';
import { useCortex } from '@/context/CortexContext';
import { useEffect, useState, useRef } from 'react';

// Dynamically import the graph to avoid SSR issues
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

export default function GraphView() {
    const { graphData } = useCortex();
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

    return (
        <div className="graph-viewport" ref={containerRef} style={{ width: '100%', height: '100%' }}>
            {dimensions.width > 0 && (
                <ForceGraph2D
                    graphData={graphData}
                    width={dimensions.width}
                    height={dimensions.height}
                    nodeLabel="name"
                    nodeColor={(node: any) => {
                        switch (node.type) {
                            case 'Episode': return '#00d2ff';
                            case 'Topic': return '#9d50bb';
                            default: return '#ffffff';
                        }
                    }}
                    linkColor={() => 'rgba(255,255,255,0.1)'}
                    backgroundColor="#08080c"
                    nodeCanvasObject={(node: any, ctx, globalScale) => {
                        const label = node.name;
                        const fontSize = 12 / globalScale;
                        ctx.font = `${fontSize}px Inter`;
                        const textWidth = ctx.measureText(label).width;
                        const bckgDimensions = [textWidth, fontSize].map(n => n + fontSize * 0.2);

                        // Node Circle
                        ctx.beginPath();
                        ctx.arc(node.x, node.y, 5, 0, 2 * Math.PI, false);
                        ctx.fillStyle = node.type === 'Episode' ? '#00d2ff' : '#9d50bb';
                        ctx.fill();

                        // Neon Glow
                        ctx.shadowColor = node.type === 'Episode' ? '#00d2ff' : '#9d50bb';
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
