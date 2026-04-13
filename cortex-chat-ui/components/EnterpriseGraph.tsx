"use client";

import React, { useMemo, useRef, useEffect } from 'react';
import ReactECharts from 'echarts-for-react';
import { getThemeForType } from '@/utils/GraphTheme';

interface Node {
    id: string;
    name: string;
    type: string;
    val?: number;
    year?: string | null;
    date?: string | null;
    description?: string;
    [key: string]: any;
}

interface Link {
    source: string;
    target: string;
    type?: string;
    [key: string]: any;
}

interface EnterpriseGraphProps {
    data: {
        nodes: Node[];
        links: Link[];
    };
    onNodeClick?: (node: Node) => void;
    onNodeDoubleClick?: (node: Node) => void;
    onTimelineChange?: (year: string) => void;
    focusYear?: string | null;
    selectedNodeId?: string | null;
}

const EnterpriseGraph: React.FC<EnterpriseGraphProps> = ({ 
    data, 
    onNodeClick, 
    onNodeDoubleClick,
    onTimelineChange,
    focusYear,
    selectedNodeId 
}) => {
    const chartRef = useRef<any>(null);

    // 1. Prepare Timeline Data (Professional career range 1997-2026)
    const timelineData = useMemo(() => {
        const years = new Set<string>();
        // Add core range years for professional navigation (1997-2026)
        for (let y = 1997; y <= 2026; y++) {
            years.add(y.toString());
        }
        // Add any other years from nodes (e.g. earlier education or specific milestones)
        data.nodes.forEach(n => {
            if (n.year) years.add(n.year);
        });
        return Array.from(years).sort();
    }, [data.nodes]);

    // 2. Discover neighbors for persistent highlighting
    const highlightIds = useMemo(() => {
        if (!selectedNodeId) return null;
        const ids = new Set<string>([selectedNodeId]);
        data.links.forEach(l => {
            if (l.source === selectedNodeId) ids.add(l.target);
            if (l.target === selectedNodeId) ids.add(l.source);
        });
        return ids;
    }, [selectedNodeId, data.links]);

    // 3. Build ECharts Options
    const getOption = () => {
        const baseOption = {
            backgroundColor: 'transparent',
            timeline: {
                axisType: 'category',
                data: timelineData,
                autoPlay: false,
                playInterval: 3000,
                bottom: 20,
                left: 'center',
                width: '60%',
                label: {
                    color: '#94a3b8',
                    fontSize: 10,
                    formatter: (value: string) => value
                },
                lineStyle: { color: '#334155' },
                checkpointStyle: {
                    color: '#6366f1',
                    borderColor: '#818cf8',
                    borderWidth: 2
                },
                controlStyle: {
                    showNextBtn: true,
                    showPrevBtn: true,
                    itemColor: '#94a3b8',
                    itemHoverColor: '#6366f1'
                }
            },
            tooltip: {
                show: true,
                trigger: 'item',
                backgroundColor: 'rgba(15, 23, 42, 0.95)',
                borderColor: 'rgba(255, 255, 255, 0.2)',
                borderWidth: 1,
                padding: [12, 16],
                textStyle: { 
                    color: '#f1f5f9',
                    fontFamily: 'Inter, system-ui, sans-serif'
                },
                formatter: (params: any) => {
                    const node = params.data || {};
                    const name = node.name || params.name || "Unknown Entity";
                    const type = node.type || "Context Node";
                    const yearLabel = node.year ? `(${node.year})` : (node.date ? `(${node.date})` : '');
                    
                    return `
                        <div style="display: flex; flex-direction: column; gap: 4px; min-width: 140px;">
                            <div style="font-size: 13px; font-weight: 800; color: #fff;">${name}</div>
                            <div style="font-size: 9px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 700;">
                                ${type} ${yearLabel}
                            </div>
                        </div>
                    `;
                }
            },
            series: [
                {
                    type: 'graph',
                    layout: 'force',
                    z: 2,
                    animation: true,
                    roam: true,
                    draggable: true,
                    selectedMode: 'single', // Native selection
                    select: {
                        itemStyle: {
                            borderWidth: 3,
                            borderColor: '#818cf8',
                            shadowBlur: 25,
                            shadowColor: '#6366f1'
                        },
                        label: { show: true }
                    },
                    blur: {
                        itemStyle: { opacity: 0.1 },
                        lineStyle: { opacity: 0.05 }
                    },
                    force: {
                        repulsion: 200,
                        edgeLength: 120,
                        gravity: 0.1,
                        edgeWeight: 1
                    },
                    symbolSize: (value: number, params: any) => {
                        const theme = getThemeForType(params.data.type);
                        return theme.radius * 2 || 12;
                    },
                    label: {
                        show: false,
                        position: 'right',
                        formatter: '{b}',
                        color: '#cbd5e1'
                    },
                    emphasis: {
                        focus: 'adjacency',
                        label: { show: true },
                        itemStyle: {
                            shadowBlur: 20,
                            shadowColor: '#6366f1'
                        }
                    },
                    lineStyle: {
                        color: 'rgba(255, 255, 255, 0.2)',
                        width: 1,
                        curveness: 0.1
                    },
                    data: [],
                    links: []
                }
            ]
        };

        const options = timelineData.map(year => {
            const numericYear = parseInt(year);
            const filteredNodes = data.nodes.filter(n => {
                if (n.startYear && n.endYear) {
                    const startY = parseInt(n.startYear);
                    const endY = n.endYear.toLowerCase() === 'present' ? 2026 : parseInt(n.endYear);
                    return numericYear >= startY && numericYear <= endY;
                }
                return !n.year || n.year === year;
            });
            const nodeIds = new Set(filteredNodes.map(n => n.id));
            const filteredLinks = data.links.filter(l => 
                nodeIds.has(l.source) && nodeIds.has(l.target)
            );

            return {
                series: [{
                    data: filteredNodes.map(n => {
                        const theme = getThemeForType(n.type);
                        return {
                            ...n,
                            itemStyle: {
                                color: theme.hsl,
                                shadowBlur: 10,
                                shadowColor: theme.hsl.replace('hsl', 'hsla').replace(')', ', 0.3)')
                            }
                        };
                    }),
                    links: filteredLinks.map(l => ({
                        source: l.source,
                        target: l.target
                    }))
                }]
            };
        });

        return { baseOption, options };
    };

    // 4. Events handler (Debounced to separate Bento single-click from Expansion double-click)
    const clickTimer = useRef<NodeJS.Timeout | null>(null);

    const onEvents = {
        'click': (params: any) => {
            if (params.dataType === 'node' && onNodeClick) {
                // Clear any existing timer (prevents multiple triggers)
                if (clickTimer.current) clearTimeout(clickTimer.current);
                
                // Set a timer for single click (Bento activation)
                clickTimer.current = setTimeout(() => {
                    onNodeClick(params.data);
                    clickTimer.current = null;
                }, 250); // 250ms debounce window
            }
        },
        'dblclick': (params: any) => {
            if (params.dataType === 'node' && onNodeDoubleClick) {
                // Immediately cancel the pending single-click (Bento)
                if (clickTimer.current) {
                    clearTimeout(clickTimer.current);
                    clickTimer.current = null;
                }
                
                // Trigger the high-fidelity expansion (Level 2 Bloom)
                onNodeDoubleClick(params.data);
            }
        },
        'timelinechanged': (params: any) => {
            if (onTimelineChange) {
                const year = timelineData[params.currentIndex];
                onTimelineChange(year);
            }
        }
    };

    // 5. Native Selection Management
    useEffect(() => {
        if (!chartRef.current || !data?.nodes?.length) return;
        const echartsInstance = chartRef.current.getEchartsInstance();

        try {
            if (selectedNodeId) {
                // Native dispatch for persistent focus
                echartsInstance.dispatchAction({
                    type: 'select',
                    name: selectedNodeId
                });
            } else {
                echartsInstance.dispatchAction({
                    type: 'unselect',
                    seriesIndex: 0
                });
            }
        } catch (e) {
            console.warn("ECharts selection dispatch skipped (graph initializing):", e);
        }
    }, [selectedNodeId, data.nodes]);

    // 6. Handle External Timeline Sync (Auto-Shift)
    useEffect(() => {
        if (focusYear && timelineData.includes(focusYear) && chartRef.current) {
            const index = timelineData.indexOf(focusYear);
            const echartsInstance = chartRef.current.getEchartsInstance();
            
            const currentOption = echartsInstance.getOption();
            // Safety check for timeline property to prevent TypeError
            if (currentOption && currentOption.timeline && Array.isArray(currentOption.timeline) && currentOption.timeline[0]) {
                const currentIndex = currentOption.timeline[0].currentIndex;
                
                if (currentIndex !== index) {
                    echartsInstance.dispatchAction({
                        type: 'timelineChange',
                        currentIndex: index
                    });
                }
            }
        }
    }, [focusYear, timelineData]);

    return (
        <div className="w-full h-full relative">
            <ReactECharts
                ref={chartRef}
                option={getOption()}
                onEvents={onEvents}
                style={{ height: '100%', width: '100%' }}
                className="echarts-graph"
                notMerge={false} // Preserve instance to avoid re-renders killing focus
                lazyUpdate={true}
            />
        </div>
    );
};

export default EnterpriseGraph;
