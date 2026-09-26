const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const validator = require('validator');

async function migrate(db) {
  await upgradeV1(db);
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(sql);
  await require('./totp').migrateSecrets(db);
  await seedAdmin(db);
}

/**
 * v1 stored Admin/Manager/Editor/Viewer in users.group_name referencing a `groups(name)` table.
 * Those are ROLES. Move them to users.role -> roles(name) and free the `groups` name
 * for real (Admin-defined) groups. Runs once; no-op on fresh or already-upgraded DBs.
 */
async function upgradeV1(db) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'group_name'`
  );
  if (!rows.length) return;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS roles (name TEXT PRIMARY KEY, description TEXT, rank INT NOT NULL DEFAULT 0)`);
    await client.query(`INSERT INTO roles (name, rank) VALUES ('Admin',4),('Manager',3),('Editor',2),('Viewer',1) ON CONFLICT DO NOTHING`);
    await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_group_name_fkey`);
    await client.query(`ALTER TABLE users RENAME COLUMN group_name TO role`);
    await client.query(`ALTER TABLE users ADD CONSTRAINT users_role_fkey FOREIGN KEY (role) REFERENCES roles(name) ON UPDATE CASCADE`);
    await client.query(`DROP TABLE IF EXISTS groups`);
    await client.query('COMMIT');
    console.log('[migrate] v1 upgrade: users.group_name -> users.role; groups table recreated for enrolment groups.');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function seedAdmin(db) {
  const username = (process.env.ADMIN_USERNAME || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!username || !password) {
    const { rows } = await db.query(`SELECT 1 FROM users WHERE role='Admin' LIMIT 1`);
    if (!rows.length) console.warn('[seed] No Admin exists and ADMIN_USERNAME/ADMIN_PASSWORD not set.');
    return;
  }
  const { rows } = await db.query('SELECT id FROM users WHERE lower(username)=lower($1)', [username]);
  if (rows.length) return;
  if (password.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters');
  const email = process.env.ADMIN_EMAIL && validator.isEmail(process.env.ADMIN_EMAIL) ? process.env.ADMIN_EMAIL : null;
  const hash = await bcrypt.hash(password, 12);
  await db.query(
    `INSERT INTO users (username, full_name, email, password_hash, role, must_change_password)
     VALUES ($1,$2,$3,$4,'Admin',TRUE)`,
    [username, process.env.ADMIN_FULLNAME || 'System Administrator', email, hash]
  );
  console.log(`[seed] Admin user "${username}" created (password change required on first login).`);
}

module.exports = { migrate };

if (require.main === module) {
  require('dotenv').config();
  const db = require('./db');
  migrate(db)
    .then(() => { console.log('Migration complete.'); return db.pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
