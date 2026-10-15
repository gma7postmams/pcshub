// Main / backup server role: the role file wins over NODE_ROLE, a backup server is read-only (except sign-in and its own tab), the sync token is checked in constant time.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-role-'));
process.env.BACKUP_DIR = dir;
process.env.NODE_SYNC_TOKEN = 'a'.repeat(40);
delete process.env.NODE_ROLE;
const node = require('../src/node');

const run = (method, baseUrl, p) => {
  let out = { next: false, status: null, body: null };
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  node.readOnlyGuard({ method, baseUrl, path: p }, res, () => { out.next = true; });
  return out;
};

test('a server is the main one unless told otherwise', () => {
  assert.strictEqual(node.role(), 'main');
  assert.strictEqual(node.isBackup(), false);
  assert.strictEqual(run('POST', '/api', '/workload').next, true);
});

test('NODE_ROLE=backup makes it a read-only backup server', () => {
  process.env.NODE_ROLE = 'backup';
  assert.strictEqual(node.role(), 'backup');
  const blocked = run('POST', '/api', '/workload');
  assert.strictEqual(blocked.next, false);
  assert.strictEqual(blocked.status, 503);
  assert.strictEqual(blocked.body.readOnlyNode, true);
  for (const m of ['PUT', 'PATCH', 'DELETE']) assert.strictEqual(run(m, '/api', '/ingest/5').status, 503);
});

test('reading, signing in and the Backup Server tab stay open on a backup server', () => {
  assert.strictEqual(run('GET', '/api', '/workload').next, true);
  assert.strictEqual(run('POST', '/api', '/auth/login').next, true);
  assert.strictEqual(run('POST', '/api', '/auth/logout').next, true);
  assert.strictEqual(run('POST', '/api', '/admin/node/promote').next, true);
  assert.strictEqual(run('POST', '/api', '/presence').next, true);
  assert.strictEqual(run('POST', '/api', '/admin/backups/restore').status, 503);   // the ordinary restore is not open
  assert.strictEqual(run('POST', '/api', '/admin/users').status, 503);
});

test('the role file (Promote / Demote) wins over NODE_ROLE and survives a reload', () => {
  node.save({ role: 'main', promotedAt: '2026-10-15T00:00:00.000Z' });
  assert.strictEqual(node.role(), 'main');
  assert.strictEqual(run('POST', '/api', '/workload').next, true);
  node.load();   // as after a restart
  assert.strictEqual(node.role(), 'main');
  assert.strictEqual(node.publicInfo().promotedAt, '2026-10-15T00:00:00.000Z');
  node.save({ role: 'backup' });
  assert.strictEqual(node.isBackup(), true);
});

test('the sync token: exact match only, and a short or empty one never works', () => {
  assert.strictEqual(node.tokenMatches('a'.repeat(40)), true);
  assert.strictEqual(node.tokenMatches('a'.repeat(39)), false);
  assert.strictEqual(node.tokenMatches(''), false);
  assert.strictEqual(node.tokenMatches(undefined), false);
  process.env.NODE_SYNC_TOKEN = 'short';
  assert.strictEqual(node.tokenOk(), false);
  assert.strictEqual(node.tokenMatches('short'), false);
  process.env.NODE_SYNC_TOKEN = '';
  assert.strictEqual(node.tokenMatches(''), false);
});

test('NODE_SYNC_HOURS is 4 unless it is between 1 and 24', () => {
  delete process.env.NODE_SYNC_HOURS;
  assert.strictEqual(node.syncHours(), 4);
  process.env.NODE_SYNC_HOURS = '8'; assert.strictEqual(node.syncHours(), 8);
  process.env.NODE_SYNC_HOURS = '0'; assert.strictEqual(node.syncHours(), 4);
  process.env.NODE_SYNC_HOURS = '99'; assert.strictEqual(node.syncHours(), 4);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
