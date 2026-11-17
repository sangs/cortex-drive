"use client";
/**
 * Daily cost, last 30 days, stacked by provider (FinOps S2-83 release 4). Plain bars, no chart library. Colours
 * follow the provider (lib/finops-types.ts), and the legend and the table on the page carry the same identity.
 */
import { useMemo, useState } from 'react';
import { formatUsd, providerColor, type FinopsSummary } from '@/lib/finops-types';

const CHART_HEIGHT_PX = 140;

export default function FinopsDailyChart({ daily }: { daily: FinopsSummary['daily'] }) {
    const [hover, setHover] = useState<string | null>(null);
    const { days, providers, max } = useMemo(() => {
        const byDate = new Map<string, Map<string, number>>();
        for (const row of daily) {
            const day = byDate.get(row.date) ?? new Map<string, number>();
            day.set(row.provider, (day.get(row.provider) ?? 0) + row.cost);
            byDate.set(row.date, day);
        }
        const days = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, parts]) => ({
            date, parts: [...parts.entries()].map(([provider, cost]) => ({ provider, cost })),
            total: [...parts.values()].reduce((s, c) => s + c, 0),
        }));
        const providers = [...new Set(daily.map(r => r.provider))];
        return { days, providers, max: Math.max(...days.map(d => d.total), 0) };
    }, [daily]);

    if (!days.length) return <p className="text-sm text-slate-500">No daily costs yet.</p>;
    const shown = days.find(d => d.date === hover);
    return (
        <div>
            <div className="flex items-end gap-[3px]" style={{ height: CHART_HEIGHT_PX }} role="img"
                 aria-label="Daily cost for the last 30 days, stacked by provider">
                {days.map(d => (
                    <div key={d.date} className="flex-1 flex flex-col-reverse cursor-default"
                         style={{ height: max ? `${(d.total / max) * 100}%` : 0 }}
                         onMouseEnter={() => setHover(d.date)} onMouseLeave={() => setHover(null)}>
                        {d.parts.map(p => (
                            <div key={p.provider} style={{ height: d.total ? `${(p.cost / d.total) * 100}%` : 0, background: providerColor(p.provider) }} />
                        ))}
                    </div>
                ))}
            </div>
            <div className="flex justify-between text-[11px] text-slate-400 mt-1">
                <span>{days[0].date}</span>
                <span className="text-slate-600 font-medium">
                    {shown ? `${shown.date}: ${formatUsd(shown.total)} (${shown.parts.map(p => `${p.provider} ${formatUsd(p.cost)}`).join(', ')})` : ''}
                </span>
                <span>{days[days.length - 1].date}</span>
            </div>
            <div className="flex gap-4 mt-2 text-xs text-slate-600">
                {providers.map(p => (
                    <span key={p} className="inline-flex items-center gap-1.5">
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: providerColor(p) }} aria-hidden /> {p}
                    </span>
                ))}
            </div>
        </div>
    );
}
