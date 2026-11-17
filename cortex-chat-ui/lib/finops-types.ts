// /finops response contract: the central FinOps design §4.2, served by the gateway's GET /api/finops/summary
// (cortex-gateway/utils/finops.js). finops-admin owns the contract; this is a local copy of its types until
// `@finops-admin/contract` is published (cortex-drive tracker RV-14). Same shape as gmail-digest's lib/finops-types.ts.

export interface FinopsSummary {
    project: string;
    currency: 'USD';
    generated_at: string;
    cached: boolean;
    as_of: Record<string, string | null>;
    totals: {
        today: number;
        month_to_date: number;
        last_month: number;
        forecast_month_end: number;
        threshold: number | null;   // null = record only (cortex-drive has no budget yet)
        pct_of_threshold: number | null;
    };
    live: { app_spend_today_utc: number | null };
    by_provider: { provider: string; mtd: number; sources: string[] }[];
    by_gcp_service: { service: string; mtd: number }[];
    daily: { date: string; provider: string; cost: number }[];
    sources: { source: string; provider: string; as_of: string | null; stale: boolean }[];
    alerts: { level: 'warning' | 'critical'; message: string }[];
    untracked_before: string | null;
}

/** Where each number comes from, in words. */
export const SOURCE_LABEL: Record<string, string> = {
    billing_export: 'Google Cloud billing export',
    app_recorded: 'recorded by this app',
    plan: 'fixed monthly plan',
    provider_api: 'provider API',
};

/** Provider colours for the chart and table (identity by provider, never by rank); anything else is "Other". */
export const PROVIDER_COLOR: Record<string, string> = {
    'Google Cloud': '#4f46e5',
    OpenAI: '#0d9488',
};
export const OTHER_PROVIDER_COLOR = '#94a3b8';
export const providerColor = (provider: string): string => PROVIDER_COLOR[provider] ?? OTHER_PROVIDER_COLOR;

export function formatUsd(value: number): string {
    const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}
