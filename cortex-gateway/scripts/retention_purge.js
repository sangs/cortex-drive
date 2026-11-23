'use strict';
/**
 * Daily retention purge (S2-50 build 2c): utils/retention.js.
 *   node scripts/retention_purge.js           dry run: counts only
 *   node scripts/retention_purge.js --apply   delete
 * Run by the daily maintenance job (scripts/deploy-maintenance-job.sh) before the orphan sweep; on demand otherwise.
 * Env: DB_* (Cloud SQL Auth Proxy locally) or CLOUD_SQL_INSTANCE (Cloud Run). Prints counts only. Exit 1 on error.
 */
const db = require('../utils/db');
const { createRetention } = require('../utils/retention');

(async () => {
    const apply = process.argv.includes('--apply');
    const retention = createRetention({ db });
    const r = apply ? await retention.purge() : await retention.plan();
    console.log(`[RETENTION] ${apply ? 'deleted' : 'would delete (dry run)'}: hidden chats ${r.hidden_chats}, ` +
                `reviewed transfer groups ${r.reviewed_transfers}, audit rows ${r.audit_rows} ` +
                `(windows ${r.windows.history_retention_days} / ${r.windows.audit_retention_days} days)`);
})().then(() => process.exit(0)).catch(err => { console.error('[RETENTION] FAILED:', err.message); process.exit(1); });
