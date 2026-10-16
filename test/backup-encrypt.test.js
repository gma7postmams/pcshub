// Backups at rest: encrypted with BACKUP_ENC_KEY, read back only with the same key, and a changed byte is refused.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-enc-'));
process.env.BACKUP_DIR = dir;
process.env.BACKUP_ENC_KEY = 'k'.repeat(64);
const cfg = require('../src/backup/config');
const a = require('../src/backup/archive');

const plain = path.join(dir, 'p.zip');
const enc = path.join(dir, 'p.zip.enc');
const out = path.join(dir, 'out.zip');

test('round trip gives back the exact bytes, and the stored file does not contain them', async () => {
  const data = Buffer.concat([Buffer.from('PK\x03\x04 secret password hashes '), require('crypto').randomBytes(300000)]);
  fs.writeFileSync(plain, data);
  await a.encryptFile(plain, enc);
  assert.strictEqual(await a.isEncrypted(enc), true);
  assert.strictEqual(fs.readFileSync(enc).includes(Buffer.from('secret password hashes')), false);
  await a.decryptFile(enc, out);
  assert.ok(fs.readFileSync(out).equals(data));
});

test('a changed byte is refused and leaves no half-decrypted file', async () => {
  const b = fs.readFileSync(enc); b[1000] ^= 1; const bad = path.join(dir, 'bad.enc'); fs.writeFileSync(bad, b);
  const o = path.join(dir, 'bad.zip');
  await assert.rejects(a.decryptFile(bad, o), /wrong BACKUP_ENC_KEY|changed/);
  assert.strictEqual(fs.existsSync(o), false);
});

test('the wrong key is refused', async () => {
  cfg.ENC_KEY = 'x'.repeat(64);
  await assert.rejects(a.decryptFile(enc, path.join(dir, 'w.zip')), /wrong BACKUP_ENC_KEY/);
  cfg.ENC_KEY = '';
  await assert.rejects(a.decryptFile(enc, path.join(dir, 'w.zip')), /not set/);
  cfg.ENC_KEY = 'k'.repeat(64);
});

test('scanZip reads an encrypted archive transparently and cleans up', async () => {
  const z = path.join(dir, 'real.zip');
  await a.writeZip(z, [], { 'metadata.json': '{"ok":1}', 'summary.json': '{}', 'checksums.sha256': '' });
  await a.encryptFile(z, `${z}.enc`);
  const r = await a.scanZip(`${z}.enc`, { read: ['metadata.json'] });
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.texts['metadata.json'], '{"ok":1}');
  assert.strictEqual(r.encrypted, true);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, '.tmp')), []);
});
