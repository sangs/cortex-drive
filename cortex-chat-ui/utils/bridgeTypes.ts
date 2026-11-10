// Bridge target domains as returned by the list_bridge_domains MCP tool
// (bridge-discovery-and-bento-panel-design-2026-11-03.md §1). The server owns the list.
export type BridgeDomainOption = { id: string; display_name: string; has_visible_content: boolean };
export type BridgeOptions = { auto: string; domains: BridgeDomainOption[] };

// ── Bridge progress (cross-domain discovery design 2026-11-09 §4.3, Phase 1b) ─────────────────────────
// The panel runs one connect_knowledge_on_demand call per offered domain in parallel (domain_filter), so
// each domain's bridges appear as soon as that domain is done. The server still resolves "auto" from the
// node's labels and answers "skipped" for a domain that is not a target for this node; the browser holds
// no domain or type lists of its own.
export type BridgeProgressStatus = 'searching' | 'found' | 'none' | 'skipped' | 'error';
export type BridgeProgressItem = { id: string; name: string; status: BridgeProgressStatus; count: number };

/** Domains to query, one call each. "auto" → every offered domain the viewer can see something in (the
 *  server skips the node's own). Named chips → those. No options yet → [] (one call without a filter). */
export function bridgeCallDomains(targetDomains: string[], options: BridgeOptions | null | undefined): string[] {
    if (!options || !options.domains.length) return [];
    const offered = options.domains.filter(d => d.has_visible_content).map(d => d.id);
    const wantsAuto = targetDomains.includes(options.auto);
    const named = targetDomains.filter(d => d !== options.auto && options.domains.some(o => o.id === d));
    return Array.from(new Set(wantsAuto ? [...offered, ...named] : named));
}

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
