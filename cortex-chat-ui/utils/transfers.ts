/**
 * "Transferred to you" payloads (S2-50 §3b; gateway utils/transfers.js). Validated before display; anything
 * malformed is dropped rather than shown.
 */
export type Transfer = {
    transferId: string; fromName: string; createdAt: string; status: 'in_review' | 'reviewed';
    nodes: number; sharesKept: number; hiddenChats: number; hiddenChatsPurgeOn: string | null; reminder: boolean;
};
export type TransferSource = { nodeId: string; name: string; type: string; nodes: number };
export type TransferItems = { sources: TransferSource[]; otherNodes: number; totalNodes: number };

const int = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function readTransfers(value: unknown): Transfer[] {
    if (!Array.isArray(value)) return [];
    return value.filter(t => t && typeof t === 'object' && str(t.transferId) && str(t.fromName)).map(t => ({
        transferId: t.transferId,
        fromName: t.fromName,
        createdAt: str(t.createdAt),
        status: t.status === 'reviewed' ? 'reviewed' : 'in_review',
        nodes: int(t.nodes),
        sharesKept: int(t.sharesKept),
        hiddenChats: int(t.hiddenChats),
        hiddenChatsPurgeOn: /^\d{4}-\d{2}-\d{2}$/.test(str(t.hiddenChatsPurgeOn)) ? t.hiddenChatsPurgeOn : null,
        reminder: t.reminder === true,
    }));
}

export function readTransferItems(value: unknown): TransferItems | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as { sources?: unknown; other_nodes?: unknown; total_nodes?: unknown };
    const sources = Array.isArray(v.sources) ? v.sources : [];
    return {
        sources: sources.filter(s => s && str(s.node_id)).map(s => ({ nodeId: s.node_id, name: str(s.name) || s.node_id, type: str(s.type), nodes: int(s.nodes) })),
        otherNodes: int(v.other_nodes),
        totalNodes: int(v.total_nodes),
    };
}

/** "Transferred from <name> on <date>" for the node panel, from the node's own fields (owner only). */
export function transferredLabel(node: { transferred_from_name?: unknown; transferred_at?: unknown } | null): string | null {
    const name = node ? str(node.transferred_from_name) : '';
    if (!name) return null;
    const at = node ? str(node.transferred_at).slice(0, 10) : '';
    return /^\d{4}-\d{2}-\d{2}$/.test(at) ? `Transferred from ${name} on ${at}` : `Transferred from ${name}`;
}

/** "Open in graph" link to the dashboard for a transfer (and optionally one source). */
export function transferGraphHref(transferId: string, sourceId?: string): string {
    const q = new URLSearchParams({ transfer: transferId, ...(sourceId ? { source: sourceId } : {}) });
    return `/dashboard?${q.toString()}`;
}

/** The dashboard's ?transfer=…&source=… (validated), or null. */
export function readTransferParams(search: string): { transferId: string; sourceId: string | null } | null {
    const q = new URLSearchParams(search || '');
    const transferId = q.get('transfer') || '';
    if (!/^[0-9a-f-]{36}$/i.test(transferId)) return null;
    const source = q.get('source');
    return { transferId, sourceId: source && /^[A-Za-z0-9_-]{1,80}$/.test(source) ? source : null };
}

/** The line shown in the chat when the group is drawn (fixed text, not an AI answer). */
export function transferOpenedNote(data: { fromName?: unknown; nodes?: unknown[] }): string {
    const n = Array.isArray(data?.nodes) ? data.nodes.length : 0;
    const who = typeof data?.fromName === 'string' && data.fromName ? data.fromName : 'a former member';
    if (!n) return `Nothing from ${who} is left in review.`;
    return `Showing ${n} item${n === 1 ? '' : 's'} transferred from ${who}. Click an item to read it. ` +
        'They stay out of your chat answers until you keep them (Settings → Sharing & Access → Transferred to you).';
}
