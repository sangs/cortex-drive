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
    // If message is just a string, render as text
    if (typeof message === "string") {
        return <p className="text-slate-300 leading-relaxed">{message}</p>;
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
