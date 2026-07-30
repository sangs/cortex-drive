"use client";

import React, { useMemo, useRef, useEffect } from 'react';
import ReactECharts from 'echarts-for-react';
import { getThemeForType } from '@/utils/GraphTheme';
import { deduplicateNodes } from '@/utils/graphConstants';

const BACKBONE_LANDMARKS = [
    'Category', 'Company', 'Startup', 'Hackathon', 'ThoughtLeadership',
    'Institution', 'Degree', 'ProfessionalExperience', 'Certification', 'Podcast', 'Publication', 'Project', 'Role', 'Year', 'Person'
];

// Podcast-domain relationship types — rendered in teal to distinguish from career (indigo).
const PODCAST_REL_FAMILIES = new Set([
    'HAS_EPISODE', 'HAS_TOPIC', 'COVERS_TECHNOLOGY', 'COVERS_CONCEPT',
    'GUEST_ON', 'HOSTS', 'INTERVIEWED_BY', 'FEATURE_GUEST',
    'HAS_SOURCE', 'MENTIONED', 'LISTENS_TO', 'SUBSCRIBES_TO', 'HAS_CHUNK'
]);

interface EnterpriseGraphProps {
    data: { nodes: any[], links: any[] };
    onNodeClick?: (node: any) => void;
    onNodeDoubleClick?: (node: any) => void;
    onTimelineChange?: (year: string) => void;
    viewMode?: 'brain' | 'spine';
    focusYear?: string | null;
    selectedNodeId?: string | null;
    focusedNodeIds?: Set<string> | null;
    expandedNodeKeys?: Set<string>;
}

