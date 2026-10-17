// Security watch: blocked requests are audited once a minute per source, a burst or a lock-out alerts the admins, one IP cannot lock everyone out.
const test = require('node:test');
const assert = require('node:assert');

const audits = [];
const told = [];
const sqls = [];
require.cache[require.resolve('../src/audit')] = { id: 'a', filename: 'a', loaded: true, exports: { audit: async (req, action, ent, id, d) => { audits.push({ action, ip: req.ip, d }); } } };
require.cache[require.resolve('../src/db')] = { id: 'd', filename: 'd', loaded: true, exports: { query: async (q) => { sqls.push(String(q)); return { rows: [{ id: 1, email: '' }] }; } } };
require.cache[require.resolve('../src/notify')] = { id: 'n', filename: 'n', loaded: true, exports: { notifyUsers: async (ids, p) => { told.push(p); } } };
const w = require('../src/security-watch');
const req = (ip, url = '/api/x') => ({ ip, method: 'GET', originalUrl: url, user: null });
const tick = () => new Promise((r) => setImmediate(r));
const reset = () => { w.reset(); audits.length = 0; told.length = 0; };

test('the same blocked request is written to the audit log once, not on every repeat', () => {
  reset();
  for (let i = 0; i < 5; i++) w.event(req('1.1.1.1'), 'security.unauthenticated');
  w.event(req('1.1.1.1', '/api/other'), 'security.unauthenticated');
  assert.strictEqual(audits.filter((a) => a.action === 'security.unauthenticated').length, 2);
});

test('a probe across many routes raises one alert to the admins', async () => {
  reset();
  for (let i = 0; i < w.BURST_N + 3; i++) w.event(req('2.2.2.2', `/api/r${i}`), 'security.denied', { need: 'x' });
  await tick(); await tick();
  assert.strictEqual(audits.filter((a) => a.action === 'security.alert').length, 1);
  assert.strictEqual(told.length, 1);
});

test('a stale tab hitting one route over and over does not raise an alert', async () => {
  reset();
  for (let i = 0; i < 50; i++) w.event(req('3.3.3.3', '/api/presence'), 'security.unauthenticated');
  await tick();
  assert.strictEqual(audits.filter((a) => a.action === 'security.alert').length, 0);
});

test('hitting the login rate limit alerts at once', async () => {
  reset();
  w.event(req('4.4.4.4', '/api/auth/login'), 'security.rate_limited', { limiter: 'login' });
  await tick(); await tick();
  assert.strictEqual(audits.filter((a) => a.action === 'security.alert').length, 1);
});

test('wrong passwords add up to an alert', async () => {
  reset();
  for (let i = 0; i < w.BURST_N; i++) w.failure(req('5.5.5.5'));
  await tick(); await tick();
  assert.strictEqual(audits.filter((a) => a.action === 'security.alert').length, 1);
});

test('an address shut out of an account alerts the System Admins once', async () => {
  reset();
  const r = req('6.6.6.6');
  w.ipLocked(r, 'alice', 15);
  w.ipLocked(r, 'alice', 15);   // the same source again inside the alert gap: no second alert
  await tick(); await tick();
  const a = audits.filter((x) => x.action === 'security.alert');
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].ip, '6.6.6.6');
  assert.strictEqual(told.length, 1);
});

test('security alerts are sent to System Admins only, never to plain Admins', async () => {
  reset();
  sqls.length = 0;
  w.ipLocked(req('8.8.8.8'), 'bob', 15);
  await tick(); await tick();
  const q = sqls.find((x) => /FROM users/.test(x));
  assert.ok(q, 'the recipients are looked up');
  assert.match(q, /role = 'System Admin'/);
  assert.doesNotMatch(q, /'Admin'/);
});

test('the same alert is not repeated inside the quiet period', async () => {
  reset();
  for (let k = 0; k < 3; k++) { w.ipLocked(req('8.8.8.8'), 'same', 15); }
  await tick(); await tick();
  assert.strictEqual(audits.filter((a) => a.action === 'security.alert').length, 1);
});
