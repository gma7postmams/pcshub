// Security rules an Admin can change in the app (Admin > Security). Stored in app_settings; read from memory on every
// request, so a change applies at once with no restart. The .env values (SESSION_HOURS, SESSION_MAX_HOURS) are only the defaults.
const db = require('./db');

const env = (v, def) => (Number.isFinite(parseInt(v, 10)) && parseInt(v, 10) > 0 ? parseInt(v, 10) : def);

// key in app_settings, field name, default, allowed range (the floor stops anyone setting a rule too weak to be safe)
const FIELDS = {
  minPasswordLength: { key: 'sec_min_password', def: 8, min: 8, max: 64 },
  lockAfterFailures: { key: 'sec_lock_after', def: 5, min: 3, max: 20 },
  lockMinutes: { key: 'sec_lock_minutes', def: 15, min: 1, max: 1440 },
  idleSignOutHours: { key: 'sec_idle_hours', def: env(process.env.SESSION_HOURS, 12), min: 1, max: 72 },
  maxSessionHours: { key: 'sec_max_hours', def: env(process.env.SESSION_MAX_HOURS, 168), min: 1, max: 720 },
};
const ADMIN_2FA_KEY = 'sec_admin_2fa';

let cur = null;
const defaults = () => ({
  ...Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.def])), requireAdmin2fa: false,
});

function normalise(raw) {
  const out = defaults();
  for (const [k, f] of Object.entries(FIELDS)) {
    const n = parseInt(raw[f.key], 10);
    if (Number.isFinite(n) && n >= f.min && n <= f.max) out[k] = n;
  }
  out.requireAdmin2fa = raw[ADMIN_2FA_KEY] === '1';
  if (out.maxSessionHours < out.idleSignOutHours) out.maxSessionHours = out.idleSignOutHours;
  return out;
}

async function load() {
  const keys = [...Object.values(FIELDS).map((f) => f.key), ADMIN_2FA_KEY];
  const { rows } = await db.query('SELECT key, value FROM app_settings WHERE key = ANY($1)', [keys]);
  cur = normalise(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  return cur;
}

/** Current rules (defaults until load() has run, e.g. in unit tests). */
const get = () => cur || defaults();

async function save(next, client = db) {
  const rows = [...Object.entries(FIELDS).map(([k, f]) => [f.key, String(next[k])]), [ADMIN_2FA_KEY, next.requireAdmin2fa ? '1' : '0']];
  for (const [key, value] of rows) {
    await client.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, value]
    );
  }
}
const apply = (next) => { cur = normalise({ ...Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [f.key, next[k]])), [ADMIN_2FA_KEY]: next.requireAdmin2fa ? '1' : '0' }); return cur; };

const idleMs = () => get().idleSignOutHours * 3600 * 1000;
const maxMs = () => Math.max(get().maxSessionHours, get().idleSignOutHours) * 3600 * 1000;

module.exports = { FIELDS, get, load, save, apply, defaults, idleMs, maxMs };
