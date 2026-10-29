"use client";

import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Globe, Loader2, CheckCircle2, FileText } from 'lucide-react';
import { useAuth } from '@clerk/nextjs';
import type { SourceVisibility } from '@/hooks/use-capabilities';

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:4000';
// Phase B M3': the Document option is off unless the deployment enables it (feature flag).
const DOCUMENT_SOURCES_ENABLED = process.env.NEXT_PUBLIC_ENABLE_DOCUMENT_SOURCES === 'true';

const VISIBILITY_OPTIONS: { value: SourceVisibility; label: string; hint: string }[] = [
    { value: 'private', label: 'Private', hint: 'Only you, plus people and groups you share it with.' },
    { value: 'organization', label: 'Organization', hint: 'Every member of your organization.' },
    { value: 'public', label: 'Public', hint: 'Everyone, including guest links (platform owner only).' },
];
const DOCUMENT_STATUS_POLL_MS = 5000;
const DOCUMENT_STATUS_POLL_LIMIT = 120;   // stop polling after 10 minutes; the worker keeps going
const DOCUMENT_FINAL_STATES = new Set(['done', 'unchanged', 'failed']);

interface AddSourceModalProps {
    open: boolean;
    onClose: () => void;
    // Visibilities this user may choose (S2-69, from /api/me/capabilities); the server enforces the same.
    allowedVisibilities: SourceVisibility[];
}

type Status = 'idle' | 'submitting' | 'processing' | 'success' | 'error';
type SourceKind = 'website' | 'document';

const parsePayload = async (resp: Response) => {
    const data = await resp.json();
    return data.content?.[0]?.text ? JSON.parse(data.content[0].text) : data;
};