const EnterpriseGraph: React.FC<EnterpriseGraphProps> = ({
    data, onNodeClick, onNodeDoubleClick, onTimelineChange, viewMode = 'brain', focusYear, selectedNodeId, focusedNodeIds, expandedNodeKeys
}) => {
    const chartRef = useRef<any>(null);
    const [pinnedPositions, setPinnedPositions] = React.useState<Map<string, {x: number, y: number}>>(new Map());
    const pinnedRef = useRef<Map<string, {x: number, y: number}>>(new Map());
    const graphZoomRef = useRef(0.55);

    // 1. Initial Processing: Inject Temporal Spine & Year Anchors
    const processed = useMemo(() => {
        // Deduplicate before ECharts sees the data — it rejects duplicate id OR name in graph series.
        const { nodes, links } = deduplicateNodes(data.nodes, data.links);
        if (nodes.length !== data.nodes.length) {
            const keptIds = new Set(nodes.map((n: any) => n.id));
            const dropped = data.nodes.filter((n: any) => !keptIds.has(n.id));
            console.log("[DIAG] deduplicateNodes dropped", dropped.length, "node(s):", dropped.map((n: any) => `${n.name} (${n.type}, id=${n.id})`));
        }

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

    // 3a. Degree map — used for variable node sizing
    const degreeMap = useMemo(() => {
        const map = new Map<string, number>();
        processed.links.forEach(l => {
            map.set(l.source, (map.get(l.source) || 0) + 1);
            map.set(l.target, (map.get(l.target) || 0) + 1);
        });
        return map;
    }, [processed.links]);

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

    const getOption = () => {
        // Pre-compute initial angular positions for the identity anchor's direct neighbors
        // so the force simulation starts from a radial layout rather than a random cluster.
        const anchorNode = visibleNodes.find((n: any) => n.isIdentityAnchor);
        const neighborInitialPos = new Map<string, {x: number, y: number}>();
        if (anchorNode && viewMode === 'brain') {
            const directNeighborIds: string[] = [];
            processed.links.forEach(l => {
                if (l.source === anchorNode.id && !pinnedRef.current.has(l.target)) directNeighborIds.push(l.target);
                else if (l.target === anchorNode.id && !pinnedRef.current.has(l.source)) directNeighborIds.push(l.source);
            });
            const unique = [...new Set(directNeighborIds)];
            unique.forEach((id, idx) => {
                const angle = (idx / unique.length) * 2 * Math.PI - Math.PI / 2;
                neighborInitialPos.set(id, { x: Math.round(380 * Math.cos(angle)), y: Math.round(380 * Math.sin(angle)) });
            });
        }

        return ({
        backgroundColor: 'transparent',
        grid: { top: '10%', bottom: '15%', left: '10%', right: '10%', containLabel: true },
        xAxis: { show: false, min: -2000, max: 2000, type: 'value' },
        yAxis: { show: false, min: -500, max: 500, type: 'value' },
        tooltip: {
            trigger: 'item',
            enterable: false,
            backgroundColor: 'rgba(255,255,255,0.95)',
            borderColor: '#e2e8f0',
            borderWidth: 1,
            padding: [8, 12],
            textStyle: { color: '#1e293b', fontSize: 12 },
            formatter: (params: any) => {
                if (params.dataType === 'edge') {
                    const raw = params.data.link_label || params.data.discovery_reason || '';
                    if (!raw) return '';
                    const isVirtual = params.data.isVirtual || params.data.hasFederatedBridge;
                    const color = isVirtual ? '#b45309' : '#4338ca';
                    const label = raw.length > 80 ? raw.slice(0, 78) + '…' : raw;
                    return `<div style="max-width:240px;font-size:11px;font-weight:bold;color:${color};line-height:1.4">${label}</div>
                            <div style="font-size:10px;color:#94a3b8;margin-top:3px;text-transform:uppercase">${params.data.type || ''}</div>`;
                }
                if (params.dataType !== 'node') return '';
                const name = params.data.name || String(params.data.id || '');
                const type = params.data.type || '';
                const isExpandable = params.data.isExpandable;
                const isBentoEligible = params.data.isBentoEligible;
                const isBridge = params.data.hasFederatedBridge;
                let hint = '';
                if (isExpandable && isBentoEligible) {
                    hint = '<span style="color:#6366f1;font-weight:bold">⊕ Double-click to expand</span> &nbsp;·&nbsp; <span style="color:#0d9488;font-weight:bold">ⓘ Click for details</span>';
                } else if (isExpandable) {
                    hint = '<span style="color:#6366f1;font-weight:bold">⊕ Double-click to expand</span>';
                } else if (isBridge) {
                    hint = '<span style="color:#f59e0b;font-weight:bold">✦ Federated bridge — click to explore</span>';
                } else if (isBentoEligible) {
                    hint = '<span style="color:#0d9488;font-weight:bold">ⓘ Click for details</span>';
                }
                return `<div style="font-weight:bold;margin-bottom:4px">${name}</div>
                        <div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">${type}</div>
                        <div style="font-size:11px">${hint}</div>`;
            }
        },
        series: [{
            type: 'graph',
            coordinateSystem: viewMode === 'spine' ? 'cartesian2d' : undefined,
            layout: viewMode === 'spine' ? 'none' : 'force',
            zoom: graphZoomRef.current,
            force: {
                repulsion: 1400,
                gravity: 0.12,
                edgeLength: [80, 180],
                layoutAnimation: true,
                friction: 0.4
            },
            symbol: (val: any, params: any) => params.data.type === 'Year' ? 'diamond' : 'circle',
            symbolSize: (val: any, params: any) => {
                if (params.data.isIdentityAnchor) return 70;
                if (viewMode === 'spine') {
                    if (params.data.name === focusYear) return 100;
                    return params.data.type === 'Year' ? 40 : 30;
                }
                if (params.data.isGrouper) return 55;
                if (params.data.isBackbone) return 50;
                const degree = degreeMap.get(params.data.id) || 0;
                return Math.min(20 + degree * 3, 55);
            },
            labelLayout: { hideOverlap: true },
            roam: true,
            draggable: viewMode === 'brain',
            selectedMode: 'single', 
            focusNodeAdjacency: true, 
            label: {
                show: true,
                position: 'right',
                fontWeight: 'bold',
                backgroundColor: 'rgba(255,255,255,0.7)',
                borderRadius: 4,
                padding: [2, 4],
                formatter: (params: any) => {
                    const baseLabel = params.data.name || params.data.title || params.data.topic || params.data.role || String(params.data.id || '');
                    if (params.data.isIdentityAnchor) return `{anchor|★}  ${baseLabel}`;
                    if (params.data.isExpanded && params.data.isBentoEligible) return `{collapse|⊖} {bento|ⓘ}  ${baseLabel}`;
                    if (params.data.isExpanded) return `{collapse|⊖}  ${baseLabel}`;
                    if (params.data.isGrouper) return `{expand|⊕}  ${baseLabel}`;
                    if (params.data.isExpandable && params.data.isBentoEligible) return `{expand|⊕} {bento|ⓘ}  ${baseLabel}`;
                    if (params.data.isExpandable) return `{expand|⊕}  ${baseLabel}`;
                    if (params.data.isBentoEligible) return `{bento|ⓘ}  ${baseLabel}`;
                    return baseLabel;
                },
                rich: {
                    expand:   { backgroundColor: '#6366f1', color: '#fff', borderRadius: 8, padding: [1, 5], fontSize: 9, fontWeight: 'bold', lineHeight: 16 },
                    collapse: { backgroundColor: '#f97316', color: '#fff', borderRadius: 8, padding: [1, 5], fontSize: 9, fontWeight: 'bold', lineHeight: 16 },
                    bento:    { backgroundColor: '#0d9488', color: '#fff', borderRadius: 8, padding: [1, 5], fontSize: 9, fontWeight: 'bold', lineHeight: 16 },
                    anchor:   { backgroundColor: '#4f46e5', color: '#fff', borderRadius: 8, padding: [1, 5], fontSize: 9, fontWeight: 'bold', lineHeight: 16 }
                }
            },
            data: visibleNodes.map(node => {
                const theme = getThemeForType(node.type);
                let pos: any = {};
                // Apply pinned positions in Brain mode
                // Fix #5: Identity anchor pinned to center; user-dragged pins take precedence
                if (node.isIdentityAnchor && viewMode === 'brain' && !pinnedRef.current.has(node.id)) {
                    pos = { x: 0, y: 0, fixed: true };
                } else if (viewMode === 'brain' && pinnedRef.current.has(node.id)) {
                    const pinned = pinnedRef.current.get(node.id)!;
                    pos = { x: pinned.x, y: pinned.y, fixed: true };
                } else if (viewMode === 'brain' && neighborInitialPos.has(node.id)) {
                    const p = neighborInitialPos.get(node.id)!;
                    pos = { x: p.x, y: p.y };
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
                // Visual tier: identity anchor glows violet; groupers glow indigo-heavy; bridges glow gold; bento teal; leaves subtle
                const isExpandable = node.isExpandable;
                const isBentoEligible = node.isBentoEligible;
                const isBridge = node.hasFederatedBridge;
                const isFocusYear = node.name === focusYear;
                const isAnchor = node.isIdentityAnchor;
                const isGrouper = node.isGrouper;

                // Leaf nodes (no badges) show label only on hover to reduce clutter
                const showLabelAtRest = !!(isExpandable || isBentoEligible || isAnchor || isGrouper);

                const isDimmed = !!(focusedNodeIds && focusedNodeIds.size > 0 && !focusedNodeIds.has(node.id));
                const isExpanded = !!(expandedNodeKeys && expandedNodeKeys.has(node.id));
                return {
                    ...node, ...pos,
                    // Expose isExpanded in the data so the label formatter can read it
                    isExpanded,
                    label: { show: showLabelAtRest && !isDimmed },
                    emphasis: { label: { show: true } },
                    itemStyle: {
                        color: isAnchor ? '#4f46e5' : (isGrouper ? '#6366f1' : theme.hsl),
                        shadowBlur: isDimmed ? 0 : (isAnchor ? 40 : isGrouper ? 28 : isExpandable ? 22 : isBridge || isFocusYear ? 30 : isBentoEligible ? 14 : 4),
                        shadowColor: isAnchor    ? 'rgba(79,70,229,0.7)'
                                   : isGrouper   ? 'rgba(99,102,241,0.65)'
                                   : isExpandable? 'rgba(99,102,241,0.55)'
                                   : isBridge    ? '#FFD700'
                                   : isBentoEligible ? 'rgba(13,148,136,0.45)'
                                   : theme.hsl,
                        borderWidth: isAnchor ? 4 : isGrouper ? 3 : isExpanded ? 4 : isExpandable ? 3 : isBentoEligible ? 2 : 1,
                        borderColor: isExpanded ? '#f97316'
                                   : isAnchor ? '#fff'
                                   : isGrouper ? 'rgba(99,102,241,0.8)'
                                   : isExpandable ? 'rgba(99,102,241,0.8)'
                                   : isBentoEligible ? 'rgba(13,148,136,0.75)'
                                   : 'rgba(255,255,255,0.4)',
                        opacity: isDimmed ? 0.15 : 1
                    },
                };
            }),
            links: processed.links.filter(l => visibleNodes.some(n => n.id === l.source) && visibleNodes.some(n => n.id === l.target)).map(l => ({
                ...l,
                // Fix #5: Directional arrows radiate outward from identity anchor; suppressed on structural/similarity edges
                edgeSymbol: (l.type === 'TEMPORAL_SPINE' || l.type === 'SIMILAR' || l.type === 'YEAR_ANCHOR') ? ['none', 'none'] : ['none', 'arrow'],
                edgeSymbolSize: [0, 8],
                label: {
                    show: false,
                    formatter: (p: any) => {
                        const raw = p.data.link_label || p.data.discovery_reason || p.data.title || p.data.role || '';
                        return raw.length > 40 ? raw.slice(0, 38) + '…' : raw;
                    },
                    fontSize: 10,
                    fontWeight: 'bold',
                    color: '#6366f1'
                },
                emphasis: {
                    label: { show: false },
                    lineStyle: { width: 6, opacity: 1 }
                },
                lineStyle: {
                    color: (l.isVirtual || l.hasFederatedBridge) ? '#FFD700'
                         : l.type === 'TEMPORAL_SPINE' ? '#6366f1'
                         : l.type === 'YEAR_ANCHOR'    ? '#94a3b8'
                         : PODCAST_REL_FAMILIES.has(l.type) ? '#14b8a6'
                         : '#818cf8',
                    width: l.type === 'TEMPORAL_SPINE' ? 4 : ((l.isVirtual || l.hasFederatedBridge) ? 3 : 2),
                    type: (l.isVirtual || l.hasFederatedBridge) ? 'dashed' : 'solid',
                    opacity: (focusedNodeIds && focusedNodeIds.size > 0 && !focusedNodeIds.has(l.source) && !focusedNodeIds.has(l.target)) ? 0.08 : 0.8,
                    curveness: (viewMode === 'spine' && l.type !== 'TEMPORAL_SPINE') ? 0.3 : 0
                }
            }))
        }]
    });
    };

    const handleZoomIn = () => {
        const e = chartRef.current?.getEchartsInstance();
        if (!e) return;
        graphZoomRef.current = Math.min(graphZoomRef.current * 1.3, 6);
        e.setOption({ series: [{ type: 'graph', zoom: graphZoomRef.current }] });
    };
    const handleZoomOut = () => {
        const e = chartRef.current?.getEchartsInstance();
        if (!e) return;
        graphZoomRef.current = Math.max(graphZoomRef.current / 1.3, 0.15);
        e.setOption({ series: [{ type: 'graph', zoom: graphZoomRef.current }] });
    };
    const handleZoomReset = () => {
        const e = chartRef.current?.getEchartsInstance();
        if (!e) return;
        graphZoomRef.current = 1;
        e.setOption({ series: [{ type: 'graph', zoom: 1, center: ['50%', '50%'] }] });
    };

    // Auto-fit: after each bloom (node count changes), wait for force to settle then re-center
    const prevNodeCountRef = useRef(0);
    useEffect(() => {
        if (viewMode !== 'brain') return;
        const currentCount = data.nodes.length;
        if (currentCount > 0 && currentCount !== prevNodeCountRef.current) {
            prevNodeCountRef.current = currentCount;
            const timer = setTimeout(() => {
                const e = chartRef.current?.getEchartsInstance();
                if (!e || e.isDisposed()) return;
                // Scale zoom inversely with node count so all nodes remain visible after bloom
                const targetZoom = Math.max(0.35, 1 / Math.sqrt(Math.max(currentCount, 1) / 3));
                graphZoomRef.current = targetZoom;
                e.setOption({ series: [{ type: 'graph', zoom: targetZoom }] }, false);
            }, 900);
            return () => clearTimeout(timer);
        }
    }, [data.nodes.length, viewMode]);

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
                key={data.nodes.length > 0 ? 'populated' : 'empty'}
                notMerge={false}
                lazyUpdate={true}
            />
            {/* Zoom Controls */}
            <div className="absolute top-3 right-3 z-20 flex flex-col gap-1">
                <button
                    onClick={handleZoomIn}
                    className="w-8 h-8 rounded-lg bg-slate-800/90 border border-slate-700 text-white font-bold text-lg hover:bg-indigo-600 hover:border-indigo-500 transition-colors flex items-center justify-center shadow-lg"
                    title="Zoom in"
                >+</button>
                <button
                    onClick={handleZoomOut}
                    className="w-8 h-8 rounded-lg bg-slate-800/90 border border-slate-700 text-white font-bold text-lg hover:bg-indigo-600 hover:border-indigo-500 transition-colors flex items-center justify-center shadow-lg"
                    title="Zoom out"
                >−</button>
                <button
                    onClick={handleZoomReset}
                    className="w-8 h-8 rounded-lg bg-slate-800/90 border border-slate-700 text-slate-400 font-bold text-xs hover:bg-slate-700 hover:text-white hover:border-slate-500 transition-colors flex items-center justify-center shadow-lg"
                    title="Reset zoom"
                >⊡</button>
            </div>
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
