const validator = require('validator');
const { HttpError } = require('./middleware');

function str(v, { field, max = 500, required = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, `${field} must be text`);
  const s = String(v).trim();
  if (required && !s) throw new HttpError(400, `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return s || null;
}

function date(v, { field, required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  const s = String(v).trim();
  if (!validator.isDate(s, { format: 'YYYY-MM-DD', strictMode: true })) {
    throw new HttpError(400, `${field} must be a valid date (YYYY-MM-DD)`);
  }
  return s;
}

// PostgreSQL integer columns are 32-bit: anything larger must be refused here, otherwise the database raises an
// error and the caller gets a 500 instead of a clean 400/404.
const PG_INT_MAX = 2147483647;

function int(v, { field, required = false, min = -PG_INT_MAX, max = PG_INT_MAX } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, `${field} must be an integer`);
  const s = String(v);
  if (!validator.isInt(s, { min, max })) throw new HttpError(400, `${field} must be an integer`);
  return parseInt(s, 10);
}

function num(v, { field, min = 0, max = 99999 } = {}) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!validator.isFloat(s, { min, max })) throw new HttpError(400, `${field} must be a number between ${min} and ${max}`);
  return Math.round(parseFloat(s) * 100) / 100;
}

function oneOf(v, list, { field, def } = {}) {
  if ((v === undefined || v === null || v === '') && def !== undefined) return def;
  if (!list.includes(v)) throw new HttpError(400, `${field} must be one of: ${list.join(', ')}`);
  return v;
}

// Small deny-list of the most common passwords (full breach-list checks belong in a future upgrade)
const COMMON = new Set(['password', 'password1', 'password123', 'passw0rd', '123456789', '1234567890', 'qwerty123',
  'qwertyuiop', 'iloveyou1', 'welcome1', 'welcome123', 'admin123', 'administrator', 'letmein123', 'changeme',
  'changeme123', 'abc123456', 'football1', 'monkey123', 'sunshine1', 'princess1', 'dragon123', 'baseball1', 'p@ssw0rd']);

/**
 * Password policy: 8+ chars, letters and numbers, max 72 bytes (bcrypt limit — longer input is silently
 * truncated by bcrypt), not a common password, must not contain the username.
 */
// Minimum length is an Admin setting (Admin > Security); 8 until it has loaded.
const minLen = () => require('./security-settings').get().minPasswordLength;

function password(v, { username, fullName } = {}) {
  if (typeof v !== 'string' || v.length < minLen()) throw new HttpError(400, `Password must be at least ${minLen()} characters`);
  if (Buffer.byteLength(v, 'utf8') > 72) throw new HttpError(400, 'Password must be at most 72 bytes');
  if (!/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) throw new HttpError(400, 'Password must contain letters and numbers');
  const lc = v.toLowerCase();
  if (COMMON.has(lc)) throw new HttpError(400, 'That password is too common');
  if (username && username.length >= 3 && lc.includes(username.toLowerCase())) throw new HttpError(400, 'Password must not contain your username');
  if (fullName) {
    for (const part of String(fullName).toLowerCase().split(/\s+/)) {
      if (part.length >= 4 && lc.includes(part)) throw new HttpError(400, 'Password must not contain your name');
    }
  }
  return v;
}

function id(v) {
  if ((typeof v !== 'string' && typeof v !== 'number') || !/^[1-9][0-9]{0,9}$/.test(String(v)) || Number(v) > PG_INT_MAX) {
    throw new HttpError(400, 'Invalid id');
  }
  return Number(v);
}

/** Paging from the query string. Never negative, never above `max` (a negative LIMIT/OFFSET is a database error). */
function paging(q, { def = 50, max = 200 } = {}) {
  const n = (x, fallback) => {
    const i = parseInt(Array.isArray(x) ? x[0] : x, 10);
    return Number.isFinite(i) && i >= 0 ? i : fallback;
  };
  return { limit: Math.min(Math.max(n(q.limit, def), 1), max), offset: Math.min(n(q.offset, 0), PG_INT_MAX) };
}

/** A user-typed search term as an ILIKE pattern: capped in length, wildcards escaped so % and _ match literally. */
function like(v, max = 100) {
  return `%${String(Array.isArray(v) ? v[0] : v).trim().slice(0, max).replace(/[%_\\]/g, '\\$&')}%`;
}

module.exports = { str, date, int, num, oneOf, password, id, paging, like, PG_INT_MAX };