export default function AddSourceModal({ open, onClose, allowedVisibilities }: AddSourceModalProps) {
    const visibilityOptions = VISIBILITY_OPTIONS.filter(o => allowedVisibilities.includes(o.value));
    const { getToken } = useAuth();
    const [url, setUrl] = useState('');
    const [status, setStatus] = useState<Status>('idle');
    const [message, setMessage] = useState('');
    const [kind, setKind] = useState<SourceKind>('website');
    // Who will see the new source (S2-44 / M5-11). Private by default; the server enforces who may
    // choose Organization (owner or org admin) and Public (platform owner only).
    const [visibility, setVisibility] = useState<SourceVisibility>('private');
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const stopPolling = useCallback(() => {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
    }, []);

    useEffect(() => stopPolling, [stopPolling]);

    const reset = useCallback(() => {
        stopPolling();
        setUrl('');
        setStatus('idle');
        setMessage('');
    }, [stopPolling]);

    const handleClose = useCallback(() => {
        reset();
        onClose();
    }, [reset, onClose]);

    const postTool = useCallback(async (tool: string, body: object) => {
        const token = await getToken();
        const resp = await fetch(`${GATEWAY}/api/${tool}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify(body),
        });
        if (resp.status === 403) return { error: (await resp.json()).error || 'Not allowed.' };
        return parsePayload(resp);
    }, [getToken]);

    const pollDocumentStatus = useCallback((docUrl: string) => {
        let polls = 0;
        stopPolling();
        pollRef.current = setInterval(async () => {
            polls += 1;
            try {
                const s = await postTool('get_document_source_status', { url: docUrl });
                if (s.state === 'done' || s.state === 'unchanged') {
                    stopPolling();
                    setStatus('success');
                    setMessage(s.state === 'unchanged'
                        ? 'Already up to date — the document has not changed since the last ingestion.'
                        : `Ingested: ${s.graph?.name || docUrl}${s.graph?.figures_pending ? ` (${s.graph.figures_pending} figure description(s) pending)` : ''}`);
                } else if (s.state === 'failed') {
                    stopPolling();
                    setStatus('error');
                    setMessage(s.error || 'Ingestion failed.');
                } else {
                    setMessage(s.state === 'running' ? 'Processing the document…' : 'Queued…');
                }
            } catch { /* transient; keep polling */ }
            if (polls >= DOCUMENT_STATUS_POLL_LIMIT && pollRef.current) {
                stopPolling();
                setStatus('success');
                setMessage('Still processing in the background. It will appear in the graph when done.');
            }
        }, DOCUMENT_STATUS_POLL_MS);
    }, [postTool, stopPolling]);

    const handleSubmit = useCallback(async () => {
        if (!url.trim()) return;
        setStatus('submitting');
        setMessage('');
        if (kind === 'document') {
            try {
                const payload = await postTool('register_document_source', { url: url.trim(), visibility });
                if (payload.error) {
                    setStatus('error');
                    setMessage(payload.error);
                } else {
                    setStatus('processing');
                    setMessage(payload.message || 'Queued…');
                    pollDocumentStatus(url.trim());
                }
            } catch (e: any) {
                setStatus('error');
                setMessage(e?.message || 'Failed to reach the server.');
            }
            return;
        }
        try {
            const token = await getToken();
            const resp = await fetch(`${GATEWAY}/api/register_website_source`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify({ url: url.trim(), visibility }),
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
    }, [url, kind, getToken, postTool, pollDocumentStatus]);

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
                            <h3 className="text-base font-bold text-white leading-tight">{kind === 'document' ? 'Register a document' : 'Register a website'}</h3>
                        </div>
                        <button onClick={handleClose} className="p-1.5 rounded-xl hover:bg-white/5 text-slate-500 hover:text-white transition-all">
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="space-y-4">
                        {DOCUMENT_SOURCES_ENABLED && (
                            <div className="flex gap-2">
                                {(['website', 'document'] as SourceKind[]).map(k => (
                                    <button
                                        key={k}
                                        onClick={() => { if (status !== 'submitting' && status !== 'processing') { setKind(k); setStatus('idle'); setMessage(''); } }}
                                        className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-bold border transition-all ${kind === k ? 'bg-indigo-600/20 border-indigo-500/50 text-indigo-300' : 'bg-white/5 border-white/10 text-slate-500 hover:text-slate-300'}`}
                                    >
                                        {k === 'document' ? <FileText className="w-3.5 h-3.5" /> : <Globe className="w-3.5 h-3.5" />}
                                        {k === 'document' ? 'Document (PDF, DOCX, PPTX)' : 'Website'}
                                    </button>
                                ))}
                            </div>
                        )}
                        <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5">
                            {kind === 'document' ? <FileText className="w-4 h-4 text-slate-500 shrink-0" /> : <Globe className="w-4 h-4 text-slate-500 shrink-0" />}
                            <input
                                type="url"
                                value={url}
                                onChange={e => setUrl(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter' && status !== 'submitting' && status !== 'processing') handleSubmit(); }}
                                placeholder={kind === 'document' ? 'https://example.com/report.pdf' : 'https://example.com/article'}
                                disabled={status === 'submitting' || status === 'processing'}
                                className="bg-transparent text-sm text-slate-200 placeholder:text-slate-600 flex-1 outline-none disabled:opacity-50"
                                autoFocus
                            />
                        </div>

                        <div className="flex items-center gap-2">
                            <label htmlFor="source-visibility" className="text-[11px] text-slate-400 shrink-0">Visible to</label>
                            <select
                                id="source-visibility"
                                value={visibility}
                                onChange={e => setVisibility(e.target.value as SourceVisibility)}
                                disabled={status === 'submitting' || status === 'processing'}
                                className="bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-slate-200 outline-none disabled:opacity-50"
                            >
                                {visibilityOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                            <span className="text-[11px] text-slate-500">{VISIBILITY_OPTIONS.find(o => o.value === visibility)?.hint}</span>
                        </div>

                        {status === 'submitting' && (
                            <p className="text-[11px] text-slate-500 flex items-center gap-2">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                {kind === 'document' ? 'Queuing the document…' : 'Ingesting page… this can take up to 30s.'}
                            </p>
                        )}
                        {status === 'processing' && (
                            <p className="text-[11px] text-slate-400 flex items-center gap-2">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                {message} You can close this window; processing continues.
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
                                disabled={status === 'submitting' || status === 'processing' || !url.trim()}
                                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all disabled:opacity-50"
                            >
                                {status === 'submitting' || status === 'processing' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : kind === 'document' ? <FileText className="w-3.5 h-3.5" /> : <Globe className="w-3.5 h-3.5" />}
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
