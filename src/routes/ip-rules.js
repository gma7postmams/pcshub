// Administration > IP Access (System Admin): the block list, the allow list, and the addresses shut out after wrong passwords.
const express = require('express');
const db = require('../db');
const v = require('../validate');
const { asyncH, HttpError } = require('../middleware');
const { audit } = require('../audit');
const ipRules = require('../ip-rules');
const guard = require('../login-guard');
const geoip = require('../geoip');

const router = express.Router();
router.use((req, res, next) => (req.user && req.user.role === 'System Admin' ? next() : res.status(403).json({ error: 'System Admin role required' })));

/** The addresses this person is using right now: a block may not cover them. */
const selfOf = (req) => [...new Set([req.ip, req.socket && req.socket.remoteAddress].filter(Boolean).map(ipRules.unmap))];
const listName = (v0) => { const s = String(v0 || '').toLowerCase(); if (!ipRules.LISTS.includes(s)) throw new HttpError(400, 'The list must be block or allow'); return s; };
const who = (req) => req.user.full_name || req.user.username;

router.get('/', asyncH(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM ip_rules ORDER BY created_at DESC, id DESC');
  const auto = guard.list().map((a) => ({ user: a.user, ip: a.ip, until: new Date(a.until).toISOString() }));
  const me = { ip: ipRules.unmap(req.ip), direct: ipRules.unmap((req.socket && req.socket.remoteAddress) || ''), trustProxy: process.env.TRUST_PROXY || null };
  // Where each address is (this whole route is System Admin only). A range is placed by its first address.
  const geo = geoip.mapFor(req, [me.ip, me.direct, ...auto.map((a) => a.ip), ...rows.map((r) => r.cidr.split('/')[0])]);
  res.json({
    rules: rows.map(ipRules.shape), auto, me, geo: geo || {}, geoip: geoip.status(),
    max: ipRules.MAX_RULES, disabled: String(process.env.IP_RULES_DISABLE || '').toLowerCase() === 'true',
  });
}));

async function upsert(c, kind, e, req) {
  const { rows } = await c.query(
    `INSERT INTO ip_rules (kind, cidr, note, expires_at, created_by, created_by_name) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (kind, cidr) DO UPDATE SET note = EXCLUDED.note, expires_at = EXCLUDED.expires_at, created_by = EXCLUDED.created_by, created_by_name = EXCLUDED.created_by_name
     RETURNING id, (xmax = 0) AS inserted`,
    [kind, e.cidr, e.note, e.expires_at, req.user.id, who(req)]
  );
  return rows[0];
}
const room = async (c, extra) => {
  const { rows } = await c.query('SELECT count(*)::int AS n FROM ip_rules');
  if (rows[0].n + extra > ipRules.MAX_RULES) throw new HttpError(400, `The lists hold at most ${ipRules.MAX_RULES} entries`);
};

router.post('/', asyncH(async (req, res) => {
  const kind = listName(req.body.list);
  let cidr; let expires; let note;
  try { ({ cidr } = ipRules.check(kind, req.body.ip, { self: selfOf(req) })); expires = ipRules.parseExpiry(req.body.expires); note = ipRules.cleanNote(req.body.note); } catch (e) { throw new HttpError(400, e.message); }
  await room(db, 1);
  const r = await upsert(db, kind, { cidr, note, expires_at: expires }, req);
  await ipRules.load(db);
  await audit(req, 'admin.ip_rule_add', 'ip_rule', r.id, { list: kind, ip: cidr, note, expires, updated: !r.inserted });
  res.json({ ok: true, id: r.id, updated: !r.inserted });
}));

router.delete('/:id', asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  const { rows } = await db.query('DELETE FROM ip_rules WHERE id=$1 RETURNING kind, cidr', [id]);
  if (!rows.length) throw new HttpError(404, 'Entry not found');
  await ipRules.load(db);
  await audit(req, 'admin.ip_rule_remove', 'ip_rule', id, { list: rows[0].kind, ip: rows[0].cidr });
  res.json({ ok: true });
}));

