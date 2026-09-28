const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and configure it.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 15,
});

pool.on('error', (err) => console.error('[pg] idle client error', err.message));

// Return DATE columns as plain 'YYYY-MM-DD' strings (no timezone shifting)
require('pg').types.setTypeParser(1082, (v) => v);
// TIMESTAMP (no time zone) -> 'YYYY-MM-DDTHH:MM' wall-clock text (what <input type=datetime-local> uses; no timezone shifting)
require('pg').types.setTypeParser(1114, (v) => (v === null ? null : v.replace(' ', 'T').slice(0, 16)));
// NUMERIC -> JS number
require('pg').types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

async function query(text, params) {
  return pool.query(text, params);
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };
