/**
 * Unified shares phase 1 (2026-10-29): graph-view links are live. The Share dialog sends node ids
 * only (never graph data), previews what will be shared before creating the link, and the link page
 * reads node details through the link's permissions. Source checks; behaviour is tested in the gateway
 * (verify_share_links.js) and against Permify/Neo4j. Run: `npm test`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0;
const ok = (cond: unknown, msg: string) => { assert.ok(cond, msg); passed++; };
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const modal = read('components/GraphShareModal.tsx');
ok(!/graphData:\s*\{\s*nodes:\s*cleanNodes/.test(modal) && !/cleanNodes/.test(modal), 'the dialog no longer sends a copy of the graph');
ok(/\/api\/share\/graph-link\/preview/.test(modal), 'the dialog previews the share first');
ok(/onClick=\{linkPreview \? generateLink : previewLink\}/.test(modal), 'the link is created only after the preview is shown');
ok(/in total, including everything under them/.test(modal), 'the preview says that everything under the shared items is included');
ok(!/snapshot is frozen/.test(modal), 'no "frozen snapshot" wording');

const page = read('app/graph-view/[token]/page.tsx');
ok(/\/api\/share\/graph-link\/\$\{params\.token\}\/node_details/.test(page), "node details go through the link's permissions");
ok(!/\/api\/get_node_details/.test(page), "the link page never uses the viewer's own node-details access");
ok(!/Authorization: `Bearer/.test(page), 'the link page sends no sign-in token');

console.log(`verify_live_links: ${passed} checks passed`);
