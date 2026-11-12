// Bridge target domains as returned by the list_bridge_domains MCP tool
// (bridge-discovery-and-bento-panel-design-2026-11-03.md §1). The server owns the list.
export type BridgeDomainOption = { id: string; display_name: string; has_visible_content: boolean };
export type BridgeOptions = { auto: string; domains: BridgeDomainOption[] };

// ── Bridge progress (cross-domain discovery design 2026-11-09 §4.3, Phase 1b) ─────────────────────────
// The panel sends one streamed request (gateway /api/bridges/stream, step 4c); the gateway searches each domain in
// parallel and streams progress and per-domain results. The browser holds no domain or type lists of its own.
export type BridgeProgressStatus = 'searching' | 'found' | 'none' | 'skipped' | 'error';
export type BridgeProgressItem = { id: string; name: string; status: BridgeProgressStatus; count: number };

export function bridgeDomainName(id: string, options: BridgeOptions | null | undefined): string {
    return options?.domains.find(d => d.id === id)?.display_name || id;
}

/** "Podcast: 3 found · Website: searching…" — skipped domains (not a target for this node) are left out. */
export function bridgeProgressText(items: BridgeProgressItem[]): string {
    const label: Record<BridgeProgressStatus, (i: BridgeProgressItem) => string> = {
        searching: () => 'searching…',
        found: i => `${i.count} found`,
        none: () => 'none',
        skipped: () => '',
        error: () => 'failed',
    };
    return items.filter(i => i.status !== 'skipped').map(i => `${i.name}: ${label[i.status](i)}`).join(' · ');
}

/** One chat summary from the per-domain results, in domain order; empty when no domain found a bridge. */
export function combineBridgeSummaries(parts: Array<{ name: string; summary?: string; found: boolean }>): string {
    return parts.filter(p => p.found && p.summary).map(p => `**${p.name}:** ${p.summary}`).join('\n\n');
}
