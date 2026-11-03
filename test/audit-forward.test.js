// Off-box audit trail: RFC 5424 syslog over UDP and TCP, never throws, queues while the server is away.
const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');
const net = require('net');
const fw = require('../src/audit-forward');

const entry = (action = 'auth.login_failed') => ({ at: '2026-10-30T10:00:00.000Z', action, user: 'ed', ip: '10.0.0.9', details: { note: 'multi\nline' } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('nothing is sent and nothing breaks when AUDIT_SYSLOG is not set', () => {
  delete process.env.AUDIT_SYSLOG; fw._reset();
  assert.strictEqual(fw.configured(), false);
  fw.send(entry());
  assert.strictEqual(fw.status().sent, 0);
});

test('format: RFC 5424, audit facility, severity by action, one line of JSON', () => {
  const m = fw.format(entry('security.alert'));
  assert.match(m, /^<107>1 2026-10-30T10:00:00.000Z \S+ pulse \d+ security\.alert - \{/);   // 13*8 + 3
  assert.ok(!/\n/.test(m));
  assert.strictEqual(JSON.parse(m.slice(m.indexOf(' - ') + 3)).details.note, 'multi\nline');   // the newline travels escaped, so the message stays one line
  assert.match(fw.format(entry('admin.user_delete')), /^<110>1 /);                            // 13*8 + 6
  assert.match(fw.format(entry('security.denied')), /^<108>1 /);                             // 13*8 + 4
});

test('UDP delivery', async () => {
  const srv = dgram.createSocket('udp4'); const got = [];
  srv.on('message', (b) => got.push(b.toString()));
  await new Promise((r) => srv.bind(0, '127.0.0.1', r));
  process.env.AUDIT_SYSLOG = `udp://127.0.0.1:${srv.address().port}`; fw._reset();
  fw.send(entry());
  await wait(100); srv.close();
  assert.strictEqual(got.length, 1); assert.match(got[0], /auth\.login_failed/);
  assert.strictEqual(fw.status().sent, 1);
});

test('TCP delivery; an unreachable server only queues the message and records the error', async () => {
  const got = [];
  let srv = net.createServer((s) => s.on('data', (d) => got.push(...d.toString().split('\n').filter(Boolean))));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  process.env.AUDIT_SYSLOG = `tcp://127.0.0.1:${port}`; fw._reset();
  fw.send(entry('auth.login')); await wait(150);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(fw.status().connected, true);
  srv.close(); await wait(50);
  assert.ok(fw.status().target.startsWith('tcp://'));
  fw._reset();
  process.env.AUDIT_SYSLOG = 'tcp://127.0.0.1:1';   // nothing listens
  fw.send(entry()); await wait(150);
  const st = fw.status();
  assert.strictEqual(st.queued, 1); assert.ok(st.lastError);
  fw._reset(); delete process.env.AUDIT_SYSLOG;
});

test('a bad AUDIT_SYSLOG value is reported, not thrown', () => {
  process.env.AUDIT_SYSLOG = 'http://nope'; fw._reset();
  assert.strictEqual(fw.status().invalid, true); fw.send(entry());
  delete process.env.AUDIT_SYSLOG; fw._reset();
});
