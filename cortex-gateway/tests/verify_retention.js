'use strict';
/**
 * Retention purge (S2-50 build 2c; utils/retention.js) with a fake DB: the exact WHERE clauses — only hidden chats
 * past the window, only reviewed transfer groups, audit rows only when no transfer group points to them; windows
 * from config; dry run deletes nothing. Run: node tests/verify_retention.js (npm test).
 */
const assert = require('assert');
const { createRetention, HISTORY_DAYS, AUDIT_DAYS } = require('../utils/retention');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (c, m) => { assert.ok(c, m); passed++; };

(async () => {
    eq([HISTORY_DAYS, AUDIT_DAYS], [30, 365], 'windows from config (D1, D8)');
    const sql = [];
    const db = { async query(text, args) { sql.push([text.replace(/\s+/g, ' ').trim(), args]); return { rows: [{ n: 2 }], rowCount: 3 }; } };
    const r = createRetention({ db });
    eq(await r.plan(), { hidden_chats: 2, reviewed_transfers: 2, audit_rows: 2, windows: { history_retention_days: 30, audit_retention_days: 365 } }, 'plan counts');
    ok(sql.every(([t]) => t.startsWith('SELECT count(*)')), 'dry run only reads');
    sql.length = 0;
    eq((await r.purge()).hidden_chats, 3, 'purge counts');
    const [chats, transfers, audit] = sql;
    ok(chats[0].startsWith('DELETE FROM conversations') && chats[0].includes("status = 'deleted'") && chats[0].includes('deleted_at IS NOT NULL'), 'only hidden chats');
    eq(chats[1], [30], 'history window');
    ok(transfers[0].includes("status = 'reviewed'") && !transfers[0].includes('in_review'), 'only reviewed transfer groups');
    eq(transfers[1], [365], 'audit window');
    ok(audit[0].includes('NOT EXISTS (SELECT 1 FROM content_transfers'), 'audit row kept while a transfer group points to it');
    let threw = false; try { createRetention({ db, historyDays: 0 }); } catch (e) { threw = true; }
    ok(threw, 'a zero window is refused (would delete every hidden chat at once)');
    console.log(`verify_retention: ${passed} checks passed`);
})().catch(err => { console.error('verify_retention FAILED:', err.message); process.exit(1); });
