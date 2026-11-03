// The upload virus guard, against a small stand-in for clamd (same INSTREAM / PING / VERSION protocol, flags the EICAR test string).
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const calls = { audit: [], malware: [], down: 0 };
const stub = (rel, exports) => { const f = require.resolve(rel); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };
stub('../src/audit', { audit: async (req, action, entity, id, details) => { calls.audit.push({ action, details }); } });
stub('../src/security-watch', { malware: (req, file, sig) => calls.malware.push({ file, sig }), scannerDown: () => { calls.down++; } });
const vs = require('../src/virus-scan');

function fakeClamd({ limit = Infinity } = {}) {
  return net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const nul = buf.indexOf(0);
      if (nul < 0) return;
      const cmd = buf.subarray(0, nul).toString();
      if (cmd === 'zPING') return sock.end('PONG\0');
      if (cmd === 'zVERSION') return sock.end('ClamAV 1.4.0/27800/Tue Oct 27 08:00:00 2026\0');
      if (cmd !== 'zINSTREAM') return sock.end('UNKNOWN COMMAND\0');
      let pos = nul + 1; const parts = []; let total = 0;
      while (buf.length - pos >= 4) {
        const n = buf.readUInt32BE(pos);
        if (n === 0) {
          const body = Buffer.concat(parts);
          if (total > limit) return sock.end('INSTREAM size limit exceeded. ERROR\0');
          return sock.end(body.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'stream: Win.Test.EICAR_HDB-1 FOUND\0' : 'stream: OK\0');
        }
        if (buf.length - pos - 4 < n) return;
        parts.push(buf.subarray(pos + 4, pos + 4 + n)); total += n; pos += 4 + n;
      }
    });
    sock.on('error', () => {});
  });
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const point = (port) => { process.env.CLAMAV_HOST = '127.0.0.1'; process.env.CLAMAV_PORT = String(port); delete process.env.CLAMAV_FAIL; delete process.env.CLAMAV_LARGE; delete process.env.CLAMAV_MODE; };
const res = () => { const r = { code: 0, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const run = (req) => new Promise((resolve) => { const r = res(); vs.guard({ method: 'POST', originalUrl: '/api/x', ip: '1.2.3.4', user: { username: 'ed' }, ...req }, r, (e) => resolve({ passed: true, err: e, res: r })); setTimeout(() => resolve({ passed: false, res: r }), 50); });
const tick = () => new Promise((r) => setTimeout(r, 30));

test('scanner is off until CLAMAV_HOST or CLAMAV_SOCKET is set, and the guard lets everything through', async () => {
  delete process.env.CLAMAV_HOST; delete process.env.CLAMAV_SOCKET;
  assert.strictEqual(vs.enabled(), false);
  const r = await run({ file: { originalname: 'a.pdf', buffer: vs.EICAR, size: vs.EICAR.length } });
  assert.strictEqual(r.passed, true);
});

test('clean and infected buffers and files', async () => {
  const srv = fakeClamd(); point(await listen(srv));
  try {
    assert.strictEqual((await vs.scanBuffer(Buffer.from('hello'))).status, 'clean');
    const bad = await vs.scanBuffer(vs.EICAR);
    assert.deepStrictEqual([bad.status, bad.signature], ['infected', 'Win.Test.EICAR_HDB-1']);
    const f = path.join(os.tmpdir(), `vs-${Date.now()}.bin`); fs.writeFileSync(f, Buffer.concat([Buffer.alloc(200000, 65), vs.EICAR]));
    assert.strictEqual((await vs.scanFile(f)).status, 'infected');
    fs.unlinkSync(f);
    const st = await vs.status();
    assert.strictEqual(st.reachable, true); assert.strictEqual(st.detectsTestFile, true); assert.strictEqual(st.signatures, 27800);
  } finally { srv.close(); }
});

test('guard: an infected upload is refused, its temp file deleted, audited and alerted', async () => {
  const srv = fakeClamd(); point(await listen(srv));
  calls.audit.length = 0; calls.malware.length = 0;
  const tmp = path.join(os.tmpdir(), `vs-up-${Date.now()}`); fs.writeFileSync(tmp, vs.EICAR);
  try {
    const r = await run({ files: [{ originalname: 'doc.pdf', path: tmp, size: vs.EICAR.length }] });
    assert.strictEqual(r.passed, false); assert.strictEqual(r.res.code, 422);
    assert.match(r.res.body.error, /EICAR/);
    assert.strictEqual(fs.existsSync(tmp), false);
    assert.ok(calls.audit.some((a) => a.action === 'security.malware_blocked'));
    assert.strictEqual(calls.malware.length, 1);
  } finally { srv.close(); fs.rmSync(tmp, { force: true }); }
});

test('guard: clean upload passes; several files, one infected -> all refused', async () => {
  const srv = fakeClamd(); point(await listen(srv));
  try {
    assert.strictEqual((await run({ file: { originalname: 'ok.xlsx', buffer: Buffer.from('fine'), size: 4 } })).passed, true);
    const r = await run({ files: { logo: [{ originalname: 'l.png', buffer: Buffer.from('fine'), size: 4 }], icon: [{ originalname: 'i.png', buffer: vs.EICAR, size: vs.EICAR.length }] } });
    assert.strictEqual(r.res.code, 422);
  } finally { srv.close(); }
});

test('guard: scanner down refuses by default, lets through (audited) with CLAMAV_FAIL=open', async () => {
  const srv = fakeClamd(); const port = await listen(srv); srv.close(); await tick();   // now nothing listens there
  point(port); calls.down = 0; calls.audit.length = 0;
  const r = await run({ file: { originalname: 'a.xlsx', buffer: Buffer.from('x'), size: 1 } });
  assert.strictEqual(r.res.code, 503);
  assert.ok(calls.audit.some((a) => a.action === 'security.scan_failed' && a.details.refused === true));
  assert.strictEqual(calls.down, 1);
  process.env.CLAMAV_FAIL = 'open';
  assert.strictEqual((await run({ file: { originalname: 'a.xlsx', buffer: Buffer.from('x'), size: 1 } })).passed, true);
  delete process.env.CLAMAV_FAIL;
});

test('guard: too-large files are noted not scanned (or refused with CLAMAV_LARGE=block); encrypted backups are skipped', async () => {
  const srv = fakeClamd(); point(await listen(srv));
  process.env.CLAMAV_MAX_MB = '1';
  try {
    calls.audit.length = 0;
    const big = { originalname: 'big.zip', buffer: Buffer.alloc(10), size: 5 * 1024 * 1024 };
    assert.strictEqual((await run({ file: big })).passed, true);
    assert.ok(calls.audit.some((a) => a.action === 'security.scan_skipped' && /too large/.test(a.details.reason)));
    process.env.CLAMAV_LARGE = 'block';
    assert.strictEqual((await run({ file: big })).res.code, 413);
    delete process.env.CLAMAV_LARGE;
    assert.strictEqual((await run({ file: { originalname: 'b.zip.enc', buffer: vs.EICAR, size: vs.EICAR.length } })).passed, true);
  } finally { srv.close(); delete process.env.CLAMAV_MAX_MB; }
});

test('parse reads clamd answers', () => {
  assert.deepStrictEqual(vs.parse('stream: OK'), { status: 'clean' });
  assert.deepStrictEqual(vs.parse('stream: Eicar-Signature FOUND'), { status: 'infected', signature: 'Eicar-Signature' });
  assert.strictEqual(vs.parse('INSTREAM size limit exceeded. ERROR').status, 'error');
  assert.strictEqual(vs.parse('').status, 'error');
});
