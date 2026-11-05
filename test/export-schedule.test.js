// Scheduled Excel export: which dates "yesterday / last week / last month" mean, when a run is due, and what the settings accept.
const test = require('node:test');
const assert = require('node:assert');
const store = {};
require.cache[require.resolve('../src/db')] = { id: 'd', filename: 'd', loaded: true, exports: { query: async (q, p) => {
  if (/SELECT value/.test(q)) return { rows: store[p[0]] ? [{ value: store[p[0]] }] : [] };
  if (/INSERT INTO app_settings/.test(q)) { store[p[0]] = p[1]; return { rows: [] }; }
  return { rows: [] };
} } };
const ex = require('../src/export-schedule');
const D = (s) => new Date(`${s}:00`);   // local time
const base = { enabled: true, time: '06:00', byDate: false, modules: { plugs: true, ingest: true, workload: true }, keep: 14, from: '', to: '' };

test('yesterday, last week (Monday-Sunday) and last month', () => {
  assert.deepStrictEqual(ex.resolveRange({ ...base, range: 'yesterday' }, D('2026-11-05T09:00')), { from: '2026-11-04', to: '2026-11-04' });
  assert.deepStrictEqual(ex.resolveRange({ ...base, range: 'yesterday' }, D('2026-03-01T09:00')), { from: '2026-02-28', to: '2026-02-28' });
  // Thursday 5 Nov 2026: this week began Mon 2 Nov, so last week is 26 Oct - 1 Nov
  assert.deepStrictEqual(ex.resolveRange({ ...base, range: 'last_week' }, D('2026-11-05T09:00')), { from: '2026-10-26', to: '2026-11-01' });
  assert.deepStrictEqual(ex.resolveRange({ ...base, range: 'last_week' }, D('2026-11-02T06:00')), { from: '2026-10-26', to: '2026-11-01' });   // on the Monday itself
  assert.deepStrictEqual(ex.resolveRange({ ...base, range: 'last_week' }, D('2026-11-08T23:00')), { from: '2026-10-26', to: '2026-11-01' });   // on the Sunday
  assert.deepStrictEqual(ex.resolveRange({ ...base, range: 'last_month' }, D('2026-11-05T09:00')), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepStrictEqual(ex.resolveRange({ ...base, range: 'last_month' }, D('2026-01-01T06:00')), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepStrictEqual(ex.resolveRange({ ...base, range: 'last_month' }, D('2026-03-10T06:00')), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepStrictEqual(ex.resolveRange({ ...base, range: 'custom', from: '2026-09-02', to: '2026-09-09' }, D('2026-11-05T09:00')), { from: '2026-09-02', to: '2026-09-09' });
});

test('the range decides which days a run belongs on, and when the next one is', () => {
  assert.strictEqual(ex.runsOn({ range: 'last_week' }, D('2026-11-02T06:00')), true);    // Monday
  assert.strictEqual(ex.runsOn({ range: 'last_week' }, D('2026-11-03T06:00')), false);
  assert.strictEqual(ex.runsOn({ range: 'last_month' }, D('2026-12-01T06:00')), true);
  assert.strictEqual(ex.runsOn({ range: 'last_month' }, D('2026-12-02T06:00')), false);
  assert.strictEqual(ex.runsOn({ range: 'yesterday' }, D('2026-12-02T06:00')), true);
  const at = (r, from) => ex.nextRun({ ...base, range: r }, D(from));
  assert.strictEqual(at('yesterday', '2026-11-05T05:00').getDate(), 5);
  assert.strictEqual(at('yesterday', '2026-11-05T07:00').getDate(), 6);
  assert.strictEqual(at('last_week', '2026-11-05T05:00').getDate(), 9);      // next Monday
  assert.strictEqual(at('last_month', '2026-11-05T05:00').getMonth(), 11);   // 1 Dec
  assert.strictEqual(ex.nextRun({ ...base, enabled: false, range: 'yesterday' }), null);
});

test('settings: defaults fill in, bad input is refused', () => {
  const d = ex.normalize({});
  assert.strictEqual(d.enabled, false); assert.strictEqual(d.range, 'yesterday'); assert.strictEqual(d.time, '06:00');
  assert.throws(() => ex.normalize({ range: 'tomorrow' }, true), /Choose/);
  assert.throws(() => ex.normalize({ time: '25:00' }, true), /Time/);
  assert.throws(() => ex.normalize({ range: 'custom', from: '2026-10-05', to: '2026-10-01' }, true), /not be after/);
  assert.throws(() => ex.normalize({ range: 'custom', from: '2026-02-30', to: '2026-03-01' }, true), /From and a To/);
  assert.throws(() => ex.normalize({ range: 'custom', from: '2025-01-01', to: '2026-11-01' }, true), /one year/);
  assert.throws(() => ex.normalize({ modules: { plugs: false, ingest: false, workload: false } }, true), /at least one/);
  assert.throws(() => ex.normalize({ keep: 0 }, true), /Keep/);
  assert.strictEqual(ex.normalize({ byDate: true }).byDate, true);
});

test('saved file names from the URL must be exactly what is on disk (no path tricks)', async () => {
  for (const [run, name] of [['../etc', 'x.xlsx'], ['2026-11-05_0600', '../../.env'], ['2026-11-05_0600', 'a/b.xlsx'], ['2026-11-05_0600', 'x.txt']]) assert.strictEqual(await ex.fileOf(run, name), null);
});
