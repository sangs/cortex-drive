"use client";

import React from "react";
import KnowledgeNode from "./KnowledgeNode";

interface A2UIMessage {
    type: string;
    props: any;
}

const COMPONENT_MAP: Record<string, React.ComponentType<any>> = {
    "knowledge-node": KnowledgeNode,
    // Future components like "source-link", "commercial-score" go here
};

export default function A2UIRenderer({ message }: { message: A2UIMessage | string }) {
    // If message is just a string, render as formatted text
    if (typeof message === "string") {
        const lines = message.split('\n');
        return (
            <div className="text-slate-300 leading-relaxed space-y-2">
                {lines.map((line, idx) => {
                    // Simple bolding: **text** -> <strong>text</strong>
                    const parts = line.split(/(\*\*.*?\*\*)/g);
                    return (
                        <p key={idx} className="min-h-[1.5em]">
                            {parts.map((part, i) => {
                                if (part.startsWith('**') && part.endsWith('**')) {
                                    return <strong key={i} className="text-white font-semibold">{part.slice(2, -2)}</strong>;
                                }
                                return part;
                            })}
                        </p>
                    );
                })}
            </div>
        );
    }

    const Component = COMPONENT_MAP[message.type];

    if (!Component) {
        return (
            <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
                Unknown component type: {message.type}
            </div>
        );
    }

    return <Component {...message.props} />;
}
