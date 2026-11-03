// Wrong passwords lock an address out of ONE account; they never lock the account for the real user.
const test = require('node:test');
const assert = require('node:assert');
require.cache[require.resolve('../src/db')] = { id: 'd', filename: 'd', loaded: true, exports: { query: async () => ({ rows: [] }) } };
const guard = require('../src/login-guard');
const settings = require('../src/security-settings');
const N = settings.get().lockAfterFailures;   // 5 by default

test('N wrong passwords from one address shut that address out of the account', () => {
  guard.reset();
  for (let i = 0; i < N - 1; i++) assert.strictEqual(guard.fail('alice', '1.1.1.1').locked, false);
  assert.strictEqual(guard.blockedUntil('alice', '1.1.1.1'), 0);
  const r = guard.fail('alice', '1.1.1.1');
  assert.strictEqual(r.locked, true);
  assert.ok(guard.blockedUntil('alice', '1.1.1.1') > Date.now());
});

test('the real user, from another address, is not affected by an attacker locking their own address out', () => {
  guard.reset();
  for (let i = 0; i < N * 3; i++) guard.fail('alice', '6.6.6.6');
  assert.ok(guard.blockedUntil('alice', '6.6.6.6') > 0);
  assert.strictEqual(guard.blockedUntil('alice', '10.0.0.5'), 0);   // alice at her own address: open
  assert.strictEqual(guard.blockedUntil('bob', '6.6.6.6'), 0);       // the attacker is only shut out of the account it guessed at
});

test('user names are matched without regard to case', () => {
  guard.reset();
  for (let i = 0; i < N; i++) guard.fail('Alice', '1.1.1.1');
  assert.ok(guard.blockedUntil('ALICE', '1.1.1.1') > 0);
});

test('a correct password clears that address\'s count', () => {
  guard.reset();
  for (let i = 0; i < N - 1; i++) guard.fail('alice', '1.1.1.1');
  guard.clear('alice', '1.1.1.1');
  assert.strictEqual(guard.fail('alice', '1.1.1.1').locked, false);
});

test('the lock ends after the lock time', () => {
  guard.reset();
  const t0 = Date.now();
  for (let i = 0; i < N; i++) guard.fail('alice', '1.1.1.1', t0);
  assert.ok(guard.blockedUntil('alice', '1.1.1.1', t0 + 1000) > 0);
  assert.strictEqual(guard.blockedUntil('alice', '1.1.1.1', t0 + settings.get().lockMinutes * 60000 + 1), 0);
});

test('an Admin unlock lets every address start fresh', () => {
  guard.reset();
  for (let i = 0; i < N; i++) guard.fail('alice', '1.1.1.1');
  guard.clearUser('alice');
  assert.strictEqual(guard.blockedUntil('alice', '1.1.1.1'), 0);
});

test('guessing spread over many addresses raises the distributed flag but locks nobody out of the account', () => {
  guard.reset();
  let flagged = null;
  for (let i = 0; i < N * guard.DISTRIBUTED_FACTOR; i++) {
    const r = guard.fail('alice', `9.9.9.${i % (guard.DISTRIBUTED_IPS + 2)}`);   // few failures per address: none reaches the per-address limit
    if (r.distributed) flagged = r.distributed;
  }
  assert.ok(flagged, 'flagged');
  assert.ok(flagged.ips >= guard.DISTRIBUTED_IPS);
  assert.strictEqual(guard.blockedUntil('alice', '10.0.0.5'), 0);   // the real user can still sign in
});
