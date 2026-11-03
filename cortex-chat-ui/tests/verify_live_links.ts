/**
 * Unified shares phase 1 (2026-10-29): graph-view links are live. The Share dialog sends node ids
 * only (never graph data), previews what will be shared before creating the link, and the link page
 * reads node details through the link's permissions. Source checks; behaviour is tested in the gateway
 * (verify_share_links.js) and against Permify/Neo4j. Run: `npm test`.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

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

// Node links (design §7b-1, 2026-11-02): the Bento panel's Link tab makes a live link with one root;
// the old HMAC node link and its /discovery page are gone.
const share = read('components/ShareModal.tsx');
ok(/linkType: 'node'/.test(share) && /nodeIds: \[nodeId\]/.test(share), 'the Link tab creates a live node link for this node');
ok(/onClick=\{linkPreview \? generateLink : previewLink\}/.test(share), 'the node link is created only after the preview is shown');
ok(/This node and \$\{linkPreview\.totalNodes - 1\}/.test(share), 'the preview says "This node and N items it contains"');
ok(/\/api\/share\/graph-links\?nodeId=/.test(share), "the tab lists this node's links");
ok(/\/api\/share\/graph-link\/\$\{encodeURIComponent\(link\.link_id\)\}`, \{ method: 'DELETE'/.test(share), 'revoke uses the live-link route');
ok(!/\/api\/share\?nodeId=|\/api\/share\/links\/|revoke-link|\/discovery/.test(share), 'no old node-link calls left');
ok(/if \(!resp\.ok\) \{ setShareError/.test(share) && /if \(!resp\.ok\) \{ setGroupShareError/.test(share),
   'person and group shares check the response (S2-77 follow-up)');
ok(/focusNodeId/.test(page) && /handleNodeClick\(focus\)/.test(page), 'a node link opens on its node with the panel');
ok(!existsSync(new URL('../app/discovery', import.meta.url)), 'the /discovery page is removed');
ok(!/\/discovery/.test(read('proxy.ts')), '/discovery is no longer a public route');

console.log(`verify_live_links: ${passed} checks passed`);
