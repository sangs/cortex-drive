"use client";

import { motion } from "framer-motion";
import { BookOpen, Link as LinkIcon } from "lucide-react";

interface KnowledgeNodeProps {
    title: string;
    description: string;
    episodeNumber: number;
    sourceUrl?: string;
}

export default function KnowledgeNode({ title, description, episodeNumber, sourceUrl }: KnowledgeNodeProps) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            whileHover={{ scale: 1.02 }}
            className="p-5 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md shadow-xl max-w-md"
        >
            <div className="flex items-center gap-3 mb-3">
                <div className="p-2 rounded-lg bg-indigo-500/20 text-indigo-400">
                    <BookOpen className="w-5 h-5" />
                </div>
                <div>
                    <h3 className="font-semibold text-lg leading-tight uppercase tracking-wide text-indigo-300">
                        Node {episodeNumber}
                    </h3>
                    <h2 className="text-xl font-bold bg-gradient-to-r from-white to-white/60 bg-clip-text text-transparent">
                        {title}
                    </h2>
                </div>
            </div>

            <p className="text-slate-400 text-sm leading-relaxed mb-4">
                {description}
            </p>

            {sourceUrl && (
                <a
                    href={sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-xs font-medium text-slate-500 hover:text-indigo-400 transition-colors"
                >
                    <LinkIcon className="w-3 h-3" />
                    View Source Episode
                </a>
            )}
        </motion.div>
    );
}
