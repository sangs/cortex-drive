"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@clerk/nextjs";
import { MCPClient } from "@/lib/mcp-client";

export function useMCP() {
    const { getToken, userId, orgId } = useAuth();
    const [client, setClient] = useState<MCPClient | null>(null);
    const [isConnected, setIsConnected] = useState(false);
    const [responses, setResponses] = useState<any[]>([]);
    const clientRef = useRef<MCPClient | null>(null);

    useEffect(() => {
        if (!userId) return; // Do not connect if not authenticated
        const tenantId = orgId || userId; // Prefer Organization ID, fallback to User ID
        console.log("Initializing MCP Client for tenant:", tenantId);

        const serverUrl = process.env.NEXT_PUBLIC_MCP_SERVER_URL || "http://localhost:4000/sse";

        const mcpClient = new MCPClient(serverUrl, tenantId, getToken, (msg: any) => {
            console.log("MCP Message received:", msg);
            setResponses((prev) => [...prev, msg]);
        });

        mcpClient.connect().then(() => {
            setIsConnected(true);
            console.log("MCP Client connected successfully");
        }).catch(err => {
            console.error("MCP Client connection failed", err);
        });

        clientRef.current = mcpClient;
        setClient(mcpClient);

        return () => {
            // Cleanup if needed (the fetch-event-source might need an abort controller)
        };
    }, [userId]);

    const callTool = useCallback(async (name: string, args: any = {}) => {
        if (!clientRef.current) throw new Error("MCP Client not initialized");

        return await clientRef.current.sendMessage("tools/call", {
            name,
            arguments: args
        });
    }, []);

    const abortControllerRef = useRef<AbortController | null>(null);
    
    const abortQuery = useCallback(() => {
        if (abortControllerRef.current) {
            console.log("Aborting current MCP query...");
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
    }, []);

    const query = useCallback(async (question: string, history: any[] = [], forceRefresh: boolean = false, isContextualFusion: boolean = false) => {
        if (!clientRef.current) throw new Error("MCP Client not initialized");
        
        // Abort any existing query
        if (abortControllerRef.current) abortControllerRef.current.abort();
        
        const controller = new AbortController();
        abortControllerRef.current = controller;
        
        try {
            return await clientRef.current.query(question, history, forceRefresh, isContextualFusion, controller.signal);
        } finally {
            if (abortControllerRef.current === controller) {
                abortControllerRef.current = null;
            }
        }
    }, []);

    return { isConnected, responses, callTool, query, abortQuery };
}
