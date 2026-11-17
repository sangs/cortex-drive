"use client";
/**
 * Owner-only cost page (FinOps S2-83 release 4; design finops-cost-tracking-design-2026-11-16 §6, §13).
 * What cortex-drive costs to run, all users together, read from its own views in finops-admin through the gateway's
 * GET /api/finops/summary. The gateway answers 404 to everyone but the platform owner, and so does this page
 * (Next.js notFound), so its existence isn't revealed. Read only: nothing here changes spend.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { AlertTriangle, ArrowLeft, Loader2, OctagonAlert, RefreshCw } from 'lucide-react';

import { GATEWAY_URL } from '@/lib/gateway';
import { SOURCE_LABEL, formatUsd, providerColor, type FinopsSummary } from '@/lib/finops-types';
import FinopsDailyChart from '@/components/FinopsDailyChart';

function ago(iso: string | null): string {
    if (!iso) return 'never';
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-bold text-slate-900 mb-4">{title}</h2>
            {children}
        </section>
    );
}

function Tile({ label, value, note }: { label: string; value: number; note?: string }) {
    return (
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
            <p className="text-xs text-slate-500">{label}</p>
            <p className="text-2xl font-bold tabular-nums mt-1 text-slate-900">{formatUsd(value)}</p>
            {note && <p className="text-[11px] text-slate-500 mt-1">{note}</p>}
        </div>
    );
}

export default function FinopsPage() {
    const { getToken } = useAuth();
    const [data, setData] = useState<FinopsSummary | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [missing, setMissing] = useState(false);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async (refresh = false) => {
        setLoading(true);
        setError(null);
        try {
            const token = await getToken();
            if (!token) { setMissing(true); return; }
            const res = await fetch(`${GATEWAY_URL}/api/finops/summary${refresh ? '?refresh=1' : ''}`,
                { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
            if (res.status === 404) { setMissing(true); return; }
            const body = await res.json().catch(() => ({}));
            if (!res.ok) { setError(body.error ?? `Could not load costs (HTTP ${res.status})`); return; }
            setData(body as FinopsSummary);
        } catch {
            setError('Could not load costs. Try again shortly.');
        } finally {
            setLoading(false);
        }
    }, [getToken]);

    useEffect(() => { load(); }, [load]);

    if (missing) notFound();
    const t = data?.totals;

    return (
        <div className="min-h-screen bg-slate-50">
            <div className="max-w-5xl mx-auto px-6 py-8 space-y-5">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                        <Link href="/dashboard" className="p-2 rounded-xl hover:bg-white border border-transparent hover:border-slate-200" title="Back to dashboard">
                            <ArrowLeft className="w-4 h-4 text-slate-600" />
                        </Link>
                        <h1 className="text-2xl font-bold text-slate-900">Costs</h1>
                    </div>
                    <button onClick={() => load(true)} disabled={loading}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border border-slate-200 text-xs font-bold text-slate-600 hover:text-indigo-600 disabled:opacity-50">
                        <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
                    </button>
                </div>
                <p className="text-sm text-slate-500">
                    What Cortex-Drive costs to run, all users together: Google Cloud and OpenAI. Months follow Pacific time,
                    like Google Cloud invoices. Only you can see this page.
                </p>

                {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

                {data?.alerts.map(a => (
                    <p key={a.message} role="status"
                       className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${a.level === 'critical' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`}>
                        {a.level === 'critical' ? <OctagonAlert className="h-4 w-4 flex-shrink-0" /> : <AlertTriangle className="h-4 w-4 flex-shrink-0" />}
                        {a.message}
                    </p>
                ))}

                {!data && !error && (
                    <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading costs…</p>
                )}

                {data && t && (
                    <>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            <Tile label="Today" value={t.today}
                                  note={data.live.app_spend_today_utc != null ? `OpenAI since 00:00 UTC: ${formatUsd(data.live.app_spend_today_utc)} (live)` : undefined} />
                            <Tile label="Month to date" value={t.month_to_date} />
                            <Tile label="Month-end forecast" value={t.forecast_month_end} note="at this month's daily average" />
                            <Tile label="Last month" value={t.last_month} />
                        </div>

                        <Section title="Monthly limit">
                            <p className="text-sm text-slate-500">
                                {t.threshold != null && t.pct_of_threshold != null
                                    ? `${formatUsd(t.month_to_date)} of ${formatUsd(t.threshold)} (${t.pct_of_threshold.toFixed(1)}%)`
                                    : 'No limit set: costs are recorded only.'}
                            </p>
                        </Section>

                        <Section title="This month by provider">
                            <table className="w-full text-sm tabular-nums">
                                <thead className="text-xs text-slate-500">
                                    <tr><th className="text-left font-normal pb-2">Provider</th><th className="text-left font-normal pb-2">Source</th><th className="text-right font-normal pb-2">Month to date</th></tr>
                                </thead>
                                <tbody>
                                    {data.by_provider.map(p => (
                                        <tr key={p.provider} className="border-t border-slate-100">
                                            <td className="py-2"><span className="inline-flex items-center gap-2">
                                                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: providerColor(p.provider) }} aria-hidden />{p.provider}</span></td>
                                            <td className="py-2 text-slate-500">{p.sources.map(s => SOURCE_LABEL[s] ?? s).join(', ')}</td>
                                            <td className="py-2 text-right">{formatUsd(p.mtd)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {data.by_gcp_service.length > 0 && (
                                <p className="text-xs text-slate-500 mt-3">
                                    Google Cloud by service: {data.by_gcp_service.map(s => `${s.service} ${formatUsd(s.mtd)}`).join(' · ')}
                                </p>
                            )}
                        </Section>

                        <Section title="Daily, last 30 days">
                            <FinopsDailyChart daily={data.daily} />
                        </Section>

                        <Section title="Data freshness">
                            <ul className="space-y-1.5 text-sm">
                                {data.sources.map(s => (
                                    <li key={s.source} className="flex items-center justify-between gap-3">
                                        <span>{s.provider} <span className="text-slate-500">· {SOURCE_LABEL[s.source] ?? s.source}</span></span>
                                        <span className={`text-xs ${s.stale ? 'font-bold text-amber-700' : 'text-slate-500'}`}>
                                            {s.stale ? 'Out of date · ' : ''}as of {ago(s.as_of)}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                            <p className="text-[11px] text-slate-500 mt-3">
                                Google Cloud costs arrive from Google a few times a day; OpenAI spend is pushed at 02:15 and 14:15 UTC
                                and shown live for today; totals refresh every 4 hours. Page data {data.cached ? 'cached, ' : ''}from {ago(data.generated_at)}.
                                {data.untracked_before && ` OpenAI spend is recorded from ${data.untracked_before}.`} Not included yet: fixed-price plans
                                (Neo4j Aura, Upstash, Clerk, Resend) and Anthropic.
                            </p>
                        </Section>
                    </>
                )}
            </div>
        </div>
    );
}
