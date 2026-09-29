"use client";

import React, { useState, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Globe, Loader2, CheckCircle2 } from 'lucide-react';
import { useAuth } from '@clerk/nextjs';

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:4000';

interface AddSourceModalProps {
    open: boolean;
    onClose: () => void;
}

type Status = 'idle' | 'submitting' | 'success' | 'error';

export default function AddSourceModal({ open, onClose }: AddSourceModalProps) {
    const { getToken } = useAuth();
    const [url, setUrl] = useState('');
    const [status, setStatus] = useState<Status>('idle');
    const [message, setMessage] = useState('');

    const reset = useCallback(() => {
        setUrl('');
        setStatus('idle');
        setMessage('');
    }, []);

    const handleClose = useCallback(() => {
        reset();
        onClose();
    }, [reset, onClose]);

    const handleSubmit = useCallback(async () => {
        if (!url.trim()) return;
        setStatus('submitting');
        setMessage('');
        try {
            const token = await getToken();
            const resp = await fetch(`${GATEWAY}/api/register_website_source`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify({ url: url.trim() }),
            });
            const data = await resp.json();
            const payload = data.content?.[0]?.text ? JSON.parse(data.content[0].text) : data;
            if (payload.error) {
                setStatus('error');
                setMessage(payload.error);
            } else if (payload.skipped) {
                setStatus('success');
                setMessage(payload.message || 'Already registered — no changes since last ingestion.');
            } else {
                setStatus('success');
                setMessage(payload.name ? `Ingested: ${payload.name}` : 'Source ingested successfully.');
            }
        } catch (e: any) {
            setStatus('error');
            setMessage(e?.message || 'Failed to reach the server.');
        }
    }, [url, getToken]);

    if (!open) return null;

    return ReactDOM.createPortal(
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
                onClick={handleClose}
            >
                <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: 8 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 8 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                    className="bg-[#0f1117] border border-white/10 rounded-3xl p-6 w-full max-w-md shadow-2xl"
                    onClick={e => e.stopPropagation()}
                >
                    <div className="flex items-start justify-between mb-5">
                        <div>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-indigo-400 mb-0.5">Add Source</p>
                            <h3 className="text-base font-bold text-white leading-tight">Register a website</h3>
                        </div>
                        <button onClick={handleClose} className="p-1.5 rounded-xl hover:bg-white/5 text-slate-500 hover:text-white transition-all">
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="space-y-4">
                        <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5">
                            <Globe className="w-4 h-4 text-slate-500 shrink-0" />
                            <input
                                type="url"
                                value={url}
                                onChange={e => setUrl(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter' && status !== 'submitting') handleSubmit(); }}
                                placeholder="https://example.com/article"
                                disabled={status === 'submitting'}
                                className="bg-transparent text-sm text-slate-200 placeholder:text-slate-600 flex-1 outline-none disabled:opacity-50"
                                autoFocus
                            />
                        </div>

                        {status === 'submitting' && (
                            <p className="text-[11px] text-slate-500 flex items-center gap-2">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                Ingesting page… this can take up to 30s.
                            </p>
                        )}
                        {status === 'success' && (
                            <p className="text-[11px] text-emerald-400 flex items-center gap-2">
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                {message}
                            </p>
                        )}
                        {status === 'error' && (
                            <p className="text-[11px] text-rose-400">{message}</p>
                        )}

                        {status === 'success' ? (
                            <button
                                onClick={handleClose}
                                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white text-xs font-bold transition-all"
                            >
                                Done
                            </button>
                        ) : (
                            <button
                                onClick={handleSubmit}
                                disabled={status === 'submitting' || !url.trim()}
                                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all disabled:opacity-50"
                            >
                                {status === 'submitting' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Globe className="w-3.5 h-3.5" />}
                                {status === 'error' ? 'Retry' : 'Ingest'}
                            </button>
                        )}
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>,
        document.body
    );
}
