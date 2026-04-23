"use client";

import React, { useMemo, useRef, useEffect } from 'react';
import ReactECharts from 'echarts-for-react';
import { getThemeForType } from '@/utils/GraphTheme';

const BACKBONE_LANDMARKS = [
    'Category', 'Company', 'Startup', 'Hackathon', 'ThoughtLeadership', 
    'Institution', 'Degree', 'ProfessionalExperience', 'Certification', 'Podcast', 'Publication', 'Project', 'Role', 'Year', 'Person'
];

interface EnterpriseGraphProps {
    data: { nodes: any[], links: any[] };
    onNodeClick?: (node: any) => void;
    onNodeDoubleClick?: (node: any) => void;
    onTimelineChange?: (year: string) => void;
    viewMode?: 'brain' | 'spine';
    focusYear?: string | null;
    selectedNodeId?: string | null;
}

const EnterpriseGraph: React.FC<EnterpriseGraphProps> = ({ 
    data, onNodeClick, onNodeDoubleClick, onTimelineChange, viewMode = 'brain', focusYear, selectedNodeId 
}) => {
    const chartRef = useRef<any>(null);
    const [pinnedPositions, setPinnedPositions] = React.useState<Map<string, {x: number, y: number}>>(new Map()); 
    const pinnedRef = useRef<Map<string, {x: number, y: number}>>(new Map());

    // 1. Initial Processing: Inject Temporal Spine & Year Anchors
    const processed = useMemo(() => {
        const nodes = [...data.nodes];
        const links = [...data.links];

        if (viewMode === 'spine') {
            // Generate limited spine backbone based on focusYear (3-year sliding window)
            const centerYear = focusYear ? parseInt(focusYear) : 2026;
            for (let y = centerYear - 3; y <= centerYear + 3; y++) {
                if (y < 1997 || y > 2026) continue;
                const yStr = y.toString();
                if (!nodes.some(n => n.type === 'Year' && n.name === yStr)) {
                    nodes.push({ id: `year-${yStr}`, name: yStr, type: 'Year', isBackbone: true });
                }
            }
            const years = nodes.filter(n => n.type === 'Year').sort((a,b) => parseInt(a.name) - parseInt(b.name));
            for (let i = 0; i < years.length - 1; i++) {
                links.push({ source: years[i].id, target: years[i+1].id, type: 'TEMPORAL_SPINE' });
            }
            // Add Year Anchors based on node properties
            // 1. Direct Anchors based on node properties
            nodes.forEach(n => {
                const nodeYear = n.year || (n.display_date ? String(n.display_date).match(/\d{4}/)?.[0] : null);
                if (nodeYear && n.type !== 'Year') {
                    const yNodeId = `year-${nodeYear}`;
                    if (!links.some(l => (l.source === yNodeId && l.target === n.id) || (l.source === n.id && l.target === yNodeId))) {
                        links.push({ source: yNodeId, target: n.id, type: 'YEAR_ANCHOR' });
                    }
                }
            });

            // 2. Transitive Anchors: Startups/Companies linked to Roles that are linked to Years
            const newAnchors: any[] = [];
            links.forEach(l => {
                const source = nodes.find(n => n.id === l.source);
                const target = nodes.find(n => n.id === l.target);
                if (!source || !target) return;

                // Transitive Anchor Resolution: 
                // If a Year is linked to a Role, find what that Role is attached to.
                const findRel = (p: any, c: any) => {
                    if (p.type === 'Year' && c.type === 'Role') {
                        links.forEach(l2 => {
                            if (l2.source === c.id || l2.target === c.id) {
                                const peerId = l2.source === c.id ? l2.target : l2.source;
                                const peer = nodes.find(n => n.id === peerId);
                                if (peer && ['Startup', 'Company', 'Institution', 'Category', 'Hackathon'].includes(peer.type)) {
                                    if (!links.some(lx => (lx.source === p.id && lx.target === peer.id) || (lx.source === peer.id && lx.target === p.id))) {
                                        newAnchors.push({ source: p.id, target: peer.id, type: 'YEAR_ANCHOR' });
                                    }
                                }
                            }
                        });
                    }
                };
                findRel(source, target);
                findRel(target, source);
            });
            links.push(...newAnchors);
        }
        return { nodes, links };
    }, [data, viewMode]);

    // 2. Relational Discovery: Build set of IDs linked to focusYear
    const relevantIds = useMemo(() => {
        if (viewMode !== 'spine' || !focusYear) return new Set<string>();
        const yearId = `year-${focusYear}`;
        const ids = new Set<string>();
        processed.links.forEach(l => {
            if (l.source === yearId) ids.add(l.target);
            if (l.target === yearId) ids.add(l.source);
        });
        return ids;
    }, [processed.links, focusYear, viewMode]);

    // 3. Filter nodes based on viewMode context + Relational relevance
    const visibleNodes = useMemo(() => processed.nodes.filter(n => {
        // Sticky Selection: The currently selected node must ALWAYS remain visible
        if (selectedNodeId && n.id === selectedNodeId) return true;
        
        if (viewMode === 'spine') {
            // Show all years, person, and anything linked to the FOCUS year
            return n.isBackbone || n.type === 'Year' || n.type === 'Person' || relevantIds.has(n.id);
        }
        return true;
    }), [processed.nodes, viewMode, relevantIds, selectedNodeId]);

    const getOption = () => ({
        backgroundColor: 'transparent',
        grid: { top: '10%', bottom: '15%', left: '10%', right: '10%', containLabel: true },
        xAxis: { show: false, min: -2000, max: 2000, type: 'value' },
        yAxis: { show: false, min: -500, max: 500, type: 'value' },
        series: [{
            type: 'graph',
            coordinateSystem: viewMode === 'spine' ? 'cartesian2d' : undefined,
            layout: viewMode === 'spine' ? 'none' : 'force',
            force: {
                repulsion: 1500,
                gravity: 0.1,
                edgeLength: 150,
                layoutAnimation: true,
                friction: 0.8
            },
            symbol: (val: any, params: any) => params.data.type === 'Year' ? 'diamond' : 'circle',
            symbolSize: (val: any, params: any) => {
                if (viewMode === 'spine') {
                    if (params.data.name === focusYear) return 100;
                    return params.data.type === 'Year' ? 40 : 30;
                }
                return params.data.isBackbone ? 50 : 30;
            },
            roam: true,
            draggable: viewMode === 'brain',
            selectedMode: 'single', 
            focusNodeAdjacency: true, 
            label: { show: true, position: 'right', fontWeight: 'bold', backgroundColor: 'rgba(255,255,255,0.7)', borderRadius: 4, padding: [2,4] },
            edgeSymbol: ['none', 'none'],
            data: visibleNodes.map(node => {
                const theme = getThemeForType(node.type);
                let pos: any = {};
                // Apply pinned positions in Brain mode
                if (viewMode === 'brain' && pinnedRef.current.has(node.id)) {
                    const pinned = pinnedRef.current.get(node.id)!;
                    pos = { x: pinned.x, y: pinned.y, fixed: true };
                }

                if (viewMode === 'spine') {
                    if (node.type === 'Person') pos = { value: [-800, 0] };
                    else if (node.type === 'Year') {
                        const diff = parseInt(node.name) - (focusYear ? parseInt(focusYear) : 2024);
                        pos = { value: [diff * 350, (node.name === focusYear) ? 0 : -250] };
                    } else if (relevantIds.has(node.id)) {
                        const count = Array.from(relevantIds).indexOf(node.id);
                        const angle = (count / relevantIds.size) * 2 * Math.PI;
                        pos = { value: [(relevantIds.size > 5 ? 300 : 150) * Math.cos(angle), (relevantIds.size > 5 ? 300 : 150) * Math.sin(angle) + 150] };
                    }
                }

                // Global Boundary Guard (Pitch Stability - ensuring nodes don't drift off-screen)
                if (pos.value) {
                    pos.value[0] = Math.max(-1800, Math.min(1800, pos.value[0]));
                    pos.value[1] = Math.max(-500, Math.min(500, pos.value[1]));
                }
                if (pos.x !== undefined) {
                    pos.x = Math.max(-1800, Math.min(1800, pos.x));
                    pos.y = Math.max(-500, Math.min(500, pos.y));
                }
                return { 
                    ...node, ...pos, 
                    itemStyle: { 
                        color: theme.hsl, 
                        shadowBlur: (node.isBentoEligible || node.hasFederatedBridge || node.name === focusYear) ? 30 : 5, 
                        shadowColor: (node.isBentoEligible || node.hasFederatedBridge) ? '#FFD700' : theme.hsl, // System Gold Pulse for Federated Bridges
                        borderWidth: 2, borderColor: '#fff'
                    },
                    // Expandable Badge: Render a "+" sign for nodes with hidden topology
                    label: {
                        show: true,
                        formatter: (params: any) => {
                            const baseLabel = params.data.name || params.data.title || params.data.topic || params.data.role || String(params.data.id || '');
                            return params.data.isExpandable ? `+ ${baseLabel}` : baseLabel;
                        },
                        position: 'right',
                        fontWeight: 'bold',
                        backgroundColor: 'rgba(255,255,255,0.7)',
                        borderRadius: 4,
                        padding: [2, 4]
                    }
                };
            }),
            links: processed.links.filter(l => visibleNodes.some(n => n.id === l.source) && visibleNodes.some(n => n.id === l.target)).map(l => ({
                ...l,
                label: {
                    show: false, // Default to hidden for Executive Clarity
                    formatter: (p: any) => p.data.link_label || p.data.discovery_reason || p.data.title || p.data.role || '',
                    fontSize: 10,
                    fontWeight: 'bold',
                    color: '#6366f1'
                },
                emphasis: {
                    label: { show: true }, // Reveal on hover/click
                    lineStyle: { width: 6, opacity: 1 }
                },
                lineStyle: { 
                    color: (l.isVirtual || l.hasFederatedBridge) ? '#FFD700' : (l.type === 'TEMPORAL_SPINE' ? '#6366f1' : '#edeff2'), 
                    width: l.type === 'TEMPORAL_SPINE' ? 4 : ((l.isVirtual || l.hasFederatedBridge) ? 3 : 2),
                    type: (l.isVirtual || l.hasFederatedBridge) ? 'dashed' : 'solid',
                    opacity: 0.8,
                    curveness: (viewMode === 'spine' && l.type !== 'TEMPORAL_SPINE') ? 0.3 : 0 
                }
            }))
        }]
    });

    useEffect(() => {
        if (!chartRef.current) return;
        const e = chartRef.current.getEchartsInstance();
        
        // Handle Mouseup for Pinning: High-Fidelity Capture from Model
        const handleMouseUp = (params: any) => {
            if (params.dataType === 'node' && viewMode === 'brain') {
                // ECharts force layout updates the model internally.
                // We use getItemLayout to get the actual projected coordinates.
                const seriesModel = e.getModel().getSeriesByIndex(0);
                const data = seriesModel.getData();
                const layout = data.getItemLayout(params.dataIndex);
                
                if (layout && !isNaN(layout[0]) && !isNaN(layout[1])) {
                    const newPositions = new Map(pinnedRef.current);
                    // Standardize to ECharts coordinate format [x, y]
                    newPositions.set(params.data.id, { x: layout[0], y: layout[1] });
                    pinnedRef.current = newPositions;
                    
                    // Trigger re-render to apply the 'fixed' state in the next getOption mapping
                    setPinnedPositions(new Map(newPositions) as any);
                }
            }
        };

        e.on('mouseup', handleMouseUp);

        // Handle Selection Persistence
        try {
            if (selectedNodeId && visibleNodes.some(n => n.id === selectedNodeId)) {
                e.dispatchAction({ type: 'select', name: selectedNodeId });
            } else {
                e.dispatchAction({ type: 'unselect', seriesIndex: 0 });
            }
        } catch (err) {}

        return () => {
            if (e && !e.isDisposed()) {
                e.off('mouseup', handleMouseUp);
            }
        };
    }, [selectedNodeId, visibleNodes, viewMode]);

    return (
        <div className="w-full h-full relative">
            <ReactECharts 
                ref={chartRef} 
                option={getOption()} 
                style={{ height: '100%', width: '100%' }}
                onEvents={{
                    'click': (p: any) => { if (p.dataType === 'node' && onNodeClick) onNodeClick(p.data); },
                    'dblclick': (p: any) => { if (p.dataType === 'node' && onNodeDoubleClick) onNodeDoubleClick(p.data); }
                }}
                notMerge={false}
                lazyUpdate={true}
            />
            {viewMode === 'spine' && (
                <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-30 w-[85%] max-w-[1000px]">
                    <div className="relative flex items-center justify-between p-5 bg-white/60 backdrop-blur-3xl border border-white/40 rounded-[32px] shadow-2xl">
                        <div className="relative z-10 flex items-center gap-2 pr-6 border-r border-slate-200/50 text-primary font-black text-[11px] tracking-widest uppercase">
                            <span className="w-2 h-2 rounded-full bg-primary animate-pulse shadow-lg ring-2 ring-white" />
                            The Spine
                        </div>
                        <div className="flex-1 flex justify-around px-6 overflow-x-auto no-scrollbar gap-6 relative z-10">
                            {Array.from({length:30},(_,i)=>(1997+i).toString()).map(y=>(
                                <button key={y} onClick={()=>{if(onTimelineChange)onTimelineChange(y)}} className={`relative flex flex-col items-center group transition-all duration-300 ${focusYear===y?'scale-110':''}`}>
                                    <div className={`w-3 h-3 rotate-45 border-2 transition-all ${focusYear===y?'bg-primary border-primary shadow-[0_0_15px_rgba(79,70,229,0.5)]':'bg-white border-slate-300 group-hover:border-primary'}`} />
                                    <span className={`text-[10px] font-black mt-2 transition-colors ${focusYear===y?'text-primary':'text-slate-400 group-hover:text-slate-600'}`}>{y}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default EnterpriseGraph;
