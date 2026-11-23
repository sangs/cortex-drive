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