// Remove several at once: { ids: [...] }
router.post('/remove', asyncH(async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map((x) => v.id(x)))];
  if (!ids.length || ids.length > ipRules.MAX_RULES) throw new HttpError(400, 'Choose the entries to remove');
  const { rows } = await db.query('DELETE FROM ip_rules WHERE id = ANY($1::int[]) RETURNING kind, cidr', [ids]);
  await ipRules.load(db);
  await audit(req, 'admin.ip_rule_remove', 'ip_rule', null, { count: rows.length, ips: rows.slice(0, 50).map((r) => `${r.kind}:${r.cidr}`) });
  res.json({ ok: true, removed: rows.length });
}));

// Import a CSV or JSON text. dryRun: true only checks it and says what would happen.
router.post('/import', asyncH(async (req, res) => {
  const text = typeof req.body.text === 'string' ? req.body.text : '';
  const defaultList = req.body.list ? listName(req.body.list) : null;
  let parsed;
  try { parsed = ipRules.parseImport(text, { format: req.body.format, defaultList, self: selfOf(req) }); } catch (e) { throw new HttpError(400, e.message); }
  const { entries, errors, duplicates } = parsed;
  const { rows: have } = await db.query('SELECT kind, cidr FROM ip_rules');
  const known = new Set(have.map((r) => `${r.kind}|${r.cidr}`));
  const fresh = entries.filter((e) => !known.has(`${e.kind}|${e.cidr}`)).length;
  const summary = {
    valid: entries.length, added: fresh, updated: entries.length - fresh, duplicates, invalid: errors.length, errors: errors.slice(0, 100),
    block: entries.filter((e) => e.kind === 'block').length, allow: entries.filter((e) => e.kind === 'allow').length,
  };
  if (req.body.dryRun) return res.json({ ok: true, dryRun: true, ...summary });
  if (!entries.length) throw new HttpError(400, errors.length ? 'No valid entries in this file' : 'The file has no entries');
  await db.tx(async (c) => {
    await room(c, fresh);
    for (const e of entries) await upsert(c, e.kind, e, req);
  });
  await ipRules.load(db);
  await audit(req, 'admin.ip_rule_import', 'ip_rule', null, { added: fresh, updated: entries.length - fresh, invalid: errors.length, block: summary.block, allow: summary.allow });
  res.json({ ok: true, ...summary });
}));

router.get('/export', asyncH(async (req, res) => {
  const fmt = req.query.format === 'json' ? 'json' : 'csv';
  const kind = req.query.list ? listName(req.query.list) : null;
  const { rows } = await db.query('SELECT * FROM ip_rules WHERE ($1::text IS NULL OR kind = $1) ORDER BY kind, id', [kind]);
  const list = rows.map(ipRules.shape);
  await audit(req, 'admin.ip_rule_export', 'ip_rule', null, { count: list.length, format: fmt, list: kind });
  const name = `ip-rules${kind ? `-${kind}` : ''}-${new Date().toISOString().slice(0, 10)}.${fmt}`;
  res.set({ 'Content-Type': fmt === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'X-Content-Type-Options': 'nosniff' });
  res.send(fmt === 'json' ? ipRules.toJson(list) : ipRules.toCsv(list));
}));

// Let one address back in to one account before its lock time is over.
router.post('/auto/unblock', asyncH(async (req, res) => {
  const user = typeof req.body.user === 'string' ? req.body.user.trim() : '';
  const ip = typeof req.body.ip === 'string' ? req.body.ip.trim() : '';
  if (!user || !ip || !guard.unblock(user, ip)) throw new HttpError(404, 'That address is no longer blocked');
  await audit(req, 'admin.ip_auto_unblock', 'ip_rule', null, { username: user, ip });
  res.json({ ok: true });
}));

module.exports = router;
