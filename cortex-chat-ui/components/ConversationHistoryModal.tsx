"use client";

import React, { useState, useEffect, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, History, Trash2, Loader2, MessageSquare, ChevronRight } from 'lucide-react';
import { useAuth } from '@clerk/nextjs';

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:4000';

interface ConversationListItem {
    conversation_id: string;
    title: string | null;
    updated_at: string;
    message_count: number;
    last_question: string | null;
}

interface ConversationDetail extends ConversationListItem {
    domain_signal: string | null;
    latest_graph_snapshot: { nodes: any[]; links: any[] } | null;
    messages: { role: 'user' | 'assistant'; content: string; created_at: string }[];
}

interface ConversationHistoryModalProps {
    open: boolean;
    onClose: () => void;
    onOpenConversation: (conversation: ConversationDetail) => void;
}

function formatRelativeDate(iso: string) {
    const date = new Date(iso);
    const diffMs = Date.now() - date.getTime();
    const diffMins = Math.round(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.round(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.round(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ConversationHistoryModal({ open, onClose, onOpenConversation }: ConversationHistoryModalProps) {
    const { getToken } = useAuth();
    const [conversations, setConversations] = useState<ConversationListItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [opening, setOpening] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<string | null>(null);

    const authHeaders = useCallback(async () => {
        const token = await getToken();
        return {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        };
    }, [getToken]);

    const loadConversations = useCallback(async () => {
        setLoading(true);
        try {
            const headers = await authHeaders();
            const resp = await fetch(`${GATEWAY}/api/conversations`, { headers });
            if (resp.ok) setConversations(await resp.json());
        } catch { /* non-fatal */ } finally {
            setLoading(false);
        }
    }, [authHeaders]);

    useEffect(() => {
        if (open) loadConversations();
    }, [open, loadConversations]);

    if (!open) return null;

    async function openConversation(conversationId: string) {
        setOpening(conversationId);
        try {
            const headers = await authHeaders();
            const resp = await fetch(`${GATEWAY}/api/conversations/${encodeURIComponent(conversationId)}`, { headers });
            if (resp.ok) {
                const data: ConversationDetail = await resp.json();
                onOpenConversation(data);
                onClose();
            }
        } catch { /* non-fatal */ } finally {
            setOpening(null);
        }
    }

    async function deleteConversation(conversationId: string, e: React.MouseEvent) {
        e.stopPropagation();
        setDeleting(conversationId);
        try {
            const headers = await authHeaders();
            await fetch(`${GATEWAY}/api/conversations/${encodeURIComponent(conversationId)}`, {
                method: 'DELETE',
                headers,
            });
            setConversations(prev => prev.filter(c => c.conversation_id !== conversationId));
        } catch { /* non-fatal */ } finally {
            setDeleting(null);
        }
    }

    return ReactDOM.createPortal(
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
                onClick={onClose}
            >
                <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: 8 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 8 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                    className="bg-[#0f1117] border border-white/10 rounded-3xl p-6 w-full max-w-md shadow-2xl"
                    onClick={e => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className="flex items-start justify-between mb-5">
                        <div>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-indigo-400 mb-0.5">History</p>
                            <h3 className="text-base font-bold text-white leading-tight flex items-center gap-2">
                                <History className="w-4 h-4" />
                                Conversation History
                            </h3>
                        </div>
                        <button onClick={onClose} className="p-1.5 rounded-xl hover:bg-white/5 text-slate-500 hover:text-white transition-all">
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    {loading ? (
                        <div className="flex justify-center py-8">
                            <Loader2 className="w-5 h-5 text-slate-500 animate-spin" />
                        </div>
                    ) : conversations.length === 0 ? (
                        <p className="text-xs text-slate-500 text-center py-8">No prior conversations yet.</p>
                    ) : (
                        <div className="space-y-2 max-h-96 overflow-y-auto">
                            {conversations.map(c => (
                                <div
                                    key={c.conversation_id}
                                    onClick={() => openConversation(c.conversation_id)}
                                    className="flex items-center justify-between p-3 bg-white/3 border border-white/5 rounded-xl cursor-pointer hover:bg-white/5 hover:border-white/10 transition-all"
                                >
                                    <div className="flex items-center gap-2.5 flex-1 min-w-0">
                                        {opening === c.conversation_id
                                            ? <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin shrink-0" />
                                            : <MessageSquare className="w-3.5 h-3.5 text-slate-500 shrink-0" />}
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-1.5">
                                                <p className="text-[11px] text-slate-300 truncate">{c.title || 'Untitled conversation'}</p>
                                                {c.message_count > 2 && (
                                                    <span className="shrink-0 text-[9px] font-bold text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 rounded-full px-1.5 py-0.5">
                                                        {Math.ceil(c.message_count / 2)} exchanges
                                                    </span>
                                                )}
                                            </div>
                                            {c.last_question && c.last_question !== c.title && (
                                                <p className="text-[10px] text-slate-400 truncate mt-0.5">Last asked: {c.last_question}</p>
                                            )}
                                            <p className="text-[10px] text-slate-500 mt-0.5">{formatRelativeDate(c.updated_at)}</p>
                                        </div>
                                    </div>
                                    <ChevronRight className="w-3.5 h-3.5 text-slate-600 ml-1 shrink-0" />
                                    <button
                                        onClick={e => deleteConversation(c.conversation_id, e)}
                                        disabled={deleting === c.conversation_id}
                                        className="p-1.5 ml-2 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all shrink-0"
                                        title="Delete this conversation"
                                    >
                                        {deleting === c.conversation_id
                                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                            : <Trash2 className="w-3.5 h-3.5" />}
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    <p className="text-[10px] text-slate-500 mt-4">Only visible to you. Deleting removes a conversation from this list.</p>
                </motion.div>
            </motion.div>
        </AnimatePresence>,
        document.body
    );
}
