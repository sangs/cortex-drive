'use strict';
/**
 * Cloud SQL connection pool for the cortexdrive_app database.
 *
 * Used for share_grants table operations. The authorization tuple store lives in
 * Permify's own PostgreSQL database on the same Cloud SQL instance — this pool
 * connects to the application database only.
 *
 * Env vars:
 *   CLOUD_SQL_INSTANCE  — instance connection name (project:region:instance)
 *   DB_NAME             — database name (default: cortexdrive_app)
 *   DB_USER             — postgres user
 *   DB_PASSWORD         — postgres password
 *   DB_HOST             — used instead of Cloud SQL connector when set (local dev)
 *   DB_PORT             — postgres port (default: 5432, local dev only)
 */

const { Pool } = require('pg');

let _pool = null;

async function getPool() {
  if (_pool) return _pool;

  const instanceConnectionName = process.env.CLOUD_SQL_INSTANCE;
  const dbName   = process.env.DB_NAME     || 'cortexdrive_app';
  const dbUser   = process.env.DB_USER     || 'postgres';
  const dbPass   = process.env.DB_PASSWORD || '';
  const dbHost   = process.env.DB_HOST;    // set for local dev only
  const dbPort   = parseInt(process.env.DB_PORT || '5432', 10);

  if (dbHost) {
    // Local development — direct TCP connection
    _pool = new Pool({
      host:     dbHost,
      port:     dbPort,
      database: dbName,
      user:     dbUser,
      password: dbPass,
    });
  } else if (instanceConnectionName) {
    // Cloud Run — connect via the Unix socket created by the Cloud Run sidecar
    // (enabled by --add-cloudsql-instances in build-deploy-gateway.sh).
    // Do NOT use @google-cloud/cloud-sql-connector here — it requires either a
    // private IP (which this instance does not have) or Cloud Run's built-in
    // socket is the correct path anyway.
    _pool = new Pool({
      host:     `/cloudsql/${instanceConnectionName}`,
      database: dbName,
      user:     dbUser,
      password: dbPass,
      max:      5,
    });
  } else {
    throw new Error('Neither DB_HOST nor CLOUD_SQL_INSTANCE is set — cannot connect to Cloud SQL');
  }

  _pool.on('error', (err) => {
    console.error('[db] Unexpected pool error', err.message);
  });

  return _pool;
}

/**
 * Execute a parameterized query against cortexdrive_app.
 * @param {string} text   — SQL with $1, $2, ... placeholders
 * @param {Array}  values — parameter array
 */
async function query(text, values = []) {
  const pool = await getPool();
  return pool.query(text, values);
}

module.exports = { query };
