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
