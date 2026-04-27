'use client';
import { useEffect, useRef } from 'react';
import { useCortex } from '@/context/CortexContext';
import { useAuth } from '@clerk/nextjs';

export function useSSE() {
    const { addMessage, setGraphData } = useCortex();
    const { orgId } = useAuth();
    const eventSourceRef = useRef<EventSource | null>(null);

    const connect = (query: string) => {
        const url = new URL('http://localhost:4000/sse');
        url.searchParams.append('query', query);

        if (orgId) {
            url.searchParams.append('org_id', orgId);
        }

        const eventSource = new EventSource(url.toString());
        eventSourceRef.current = eventSource;

        eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                // Handle different event types from our Python SSE Server
                if (data.type === 'chat_response') {
                    addMessage({ role: 'bot', content: data.content });
                } else if (data.type === 'graph_update') {
                    // A2UI logic: Update the knowledge graph
                    setGraphData(data.graph);
                } else if (data.type === 'error') {
                    addMessage({ role: 'bot', content: `Error: ${data.message}` });
                    eventSource.close();
                }
            } catch (err) {
                console.error('Failed to parse SSE message:', err);
            }
        };

        eventSource.onerror = (err) => {
            console.error('SSE Error:', err);
            eventSource.close();
        };
    };

    useEffect(() => {
        return () => {
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
            }
        };
    }, []);

    return { connect };
}
