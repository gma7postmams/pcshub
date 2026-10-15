// Security watch: blocked requests are audited once a minute per source, a burst or a lock-out alerts the admins, one IP cannot lock everyone out.
const test = require('node:test');
const assert = require('node:assert');

const audits = [];
const told = [];
require.cache[require.resolve('../src/audit')] = { id: 'a', filename: 'a', loaded: true, exports: { audit: async (req, action, ent, id, d) => { audits.push({ action, ip: req.ip, d }); } } };
require.cache[require.resolve('../src/db')] = { id: 'd', filename: 'd', loaded: true, exports: { query: async () => ({ rows: [{ id: 1, email: '' }] }) } };
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

test('an account lock-out alerts, and one IP cannot lock more than the budget', async () => {
  reset();
  const r = req('6.6.6.6');
  for (let i = 0; i < w.LOCK_BUDGET; i++) { assert.strictEqual(w.lockBudgetLeft(r), true); w.locked(r, `user${i}`); }
  assert.strictEqual(w.lockBudgetLeft(r), false);
  assert.strictEqual(w.lockBudgetLeft(req('7.7.7.7')), true);   // someone else is not affected
  await tick(); await tick();
  assert.strictEqual(audits.filter((a) => a.action === 'security.alert').length, w.LOCK_BUDGET);
});

test('the same alert is not repeated inside the quiet period', async () => {
  reset();
  for (let k = 0; k < 3; k++) { w.locked(req('8.8.8.8'), 'same'); }
  await tick(); await tick();
  assert.strictEqual(audits.filter((a) => a.action === 'security.alert').length, 1);
});
