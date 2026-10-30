// Scanner probes: only attack-tool paths match, a few different ones from a public address block it for 24 h, inside the network nothing is blocked.
const test = require('node:test');
const assert = require('node:assert');

const audits = []; const sqls = [];
require.cache[require.resolve('../src/audit')] = { id: 'a', filename: 'a', loaded: true, exports: { audit: async (req, action, ent, id, d) => { audits.push({ action, d }); } } };
require.cache[require.resolve('../src/db')] = { id: 'd', filename: 'd', loaded: true, exports: { query: async (q, p) => { sqls.push({ q: String(q), p }); return { rows: [{ n: 0, id: 1, email: '' }] }; } } };
require.cache[require.resolve('../src/notify')] = { id: 'n', filename: 'n', loaded: true, exports: { notifyUsers: async () => {} } };
const pg = require('../src/probe-guard');
const w = require('../src/security-watch');
const rules = require('../src/ip-rules');
const tick = () => new Promise((r) => setTimeout(r, 20));
const req = (ip, url) => ({ ip, method: 'POST', originalUrl: url, user: null, get: () => undefined, socket: { remoteAddress: ip } });

test('only paths no legitimate user asks for count as probes', () => {
  for (const p of ['/api/gql', '/api/graphql', '/api', '/graphql', '/wp-login.php', '/.env', '/.git/config', '/xmlrpc.php', '/phpmyadmin/index.php', '/api/v1/users', '/boaform/admin/formLogin', '/a/b.php?x=1']) assert.ok(pg.isProbe(p), p);
  for (const p of ['/api/ingest', '/api/workload', '/api/plugs/import', '/api/knowledge/12/file', '/api/admin/backups/ab/download', '/admin', '/knowledge', '/assets/index-abc.js', '/uploads/branding/logo-1.png', '/sw.js', '/manifest.webmanifest', '/.well-known/assetlinks.json', '/api/auth/login']) assert.ok(!pg.isProbe(p), p);
});

test('the middleware answers a probe with 404 and lets everything else through', () => {
  w.reset();
  let code = 0; const res = { status(c) { code = c; return this; }, set() { return this; }, type() { return this; }, send() { return this; } };
  let nexted = false;
  pg.middleware({ path: '/wp-login.php', ip: '9.9.9.9', method: 'GET', originalUrl: '/wp-login.php', get: () => undefined, socket: {} }, res, () => { nexted = true; });
  assert.strictEqual(code, 404); assert.strictEqual(nexted, false);
  pg.middleware({ path: '/api/ingest', ip: '9.9.9.9', method: 'GET', originalUrl: '/api/ingest' }, res, () => { nexted = true; });
  assert.strictEqual(nexted, true);
});

test('three different probe paths from a public address block it for 24 hours', async () => {
  w.reset(); audits.length = 0; sqls.length = 0; delete process.env.TRUST_PROXY; delete process.env.AUTO_BLOCK_PROBES;
  w.probe(req('203.0.113.7', '/api/gql')); w.probe(req('203.0.113.7', '/api/graphql')); await tick();
  assert.ok(!sqls.some((s) => /INSERT INTO ip_rules/.test(s.q)), 'two paths are not enough');
  w.probe(req('203.0.113.7', '/wp-login.php')); await tick(); await tick();
  const ins = sqls.find((s) => /INSERT INTO ip_rules/.test(s.q));
  assert.ok(ins, 'blocked'); assert.strictEqual(ins.p[0], '203.0.113.7'); assert.strictEqual(ins.p[2], '24');
  assert.ok(audits.some((a) => a.action === 'security.ip_auto_blocked'));
  assert.ok(audits.some((a) => a.action === 'security.probe'));
});

test('the same path again and again is one probe, not three', async () => {
  w.reset(); sqls.length = 0;
  for (let i = 0; i < 6; i++) w.probe(req('203.0.113.8', '/api/graphql'));
  await tick(); await tick();
  assert.ok(!sqls.some((s) => /INSERT INTO ip_rules/.test(s.q)));
});

test('inside the network, or with AUTO_BLOCK_PROBES=false, probes are logged but nobody is blocked', async () => {
  w.reset(); sqls.length = 0;
  for (const ip of ['10.1.2.3', '192.168.0.9', '172.20.1.1', '127.0.0.1', '::1', 'fd00::5']) for (const p of ['/a.php', '/b.php', '/c.php']) w.probe(req(ip, p));
  await tick(); await tick();
  assert.ok(!sqls.some((s) => /INSERT INTO ip_rules/.test(s.q)), 'private addresses are never auto-blocked');
  process.env.AUTO_BLOCK_PROBES = 'false';
  for (const p of ['/a.php', '/b.php', '/c.php']) w.probe(req('203.0.113.9', p));
  await tick(); await tick();
  assert.ok(!sqls.some((s) => /INSERT INTO ip_rules/.test(s.q)));
  delete process.env.AUTO_BLOCK_PROBES;
});

test('behind a proxy the proxy address itself is never blocked', async () => {
  w.reset(); sqls.length = 0; process.env.TRUST_PROXY = '1';
  for (const p of ['/a.php', '/b.php', '/c.php']) w.probe(req('203.0.113.50', p));   // req.ip equals the direct peer: that is the proxy
  await tick(); await tick();
  assert.ok(!sqls.some((s) => /INSERT INTO ip_rules/.test(s.q)));
  delete process.env.TRUST_PROXY;
});

test('autoBlock refuses localhost and writes a timed rule', async () => {
  sqls.length = 0;
  assert.strictEqual(await rules.autoBlock('127.0.0.1', 'x', 24), false);
  assert.strictEqual(await rules.autoBlock('198.51.100.4', 'x', 24), true);
  assert.ok(sqls.some((s) => /now\(\) \+/.test(s.q)));
});
