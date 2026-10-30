// IP access rules: a block list (these addresses cannot reach the app) and an allow list (these addresses are never shut out by wrong
// passwords or rate limits; an allow rule wins over a block rule). Managed in Administration > IP Access (System Admin), by hand or by CSV / JSON.
//
// Rules are kept in memory (single Node process) and reloaded after every change. An entry is one address or a range:
//   203.0.113.7    203.0.113.0/24    2001:db8::1    2001:db8::/32      (an IPv4-mapped IPv6 address, ::ffff:1.2.3.4, is read as the IPv4 one)
// Safety rails: a range wider than /8 (IPv4) or /32 (IPv6) is refused, and so is a block that would cover the address of the person adding it,
// the proxy in front of the app, or localhost. If a block ever shuts everybody out, set IP_RULES_DISABLE=true in .env and restart.
const net = require('net');

const MAX_RULES = 5000;
const MAX_NOTE = 200;
const MIN_PREFIX = { 4: 8, 6: 32 };
const LISTS = ['block', 'allow'];
const ALERT_GAP_MS = 10 * 60 * 1000;

let rules = [];          // every stored rule: { id, kind, cidr, note, expiresMs, ... }
let lists = { block: new net.BlockList(), allow: new net.BlockList() };
let nextExpiry = Infinity;
let blockCount = 0;
const seen = new Map();  // ip -> last time a blocked request from it was written to the audit log

const unmap = (ip) => { const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(String(ip || '')); return m ? m[1] : String(ip || ''); };

