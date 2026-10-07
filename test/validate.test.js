process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost/none';   // never connected
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
process.env.TOTP_ENC_KEY = process.env.TOTP_ENC_KEY || '0'.repeat(64);
const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/validate');

test('date: real calendar dates only', () => {
  assert.equal(v.date('2026-10-07', { field: 'D' }), '2026-10-07');
  assert.equal(v.date('', { field: 'D' }), null);
  assert.throws(() => v.date('2026-02-30', { field: 'D' }), /valid date/);
  assert.throws(() => v.date('07/10/2026', { field: 'D' }), /valid date/);
  assert.throws(() => v.date('', { field: 'D', required: true }), /required/);
});

test('str: trims, empty is null, enforces max and required', () => {
  assert.equal(v.str('  hi ', { field: 'S' }), 'hi');
  assert.equal(v.str('   ', { field: 'S' }), null);
  assert.throws(() => v.str('x'.repeat(11), { field: 'S', max: 10 }), /at most 10/);
  assert.throws(() => v.str('', { field: 'S', required: true }), /required/);
  assert.throws(() => v.str({ a: 1 }, { field: 'S' }), /must be text/);
});

test('int: rejects non-integers and values beyond 32 bits', () => {
  assert.equal(v.int('42', { field: 'I' }), 42);
  assert.throws(() => v.int('4.5', { field: 'I' }), /integer/);
  assert.throws(() => v.int('99999999999', { field: 'I' }), /integer/);
  assert.throws(() => v.int('-1', { field: 'I', min: 0 }), /integer/);
});
