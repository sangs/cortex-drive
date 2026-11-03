'use strict';
/**
 * Unified shares phase 1 (2026-10-29): live graph-view links. Unit tests with fake db/permify/bento.
 * Live Permify behaviour (share_link subject, inheritance, exact revoke):
 * tests/integration/verify_share_links_permify_live.js. Run: node tests/verify_share_links.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createShareLinks, sha256, shareSecretProblem, MIN_SHARE_SECRET_LENGTH, LINK_TYPES, NOT_YOURS_ERROR,
        NOTHING_TO_SHARE_ERROR, NODE_LINK_ONE_NODE_ERROR, EVERYONE_VISIBLE_ERROR } = require('../utils/share_links');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const quiet = { log() {}, error() {} };
const LINK = '11111111-2222-3333-4444-555555555555';

function harness({ shareRoots, canShare = () => true, failWriteOn = null, rows = {} } = {}) {
    const calls = { writes: [], revokes: [], sql: [], del: [], nodesByIds: [] };
    const store = { ...rows };
    const db = {
        async query(sql, params) {
            calls.sql.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
            if (sql.startsWith('INSERT INTO share_links')) {
                store[LINK] = { link_id: LINK, token_nonce: params[0], root_node_ids: params[1], layout_node_ids: params[2],
                                title: params[3], owner_sub: params[4], org_id: params[5], expires_at: params[6],
                                link_type: params[7], revoked_at: null };
                return { rows: [{ link_id: LINK }] };
            }
            if (sql.startsWith('DELETE FROM share_links')) { delete store[params[0]]; return { rows: [] }; }
            if (sql.startsWith('SELECT * FROM share_links WHERE link_id')) return { rows: store[params[0]] ? [store[params[0]]] : [] };
            if (sql.startsWith('SELECT * FROM share_links WHERE legacy_token_hash')) {
                return { rows: Object.values(store).filter(r => r.legacy_token_hash === params[0]) };
            }
            if (sql.startsWith('SELECT link_id, root_node_ids')) {
                const r = store[params[0]];
                return { rows: r && r.owner_sub === params[1] && !r.revoked_at ? [r] : [] };
            }
            if (sql.startsWith('UPDATE share_links SET revoked_at')) { store[params[0]].revoked_at = new Date(); return { rows: [] }; }
            if (sql.startsWith('SELECT link_id, token_nonce, link_type')) {
                calls.listSql = sql;
                return { rows: Object.values(store).filter(r => r.owner_sub === params[0]
                                                              && (params[1] === null || r.root_node_ids.includes(params[1]))) };
            }
            return { rows: [] };
        },
    };
    const permify = {
        async shareNodeWithLink(node, link) { if (node === failWriteOn) throw new Error('permify down'); calls.writes.push([node, link]); },
        async revokeNodeLink(node, link) { calls.revokes.push([node, link]); },
        async checkPermission(node, user, perm) { assert.strictEqual(perm, 'can_share'); return canShare(node, user); },
    };
    const bento = {
        async shareRoots() { return shareRoots; },
        async nodesByIds(ids, tenant, principal) { calls.nodesByIds.push({ ids, tenant, principal }); return { nodes: [{ node_id: 'a' }], links: [] }; },
    };
    const redis = { async del(...k) { calls.del.push(...k); } };
    const links = createShareLinks({ db, permify, bento, redis, isOwner: u => u === 'owner', secret: 's3cret',
                                     frontendUrl: 'https://app.example', log: quiet });
    return { links, calls, store };
}
const ROOTS = { roots: ['a', 'c'], covered: ['b'], others: [], everyone: ['pub'], unknown: ['grouper-1'], total_nodes: 42 };

(async () => {
    // ── plan (root selection) ──────────────────────────────────────────────────────────────────
    {
        const { links } = harness({ shareRoots: ROOTS });
        const p = await links.plan({ nodeIds: ['a', 'b', 'c', 'pub', 'grouper-1'], userId: 'owner', tenantId: 'org' });
        eq(p.roots, ['a', 'c'], 'roots only (b is under a)');
        eq(p.dropped, { everyone: 1, display: 1 }, 'Public and display-only nodes dropped, not refused');
        eq(p.totalNodes, 42, 'total includes everything under the roots');
        eq(p.layoutNodeIds, ['a', 'c', 'b', 'pub'], 'layout keeps the real nodes on screen, Public ones included');
    }
    {
        const checked = [];
        const { links } = harness({ shareRoots: { ...ROOTS, others: ['c'] }, canShare: n => { checked.push(n); return false; } });
        const p = await links.plan({ nodeIds: [], userId: 'owner', tenantId: 'org' });
        eq([p.ok, p.status, p.error, p.denied], [false, 403, NOT_YOURS_ERROR, ['c']], 'owner: a node someone else added is refused, listed');
        eq(checked, ['c'], 'owner: only nodes added by others are checked in Permify');
    }
    {
        const checked = [];
        const { links } = harness({ shareRoots: ROOTS, canShare: n => { checked.push(n); return true; } });
        await links.plan({ nodeIds: [], userId: 'member', tenantId: 'org' });
        eq(checked.sort(), ['a', 'b', 'c'], 'member: every candidate needs Permify can_share');
    }
    {
        const { links } = harness({ shareRoots: { roots: [], covered: [], others: [], everyone: ['pub'], unknown: [], total_nodes: 0 } });
        const p = await links.plan({ nodeIds: ['pub'], userId: 'owner', tenantId: 'org' });
        eq([p.ok, p.roots, p.layoutNodeIds, p.dropped.everyone], [true, [], ['pub'], 1], 'only Public nodes: a link with no tuples that shows them live');
        const h2 = harness({ shareRoots: { roots: [], covered: [], others: [], everyone: [], unknown: ['grouper-1'], total_nodes: 0 } });
        const p2 = await h2.links.plan({ nodeIds: ['grouper-1'], userId: 'owner', tenantId: 'org' });
        eq([p2.status, p2.error], [409, NOTHING_TO_SHARE_ERROR], 'no real nodes at all: nothing to share (409)');
    }

    // ── create, token, view, list, revoke ─────────────────────────────────────────────────────
    let token;
    {
        const h = harness({ shareRoots: ROOTS });
        const r = await h.links.createGraphLink({ nodeIds: [], title: 'T', userId: 'owner', tenantId: 'org' });
        ok(r.ok && r.shareUrl.startsWith(`https://app.example/graph-view/${LINK}.`), 'URL carries a signed token');
        eq(h.calls.writes, [['a', LINK], ['c', LINK]], 'one Permify tuple per root, none for covered nodes');
        token = r.shareUrl.split('/graph-view/')[1];
        ok(!JSON.stringify(h.store).includes(token.split('.')[1]), 'the signature is not stored');

        ok(await h.links.resolveToken(token), 'valid token resolves');
        eq(await h.links.resolveToken(token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')), null, 'tampered token refused');
        eq(await h.links.resolveToken(`${LINK}.abc`), null, 'short signature refused');
        eq(await h.links.resolveToken('not-a-uuid.abc'), null, 'malformed id refused');

        const v = await h.links.viewGraphLink(token);
        eq(h.calls.nodesByIds[0], { ids: ['a', 'c', 'b', 'pub'], tenant: 'org', principal: `share_link:${LINK}` },
           'view reads the layout nodes live, as the link principal');
        ok(v.graph.nodes.length === 1, 'view returns the live graph');

        const list = await (async () => { h.store[LINK].status = 'active'; return [h.links.tokenFor(LINK, h.store[LINK].token_nonce)]; })();
        eq(list[0], token, 'the owner can re-derive the same URL later (nonce + secret)');

        eq(await h.links.revokeLink(LINK, 'someone-else'), false, 'only the owner revokes');
        eq(await h.links.revokeLink(LINK, 'owner'), true, 'owner revokes');
        eq(h.calls.revokes, [['a', LINK], ['c', LINK]], 'revoke exact-deletes each root tuple');
        eq(h.calls.del, [`perm:share_link:${LINK}`], "revoke drops the link's cached allowlist");
        eq(await h.links.resolveToken(token), null, 'revoked link no longer opens');
    }
    {
        const h = harness({ shareRoots: ROOTS, failWriteOn: 'c' });
        await assert.rejects(h.links.createGraphLink({ nodeIds: [], userId: 'owner', tenantId: 'org' }));
        eq(h.calls.revokes, [['a', LINK]], 'Permify failure rolls back the tuples already written');
        eq(h.store[LINK], undefined, 'and deletes the row');
        passed++;
    }
    {
        const past = new Date(Date.now() - 1000);
        const h = harness({ rows: { [LINK]: { link_id: LINK, token_nonce: 'n', expires_at: past, revoked_at: null, root_node_ids: ['a'] } } });
        eq(await h.links.resolveToken(h.links.tokenFor(LINK, 'n')), null, 'expired link refused');
    }
    {
        const h = harness({ rows: { x: { link_id: 'x', token_nonce: 'n', legacy_token_hash: sha256('oldtoken'), revoked_at: null } } });
        ok(await h.links.resolveToken('oldtoken'), 'migrated legacy token still opens (matched by hash)');
        eq(await h.links.resolveToken('othertoken'), null, 'unknown legacy token refused');
    }
    {
        const links = createShareLinks({ db: {}, permify: {}, bento: { async shareRoots() { return ROOTS; } }, redis: {},
                                         isOwner: () => true, secret: '', frontendUrl: 'x', log: quiet });
        await assert.rejects(links.createGraphLink({ nodeIds: [], userId: 'owner', tenantId: 'org' }), /not configured/,
                             'no secret: refuses (no in-code default, AP-24)');
        passed++;
    }

    // ── node links (design §7b-1, 2026-11-02) ─────────────────────────────────────────────────
    {
        const h = harness({ shareRoots: { roots: ['n1'], covered: [], others: [], everyone: [], unknown: [], total_nodes: 7 } });
        const r = await h.links.createGraphLink({ nodeIds: ['n1'], title: 'BERT', userId: 'member', tenantId: 'org', linkType: LINK_TYPES.NODE });
        ok(r.ok && r.plan.totalNodes === 7, 'node link created; preview total includes what the node contains');
        eq(h.store[LINK].link_type, 'node', "stored as link_type 'node'");
        eq(h.calls.writes, [['n1', LINK]], 'one Permify tuple on the node (contents inherit through parent)');
        const g = await h.links.createGraphLink({ nodeIds: [], userId: 'owner', tenantId: 'org' });
        eq(h.store[LINK].link_type, 'graph', "default link type is still 'graph'");
        ok(g.ok, 'graph link unchanged');

        const both = harness({ shareRoots: ROOTS });
        eq((await both.links.createGraphLink({ nodeIds: ['a', 'c'], userId: 'owner', tenantId: 'org', linkType: 'node' })).error,
           NODE_LINK_ONE_NODE_ERROR, 'a node link names exactly one node');
        eq((await both.links.createGraphLink({ nodeIds: ['a'], userId: 'owner', tenantId: 'org', linkType: 'island' })).status,
           400, 'unknown link type refused');
        const pub = harness({ shareRoots: { roots: [], covered: [], others: [], everyone: ['pub'], unknown: [], total_nodes: 0 } });
        const rp = await pub.links.createGraphLink({ nodeIds: ['pub'], userId: 'owner', tenantId: 'org', linkType: 'node' });
        eq([rp.status, rp.error, rp.everyone_visible, pub.store[LINK]], [409, EVERYONE_VISIBLE_ERROR, true, undefined],
           'Public/built-in node: no node link (409), nothing written');
        const denied = harness({ shareRoots: { roots: ['n1'], covered: [], others: [], everyone: [], unknown: [], total_nodes: 1 }, canShare: () => false });
        eq((await denied.links.createGraphLink({ nodeIds: ['n1'], userId: 'member', tenantId: 'org', linkType: 'node' })).status,
           403, "someone else's node: refused (Permify can_share)");

        const l = harness({ rows: {
            x: { link_id: 'x', token_nonce: 'n', owner_sub: 'me', root_node_ids: ['n1'] },
            y: { link_id: 'y', token_nonce: 'n', owner_sub: 'me', root_node_ids: ['n2', 'n1'] },
            z: { link_id: 'z', token_nonce: 'n', owner_sub: 'me', root_node_ids: ['n3'] },
            w: { link_id: 'w', token_nonce: 'n', owner_sub: 'other', root_node_ids: ['n1'] },
        } });
        eq((await l.links.listLinks('me', { nodeId: 'n1' })).map(r => r.link_id), ['x', 'y'], "per-node list: the caller's links with that node as a root");
        eq((await l.links.listLinks('me')).map(r => r.link_id), ['x', 'y', 'z'], 'without nodeId: all of the caller\'s links');
        ok(/\$2::text IS NULL OR \$2 = ANY\(root_node_ids\)/.test(l.calls.listSql), 'the node filter is in SQL (AP-2: $2 is used)');
    }

    // ── secret (GL-4/S2-72, AP-24) ───────────────────────────────────────────────────────────────
    {
        ok(shareSecretProblem(undefined), 'unset secret is a problem');
        ok(shareSecretProblem(''), 'empty secret is a problem');
        ok(shareSecretProblem('x'.repeat(MIN_SHARE_SECRET_LENGTH - 1)), 'short secret is a problem');
        eq(shareSecretProblem('x'.repeat(MIN_SHARE_SECRET_LENGTH)), null, `${MIN_SHARE_SECRET_LENGTH}-char secret is fine`);
    }

    // ── wiring ────────────────────────────────────────────────────────────────────────────────
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    ok(!/(INSERT INTO|FROM|UPDATE) graph_share_links/.test(src), 'index.js no longer reads or writes stored graph copies');
    ok(/app\.post\('\/api\/share\/graph-link', authMiddleware, requireCapability\('share'/.test(src), 'creating a link needs the share capability');
    ok(/app\.post\('\/api\/share\/graph-link\/preview', authMiddleware, requireCapability\('share'/.test(src), 'preview needs it too');
    ok(/'x-user-id': shareLinks\.linkPrincipal\(link\.link_id\)/.test(src), "link node details use the link's permissions");
    ok(/secret: process\.env\.GATEWAY_SHARE_SECRET \|\| ''/.test(src), 'link secret has no in-code default');
    ok(!/cortex_default_fallback_secret/.test(src), 'index.js has no default share secret');
    ok(!/GATEWAY_SHARE_SECRET\s*\|\|\s*['"][^'"]+['"]/.test(src), 'no non-empty fallback for GATEWAY_SHARE_SECRET');
    const startup = src.slice(src.indexOf('shareSecretProblem(process.env.GATEWAY_SHARE_SECRET)'));
    ok(/NODE_ENV === 'production'[\s\S]{0,200}process\.exit\(1\)/.test(startup.slice(0, 600)),
       'production refuses to start without a usable secret');
    // The old node link (HMAC token in Redis, /discovery?share=) is gone (design §7b-1, 2026-11-02).
    ok(!fs.existsSync(path.join(__dirname, '..', 'utils', 'share_tokens.js')), 'utils/share_tokens.js removed');
    for (const re of [/app\.get\('\/api\/share',/, /\/api\/share\/links\//, /\/api\/share\/revoke-link/, /\/api\/share\/preview/,
                      /guestTokenMiddleware/, /\/discovery\?share=/]) {
        ok(!re.test(src), `old node-link code removed: ${re}`);
    }
    ok(/'x-guest-share-anchor'/.test(src.slice(src.indexOf('const GATEWAY_ASSIGNED_HEADERS'))), 'x-guest-share-anchor stays gateway-assigned (a client can never send it)');
    ok(/req\.guestAuth === true/.test(src), 'dormant guest enforcement kept for phase 4');
    ok(/listLinks\(req\.headers\['x-user-id'\], \{ nodeId: req\.query\.nodeId \|\| null \}\)/.test(src), 'GET /api/share/graph-links takes ?nodeId=');
    ok(/createGraphLink\(\{ \.\.\.graphLinkRequest\(req\), title, expiresAt, linkType \}\)/.test(src), 'POST /api/share/graph-link passes linkType');
    ok(/focusNodeId: r\.link\.root_node_ids\[0\]/.test(src), 'a node link page opens on its node');
    // Production sets BENTO_SERVER_URL only; BENTO_URL fell back to localhost (S2-77, 2026-11-02).
    ok(!/process\.env\.BENTO_URL\b/.test(src), 'every Bento call reads BENTO_SERVER_URL');
    // Bento is IAM-locked: a call without the Cloud Run ID token gets 403 (AP-18, S2-77).
    const lines = src.split('\n');
    const bentoCalls = lines.map((l, i) => i).filter(i => /fetch(WithColdStartRetry)?\(`\$\{(bento|bentoBase|bentoUrl|bentoServerUrl)\}/.test(lines[i]));
    const untokened = bentoCalls.filter(i => !lines.slice(Math.max(0, i - 6), i + 1).some(l => /getCloudRunToken\(/.test(l)));
    ok(bentoCalls.length >= 9 && untokened.length === 0,
       `every Bento fetch gets a Cloud Run ID token first (${bentoCalls.length} calls, missing at lines ${untokened.map(i => i + 1).join(', ') || 'none'})`);
    const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'permify', 'authorization_schema.perm'), 'utf8');
    ok(/entity share_link \{\}/.test(schema) && /shared_viewer\s+@user @group#member @agent @share_link/.test(schema),
       'Permify schema: share_link is a shared_viewer subject');

    console.log(`verify_share_links: ${passed} checks passed`);
})().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
