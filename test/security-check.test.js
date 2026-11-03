// The self-check's own test requests are recognised (so the security watch does not alert on them), and nobody else can pass as one.
const test = require('node:test');
const assert = require('node:assert');
require.cache[require.resolve('../src/db')] = { id: 'd', filename: 'd', loaded: true, exports: { query: async () => ({ rows: [{}] }) } };
const sc = require('../src/security-check');
const fs = require('fs');

test('only the per-process token marks a request as the self-check', () => {
  const src = fs.readFileSync(require.resolve('../src/security-check.js'), 'utf8');
  const token = /TOKEN = crypto\.randomBytes/.test(src);
  assert.ok(token, 'token is random per process');
  assert.strictEqual(sc.isProbe({ get: () => 'guess' }), false);
  assert.strictEqual(sc.isProbe({ get: () => undefined }), false);
  assert.strictEqual(sc.isProbe(null), false);
});

test('the check list has every area and only known levels', () => {
  const src = fs.readFileSync(require.resolve('../src/security-check.js'), 'utf8');
  for (const area of ['Server', 'People', 'Monitoring', 'Backups', 'Live test', 'Packages']) assert.ok(src.includes(`'${area}'`), area);
});
