// The scheduled self-check alerts only for something that is newly wrong, not for a problem that was already known.
const test = require('node:test');
const assert = require('node:assert');
const store = {}; const alerts = [];
require.cache[require.resolve('../src/db')] = { id: 'd', filename: 'd', loaded: true, exports: { query: async (q, p) => {
  if (/SELECT value/.test(q)) return { rows: store.v ? [{ value: store.v }] : [] };
  if (/INSERT INTO app_settings/.test(q)) { store.v = p[1]; return { rows: [] }; }
  return { rows: [] };
} } };
require.cache[require.resolve('../src/security-watch')] = { id: 'w', filename: 'w', loaded: true, exports: { checkAlert: (checks) => alerts.push(checks.map((c) => c.id)) } };
const sch = require('../src/security-check-schedule');
const res = (checks) => ({ at: new Date().toISOString(), fail: 0, warn: 0, checks: checks.map(([id, status]) => ({ id, status, title: id, detail: '' })) });

test('first run alerts only for "fix now" items', async () => {
  delete store.v; alerts.length = 0;
  await sch.record(res([['a', 'warn'], ['b', 'fail'], ['c', 'ok']]));
  assert.deepStrictEqual(alerts, [['b']]);
});

test('a known problem does not alert again; a new or worse one does', async () => {
  alerts.length = 0;
  await sch.record(res([['a', 'warn'], ['b', 'fail'], ['c', 'ok']]));
  assert.strictEqual(alerts.length, 0);
  await sch.record(res([['a', 'fail'], ['b', 'fail'], ['c', 'warn'], ['d', 'info']]));
  assert.deepStrictEqual(alerts, [['a', 'c']]);   // a got worse, c is new, d is only a note
});

test('a problem that was fixed and comes back alerts again; a manual run does not alert but becomes the baseline', async () => {
  alerts.length = 0;
  await sch.record(res([['a', 'ok'], ['b', 'ok'], ['c', 'ok']]));
  await sch.record(res([['b', 'fail']]));
  assert.deepStrictEqual(alerts, [['b']]);
  alerts.length = 0;
  await sch.record(res([['x', 'fail']]), { source: 'manual', alert: false });
  await sch.record(res([['x', 'fail']]));
  assert.strictEqual(alerts.length, 0, 'already seen by the Admin');
});
