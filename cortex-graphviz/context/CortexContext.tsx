'use client';
import React, { createContext, useContext, useState, ReactNode } from 'react';

interface Message {
    role: 'user' | 'bot';
    content: string;
}

interface GraphNode {
    id: string;
    name: string;
    type: string;
    isBackbone?: boolean;
    isBentoEligible?: boolean;
}

interface CortexContextType {
    messages: Message[];
    graphData: GraphData;
    selectedNodeId: string | null;
    nodeDetails: any | null;
    setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
    setGraphData: React.Dispatch<React.SetStateAction<GraphData>>;
    setSelectedNodeId: (id: string | null) => void;
    setNodeDetails: (details: any | null) => void;
    addMessage: (msg: Message) => void;
    updateGraph: (data: GraphData) => void;
}

const CortexContext = createContext<CortexContextType | undefined>(undefined);

export function CortexProvider({ children }: { children: ReactNode }) {
    const [messages, setMessages] = useState<Message[]>([
        { role: 'bot', content: "Hello! I'm your Cortex AI. How can I help you explore your mental models today?" }
    ]);
    const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [nodeDetails, setNodeDetails] = useState<any | null>(null);

    const addMessage = (msg: Message) => setMessages(prev => [...prev, msg]);
    const updateGraph = (data: GraphData) => setGraphData(data);

    return (
        <CortexContext.Provider value={{ 
            messages, graphData, selectedNodeId, nodeDetails,
            setMessages, setGraphData, setSelectedNodeId, setNodeDetails,
            addMessage, updateGraph 
        }}>
            {children}
        </CortexContext.Provider>
    );
}

export function useCortex() {
    const context = useContext(CortexContext);
    if (context === undefined) {
        throw new Error('useCortex must be used within a CortexProvider');
    }
    return context;
}
