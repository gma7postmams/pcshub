const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FLAG = path.join(os.tmpdir(), `pcs-maint-${process.pid}`);
process.env.MAINTENANCE_FILE = FLAG;
delete process.env.MAINTENANCE_MODE;
delete process.env.MAINTENANCE_MESSAGE;
const mm = require('../src/maintenance-mode');

const clear = () => { try { fs.unlinkSync(FLAG); } catch (e) { /* none */ } delete process.env.MAINTENANCE_MODE; delete process.env.MAINTENANCE_MESSAGE; mm.reset(); };
test.afterEach(clear);

function run(req) {
  const out = { next: false, status: null, body: null, headers: {} };
  const res = {
    set(h) { Object.assign(out.headers, h); return this; },
    status(c) { out.status = c; return this; },
    type() { return this; },
    json(b) { out.body = b; return this; },
    send(b) { out.body = b; return this; },
  };
  mm.guard({ method: 'GET', accepts: () => true, ...req }, res, () => { out.next = true; });
  return out;
}

test('off by default', () => {
  assert.equal(mm.enabled(), false);
  assert.equal(run({ path: '/ingest' }).next, true);
});

test('MAINTENANCE_MODE in .env turns it on (true / 1 / on / yes), anything else is off', () => {
  for (const v of ['true', '1', 'ON', 'Yes']) { process.env.MAINTENANCE_MODE = v; mm.reset(); assert.equal(mm.enabled(), true, v); }
  for (const v of ['false', '0', '', 'no', 'maybe']) { process.env.MAINTENANCE_MODE = v; mm.reset(); assert.equal(mm.enabled(), false, v); }
});

test('the flag file turns it on and its text is the message; removing it turns it off', () => {
  fs.writeFileSync(FLAG, 'Back at 3 PM\n');
  mm.reset();
  assert.deepEqual(mm.state(), { on: true, message: 'Back at 3 PM' });
  fs.unlinkSync(FLAG); mm.reset();
  assert.equal(mm.enabled(), false);
});

test('an empty flag file uses MAINTENANCE_MESSAGE, then the default message', () => {
  fs.writeFileSync(FLAG, '');
  process.env.MAINTENANCE_MESSAGE = 'Upgrading the database'; mm.reset();
  assert.equal(mm.state().message, 'Upgrading the database');
  delete process.env.MAINTENANCE_MESSAGE; mm.reset();
  assert.equal(mm.state().message, mm.DEFAULT_MESSAGE);
});

test('only a System Admin gets through; pages and the API answer 503 for everyone else', () => {
  fs.writeFileSync(FLAG, 'x'); mm.reset();
  assert.equal(run({ path: '/ingest', user: { role: 'System Admin' } }).next, true);
  for (const role of ['Admin', 'Manager', 'Editor', 'Viewer']) {
    const page = run({ path: '/ingest', user: { role } });
    assert.equal(page.next, false); assert.equal(page.status, 503); assert.match(page.body, /Under maintenance/);
    const api = run({ path: '/api/ingest', user: { role } });
    assert.equal(api.status, 503); assert.equal(api.body.maintenance, true);
  }
  const anon = run({ path: '/' });
  assert.equal(anon.status, 503); assert.equal(anon.headers['Retry-After'], '300');
});

test('the sign-in page, sign-in routes, branding and the status check stay reachable', () => {
  fs.writeFileSync(FLAG, 'x'); mm.reset();
  for (const p of ['/login', '/api/auth/login', '/api/auth/2fa', '/api/auth/logout', '/api/auth/me', '/api/branding', '/api/maintenance/status']) {
    assert.equal(run({ path: p }).next, true, p);
  }
  assert.equal(run({ path: '/api/ingest' }).next, false);
});

test('the message is escaped in the page', () => {
  fs.writeFileSync(FLAG, '<script>alert(1)</script>'); mm.reset();
  const out = run({ path: '/' });
  assert.ok(!out.body.includes('<script>alert'));
  assert.match(out.body, /&lt;script&gt;/);
});

test('the in-app switch turns it on and reports itself as the source', () => {
  mm.applyUi(true, 'Upgrading the database');
  const d = mm.detail();
  assert.equal(d.on, true);
  assert.equal(d.message, 'Upgrading the database');
  assert.deepEqual(d.sources, { ui: true, env: false, file: false });
  mm.applyUi(false, '');
  assert.equal(mm.enabled(), false);
});

test('the flag file or .env keeps it on after the in-app switch is turned off, and the file text wins the message', () => {
  mm.applyUi(true, 'From the app');
  fs.writeFileSync(FLAG, 'From the file'); mm.reset(); mm.applyUi(true, 'From the app');
  assert.equal(mm.state().message, 'From the file');
  mm.applyUi(false, '');
  assert.equal(mm.enabled(), true);
  assert.deepEqual(mm.detail().sources, { ui: false, env: false, file: true });
  fs.unlinkSync(FLAG); mm.reset();
  process.env.MAINTENANCE_MODE = 'true'; mm.reset();
  assert.deepEqual(mm.detail().sources, { ui: false, env: true, file: false });
});

test('loadUi / saveUi round-trip through app_settings', async () => {
  const rows = new Map();
  const fake = {
    query: async (sql, params) => {
      if (/^\s*SELECT/i.test(sql)) return { rows: [...rows].filter(([k]) => params[0].includes(k)).map(([key, value]) => ({ key, value })) };
      rows.set(params[0], params[1]); return { rows: [] };
    },
  };
  await mm.saveUi(fake, true, 'Back at noon');
  mm.reset();
  await mm.loadUi(fake);
  assert.deepEqual(mm.state(), { on: true, message: 'Back at noon' });
  await mm.saveUi(fake, false, '');
  await mm.loadUi(fake);
  assert.equal(mm.enabled(), false);
});
