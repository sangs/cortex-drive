"use client";

import React from "react";
import KnowledgeNode from "./KnowledgeNode";

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface A2UIMessage {
    type: string;
    props: any;
}

const COMPONENT_MAP: Record<string, React.ComponentType<any>> = {
    "knowledge-node": KnowledgeNode,
    // Future components like "source-link", "commercial-score" go here
};

export default function A2UIRenderer({ message }: { message: A2UIMessage | string }) {
    // If message is just a string, render as formatted markdown
    if (typeof message === "string") {
        return (
            <div className="text-slate-300 leading-relaxed text-sm prose prose-invert prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {message}
                </ReactMarkdown>
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
