"use client";

import { useCortex } from '@/context/CortexContext';
import { useEffect, useState } from 'react';
import { Info, Target, Cpu, Calendar, ChevronRight } from 'lucide-react';

export default function Sidebar() {
    const { selectedNodeId, nodeDetails, setNodeDetails } = useCortex();
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!selectedNodeId) return;

        const fetchDetails = async () => {
            setLoading(true);
            try {
                // Call get_node_details via Gateway Proxy
                const response = await fetch('http://localhost:8080/sse'); // Initializing MCP via Proxy
                // Actually, let's call the tool directly via JSON-RPC if we can, 
                // or use a dedicated Gateway endpoint.
                // For simplicity in the demo, we'll assume a dedicated endpoint or 
                // formatted response from the gateway.
                
                // For the demo readiness, I will implement a simpler detail fetch 
                // that matches the Gateway's orchestration pattern.
                const res = await fetch(`http://localhost:3000/sse?query=Give me details for node id ${selectedNodeId}`);
                // Note: The SSE Agent will naturally update the Chat, but we want 
                // the Bento to be independent. For now, let's mock the detail fetch
                // or point to the direct MCP tool call.
                
                // REST Tool Call for the Bento on dedicated port 8000
                const toolRes = await fetch('http://localhost:8000/get_node_details', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ node_id: selectedNodeId })
                });
                const data = await toolRes.json();
                setNodeDetails(data);
            } catch (err) {
                console.error("Failed to fetch bento details:", err);
            } finally {
                setLoading(false);
            }
        };

        fetchDetails();
    }, [selectedNodeId]);

    if (!selectedNodeId) {
        return (
            <aside className="sidebar glass">
                <div className="logo brand">CortexDrive</div>
                <div className="empty-state" style={{ marginTop: '40px', textAlign: 'center', opacity: 0.5 }}>
                    <Info size={48} style={{ marginBottom: '16px' }} />
                    <p fontSize="14px">Select a landmark in the graph to view deep context.</p>
                </div>
            </aside>
        );
    }

    return (
        <aside className="sidebar glass overflow-y-auto">
            <div className="logo brand">CortexDrive</div>

            {loading ? (
                <div className="loading" style={{ marginTop: '40px' }}>Analyzing node...</div>
            ) : (
                <div className="bento-layout" style={{ marginTop: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
                    <div className="bento-header">
                        <div className="type-tag" style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--accent-blue)', marginBottom: '4px' }}>
                            {nodeDetails?.type || 'Entity'}
                        </div>
                        <h2 style={{ fontSize: '20px', fontWeight: 700 }}>{nodeDetails?.name || 'Selected Landmark'}</h2>
                    </div>

                    <div className="bento-section glass" style={{ padding: '16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', color: 'var(--accent-purple)' }}>
                            <Target size={14} />
                            <span style={{ fontSize: '12px', fontWeight: 600 }}>Professional Narrative</span>
                        </div>
                        <p style={{ fontSize: '13px', lineHeight: 1.6, opacity: 0.8 }}>
                            {nodeDetails?.properties?.description || nodeDetails?.properties?.text || 'No detailed narrative available for this landmark.'}
                        </p>
                    </div>

                    <div className="bento-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                        <div className="bento-item glass" style={{ padding: '12px' }}>
                            <Cpu size={14} style={{ marginBottom: '8px', color: 'var(--accent-blue)' }} />
                            <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>Core Tech</div>
                            <div style={{ fontSize: '12px', fontWeight: 500 }}>{nodeDetails?.properties?.tech_stack || 'Standard'}</div>
                        </div>
                        <div className="bento-item glass" style={{ padding: '12px' }}>
                            <Calendar size={14} style={{ marginBottom: '8px', color: 'var(--accent-blue)' }} />
                            <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>Timeline</div>
                            <div style={{ fontSize: '12px', fontWeight: 500 }}>{nodeDetails?.properties?.date || 'N/A'}</div>
                        </div>
                    </div>
                    
                    <button className="expand-button" style={{ 
                        marginTop: '12px',
                        padding: '12px',
                        borderRadius: '8px',
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid var(--surface-border)',
                        color: 'white',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        cursor: 'pointer'
                    }}>
                        <span style={{ fontSize: '13px' }}>Expand Topology</span>
                        <ChevronRight size={14} />
                    </button>
                </div>
            )}
        </aside>
    );
}
