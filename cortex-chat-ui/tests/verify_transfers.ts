/**
 * "Transferred to you" (S2-50 §3b). Run: `npm test`.
 * - payloads validated; malformed rows dropped; the node panel label comes only from the node's own fields;
 * - the screen confirms inline before any permanent delete, sends confirm:true, and shows nothing when empty;
 * - it sits on Sharing & Access; the node panel points there.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readTransferItems, readTransferParams, readTransfers, transferGraphHref, transferOpenedNote, transferredLabel } from '../utils/transfers.ts';

let passed = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); passed++; };
const eq = (a: unknown, b: unknown, m: string) => { assert.deepEqual(a, b, m); passed++; };

const t = readTransfers([
    { transferId: 'a', fromName: 'Ada L', createdAt: '2026-11-20T10:00:00Z', status: 'in_review', nodes: 3, sharesKept: 1, hiddenChats: 2, hiddenChatsPurgeOn: '2026-12-20', reminder: false },
    { transferId: '', fromName: 'x' }, null, { transferId: 'b', fromName: 'Bo', status: 'weird', nodes: -4, hiddenChatsPurgeOn: 'soon' },
]);
eq(t.length, 2, 'malformed rows dropped');
eq([t[1].status, t[1].nodes, t[1].hiddenChatsPurgeOn], ['in_review', 0, null], 'unknown values made safe');
eq(readTransfers({}), [], 'not a list → none');
eq(readTransferItems({ sources: [{ node_id: 's1', name: 'Site', type: 'WebsiteSource', nodes: 4 }, { name: 'no id' }], other_nodes: 1, total_nodes: 5 }),
   { sources: [{ nodeId: 's1', name: 'Site', type: 'WebsiteSource', nodes: 4 }], otherNodes: 1, totalNodes: 5 }, 'items');
eq(transferredLabel({ transferred_from_name: 'Ada L', transferred_at: '2026-11-20T21:00:00Z' }), 'Transferred from Ada L on 2026-11-20', 'panel label');
eq(transferredLabel({}), null, 'own content: no label');

const T = '11111111-1111-1111-1111-111111111111';
eq(transferGraphHref(T, 's1'), `/dashboard?transfer=${T}&source=s1`, 'Open in graph link');
eq(readTransferParams(`?transfer=${T}&source=s1`), { transferId: T, sourceId: 's1' }, 'link read back');
eq(readTransferParams('?transfer=../../x'), null, 'malformed transfer id ignored');
eq(readTransferParams(`?transfer=${T}&source=<script>`), { transferId: T, sourceId: null }, 'malformed source ignored');
ok(transferOpenedNote({ fromName: 'Ada L', nodes: [1, 2] }).startsWith('Showing 2 items transferred from Ada L.'), 'note');
eq(transferOpenedNote({ fromName: 'Ada L', nodes: [] }), 'Nothing from Ada L is left in review.', 'empty note');
const dash = readFileSync(new URL('../app/dashboard/page.tsx', import.meta.url), 'utf8');
ok(dash.includes('/api/transfers/${encodeURIComponent(q.transferId)}/graph') && dash.includes("window.history.replaceState(null, '', '/dashboard')"), 'dashboard opens the group once and clears the link');

const comp = readFileSync(new URL('../components/TransferredToYou.tsx', import.meta.url), 'utf8');
ok(comp.includes('if (!transfers || transfers.length === 0) return null;'), 'nothing shown without transfers');
ok((comp.match(/transferGraphHref\(/g) || []).length === 2, 'Open in graph on the card and on each source');
ok(comp.includes('role="alertdialog"') && comp.includes('This cannot be undone.'), 'inline confirmation for permanent actions');
ok(/delete`, \{ source_ids: confirm\.sourceIds, confirm: true \}/.test(comp), 'delete sends the chosen source and confirm');
ok(comp.includes('purge-history`, { confirm: true }'), 'purge sends confirm');
ok(!/window\.confirm|alert\(/.test(comp), 'no browser dialogs');
const page = readFileSync(new URL('../app/settings/sharing/page.tsx', import.meta.url), 'utf8');
ok(page.includes('<TransferredToYou />'), 'on Sharing & Access');
const panel = readFileSync(new URL('../components/BentoDetailPanel.tsx', import.meta.url), 'utf8');
ok(panel.includes('transferredLabel(node)'), 'node panel label');

console.log(`verify_transfers: ${passed} checks passed`);