/** "203.0.113.0/24" -> { address, family: 4|6, prefix, cidr }. Throws an Error with a message fit for the screen. */
function parseEntry(input) {
  let s = String(input == null ? '' : input).trim().replace(/^["'\[]+|["'\]]+$/g, '');
  if (!s) throw new Error('Enter an IP address or range');
  if (s.includes('%')) throw new Error('Remove the zone (%…) from the address');
  const parts = s.split('/');
  if (parts.length > 2) throw new Error(`"${s}" is not an IP address or range`);
  const addr = unmap(parts[0]).toLowerCase();
  const family = net.isIP(addr);
  if (!family) throw new Error(`"${parts[0]}" is not a valid IP address`);
  const max = family === 4 ? 32 : 128;
  let prefix = max;
  if (parts.length === 2) {
    if (!/^\d{1,3}$/.test(parts[1])) throw new Error(`"/${parts[1]}" is not a valid range size`);
    prefix = parseInt(parts[1], 10);
    if (prefix > max) throw new Error(`/${prefix} is too long for an IPv${family} address (max /${max})`);
    if (parts[0].toLowerCase().startsWith('::ffff:') && family === 4) prefix = prefix >= 96 ? prefix - 96 : prefix;   // ::ffff:1.2.3.0/120 -> 1.2.3.0/24
  }
  if (prefix < MIN_PREFIX[family]) throw new Error(`/${prefix} covers too many addresses (the widest allowed is /${MIN_PREFIX[family]} for IPv${family})`);
  return { address: addr, family, prefix, cidr: prefix === max ? addr : `${addr}/${prefix}` };
}

function listOf(entries) {
  const l = new net.BlockList();
  for (const e of entries) {
    const p = parseEntry(e.cidr);
    const fam = p.family === 4 ? 'ipv4' : 'ipv6';
    if (p.prefix === (p.family === 4 ? 32 : 128)) l.addAddress(p.address, fam); else l.addSubnet(p.address, p.prefix, fam);
  }
  return l;
}

function inList(list, ip) {
  const a = unmap(ip);
  const fam = net.isIP(a);
  return fam ? list.check(a, fam === 4 ? 'ipv4' : 'ipv6') : false;
}

/** Does this one entry (address or range) cover `ip`? */
const covers = (cidr, ip) => inList(listOf([{ cidr }]), ip);

function rebuild(now = Date.now()) {
  const live = rules.filter((r) => !r.expiresMs || r.expiresMs > now);
  lists = { block: listOf(live.filter((r) => r.kind === 'block')), allow: listOf(live.filter((r) => r.kind === 'allow')) };
  blockCount = live.filter((r) => r.kind === 'block').length;
  nextExpiry = live.reduce((m, r) => (r.expiresMs && r.expiresMs < m ? r.expiresMs : m), Infinity);
}
const fresh = () => { if (Date.now() >= nextExpiry) rebuild(); };

const shape = (r) => ({
  id: r.id, kind: r.kind, cidr: r.cidr, note: r.note || '', expires_at: r.expires_at || null,
  created_by: r.created_by_name || null, created_at: r.created_at,
  expired: Boolean(r.expires_at && new Date(r.expires_at).getTime() <= Date.now()),
});

/** Read the rules from the database (at start-up and after every change). Keeps the old rules if the database cannot be read. */
async function load(db = require('./db')) {
  try {
    const { rows } = await db.query('SELECT * FROM ip_rules ORDER BY created_at DESC, id DESC');
    rules = rows.map((r) => ({ ...r, expiresMs: r.expires_at ? new Date(r.expires_at).getTime() : null }));
    rebuild();
  } catch (e) { console.error('[ip-rules] could not load the rules (keeping the previous ones):', e.message); }
}

/** Is this address on the allow list? (Never shut out by wrong passwords or rate limits.) */
function isAllowed(ip) { if (!rules.length) return false; fresh(); return inList(lists.allow, ip); }
/** Is this address blocked? An allow rule wins. */
function isBlocked(ip) { if (!blockCount) return false; fresh(); return !inList(lists.allow, ip) && inList(lists.block, ip); }
const disabled = () => String(process.env.IP_RULES_DISABLE || '').toLowerCase() === 'true';

/** Express: a blocked address gets 403 before anything else runs (no session, no database work). */
function middleware(req, res, next) {
  if (disabled() || !isBlocked(req.ip)) return next();
  const now = Date.now();
  if (now - (seen.get(req.ip) || 0) > ALERT_GAP_MS) {   // one audit line per address per 10 minutes, no alert: it is already blocked
    seen.set(req.ip, now);
    if (seen.size > 2000) for (const [k, t] of seen) if (now - t > ALERT_GAP_MS) seen.delete(k);
    const rule = rules.find((r) => r.kind === 'block' && (!r.expiresMs || r.expiresMs > now) && covers(r.cidr, req.ip));
    console.warn(`[ip-rules] blocked ${req.ip} (${rule ? rule.cidr : '?'}) ${req.method} ${(req.originalUrl || '').split('?')[0]}`);
    try { require('./audit').audit(req, 'security.ip_blocked', 'security', null, { rule: rule ? rule.cidr : null, method: req.method, route: (req.originalUrl || '').split('?')[0] }).catch(() => {}); } catch (_) { /* best effort */ }
  }
  res.status(403).set('Cache-Control', 'no-store').type('text/plain').send('Access denied');
}

// ---------- Checking one entry before it is stored ----------

/** Validate an entry for `kind`. `self` = addresses the person is using right now (a block may not cover them). Returns { cidr } or throws. */
function check(kind, input, { self = [] } = {}) {
  if (!LISTS.includes(kind)) throw new Error('The list must be block or allow');
  const p = parseEntry(input);
  if (kind === 'block') {
    for (const ip of [...self, '127.0.0.1', '::1']) {
      if (ip && covers(p.cidr, ip)) throw new Error(`Would block ${ip === '127.0.0.1' || ip === '::1' ? 'localhost' : (self.includes(ip) ? `your own address (${ip})` : ip)}`);
    }
  }
  return { cidr: p.cidr };
}

function parseExpiry(v) {
  if (v == null || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(String(v).trim());
  if (!Number.isFinite(t)) throw new Error(`"${v}" is not a date`);
  if (t <= Date.now()) throw new Error('The expiry is already in the past');
  if (t > Date.now() + 10 * 365 * 86400000) throw new Error('The expiry is more than 10 years away');
  return new Date(t).toISOString();
}
const cleanNote = (n) => String(n == null ? '' : n).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, MAX_NOTE) || null;

// ---------- Import / export ----------

const LIST_WORDS = [[/^(block|blocked|blocklist|deny|denied|blacklist|ban|banned)$/i, 'block'], [/^(allow|allowed|allowlist|whitelist|whitelisted|trust|trusted)$/i, 'allow']];
const listWord = (v) => { const s = String(v == null ? '' : v).trim(); if (!s) return null; const m = LIST_WORDS.find(([re]) => re.test(s)); return m ? m[1] : undefined; };
const HEAD = { ip: /^(ip|ip_?address|address|cidr|range|network)$/i, list: /^(list|type|kind|action|rule)$/i, note: /^(note|notes|comment|comments|reason|description)$/i, expires: /^(expires|expires_?at|expiry|expire|until)$/i };

function splitCsv(text) {
  const first = (text.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#')) || '');
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = []; let cell = ''; let q = false; let line = 1; let start = 1;
  const endCell = () => { row.push(cell); cell = ''; };
  const endRow = () => { endCell(); if (row.some((c) => c.trim())) rows.push({ line: start, cells: row }); row = []; start = line + 1; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else { cell += c; if (c === '\n') line++; } }
    else if (c === '"' && !cell.trim()) q = true;
    else if (c === delim) endCell();
    else if (c === '\n') { endRow(); line++; start = line; }
    else if (c !== '\r') cell += c;
  }
  endRow();
  return rows.filter((r) => !r.cells[0].trim().startsWith('#'));
}

/** Read a CSV or JSON text into raw rows [{ line, ip, list, note, expires }]. Throws when the file cannot be read at all. */
function readRows(text, format) {
  const t = String(text || '').replace(/^\uFEFF/, '');
  if (!t.trim()) throw new Error('The file is empty');
  const fmt = format === 'csv' || format === 'json' ? format : (/^\s*[\[{]/.test(t) ? 'json' : 'csv');
  if (fmt === 'json') {
    let j;
    try { j = JSON.parse(t); } catch (e) { throw new Error(`Not valid JSON: ${e.message}`); }
    const out = [];
    const item = (x, i, list) => {
      if (typeof x === 'string') return out.push({ line: i + 1, ip: x, list });
      if (!x || typeof x !== 'object') return out.push({ line: i + 1, ip: '', list });
      const pick = (re) => { const k = Object.keys(x).find((key) => re.test(key)); return k ? x[k] : undefined; };
      out.push({ line: i + 1, ip: pick(HEAD.ip), list: pick(HEAD.list) !== undefined ? pick(HEAD.list) : list, note: pick(HEAD.note), expires: pick(HEAD.expires) });
    };
    if (Array.isArray(j)) j.forEach((x, i) => item(x, i, undefined));
    else if (j && typeof j === 'object') {
      let n = 0;
      for (const [k, v] of Object.entries(j)) {
        const l = listWord(k) || listWord(k.replace(/list$/i, ''));
        if (!l || !Array.isArray(v)) throw new Error(`Unexpected key "${k}": use "block" and "allow" lists, or one array of entries`);
        v.forEach((x) => item(x, n++, l));
      }
    } else throw new Error('Expected a JSON array, or an object with "block" and "allow" lists');
    return out;
  }
  const rows = splitCsv(t);
  if (!rows.length) throw new Error('The file has no rows');
  let map = { ip: 0, list: 1, note: 2, expires: 3 };
  const h = rows[0].cells.map((c) => c.trim());
  if (h.some((c) => HEAD.ip.test(c)) && !h.some((c) => { try { parseEntry(c); return true; } catch (_) { return false; } })) {
    map = {};
    for (const key of Object.keys(HEAD)) { const i = h.findIndex((c) => HEAD[key].test(c)); if (i >= 0) map[key] = i; }
    rows.shift();
  }
  return rows.map((r) => ({ line: r.line, ip: r.cells[map.ip], list: map.list != null ? r.cells[map.list] : undefined, note: map.note != null ? r.cells[map.note] : undefined, expires: map.expires != null ? r.cells[map.expires] : undefined }));
}

/**
 * Turn a file into entries. Returns { entries: [{ line, kind, cidr, note, expires_at }], errors: [{ line, value, error }], duplicates }.
 * `defaultList` is used for rows that do not name a list. Rows that break a rule are reported, never silently dropped.
 */
function parseImport(text, { format, defaultList, self = [] } = {}) {
  const raw = readRows(text, format);
  if (raw.length > MAX_RULES) throw new Error(`At most ${MAX_RULES} entries per file (this one has ${raw.length})`);
  const entries = []; const errors = []; const byKey = new Map(); let duplicates = 0;
  for (const r of raw) {
    const value = String(r.ip == null ? '' : r.ip).trim();
    try {
      let kind = listWord(r.list);
      if (kind === undefined) throw new Error(`"${r.list}" is not a list: use block or allow`);
      kind = kind || defaultList;
      if (!LISTS.includes(kind)) throw new Error('No list given for this row: add a "list" column (block / allow) or choose the list for the file');
      const { cidr } = check(kind, value, { self });
      const e = { line: r.line, kind, cidr, note: cleanNote(r.note), expires_at: parseExpiry(r.expires) };
      const k = `${kind}|${cidr}`;
      if (byKey.has(k)) { duplicates++; entries[byKey.get(k)] = e; } else { byKey.set(k, entries.length); entries.push(e); }
    } catch (err) { errors.push({ line: r.line, value: value.slice(0, 80), error: err.message }); }
  }
  return { entries, errors, duplicates };
}

// A cell that starts with = + - @ is read as a formula by Excel: prefix it so an exported note can never run anything.
const cell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function toCsv(list) {
  return ['ip,list,note,expires,added_by,added_at', ...list.map((r) => [r.cidr, r.kind, r.note, r.expires_at ? new Date(r.expires_at).toISOString() : '', r.created_by, r.created_at ? new Date(r.created_at).toISOString() : ''].map(cell).join(','))].join('\r\n') + '\r\n';
}
const toJson = (list) => JSON.stringify(list.map((r) => ({ ip: r.cidr, list: r.kind, note: r.note || '', expires: r.expires_at ? new Date(r.expires_at).toISOString() : null, addedBy: r.created_by, addedAt: r.created_at })), null, 2);

/** Block an address for `hours` on the watch's own initiative (a scanner). Returns false when it was not added (list full, or invalid). */
async function autoBlock(ip, note, hours, db = require('./db')) {
  const p = parseEntry(unmap(ip));
  if (covers(p.cidr, '127.0.0.1') || covers(p.cidr, '::1')) return false;
  const { rows } = await db.query('SELECT count(*)::int AS n FROM ip_rules');
  if (rows[0].n >= MAX_RULES) return false;
  await db.query(
    `INSERT INTO ip_rules (kind, cidr, note, expires_at, created_by, created_by_name) VALUES ('block',$1,$2, now() + ($3 || ' hours')::interval, NULL, 'security-watch')
     ON CONFLICT (kind, cidr) DO UPDATE SET note = EXCLUDED.note, expires_at = EXCLUDED.expires_at`,
    [p.cidr, String(note || '').slice(0, MAX_NOTE), String(hours)]
  );
  await load(db);
  return true;
}

/** For tests */
function _set(list) { rules = list.map((r, i) => ({ id: i + 1, expiresMs: r.expires_at ? new Date(r.expires_at).getTime() : null, ...r })); rebuild(); }

module.exports = {
  parseEntry, covers, check, parseExpiry, cleanNote, parseImport, toCsv, toJson, load, shape, isAllowed, isBlocked, middleware, unmap, autoBlock, disabled,
  MAX_RULES, LISTS, _set, rules: () => rules,
};
