process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost/none';   // never connected: the date helper does not touch the database
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
process.env.TOTP_ENC_KEY = process.env.TOTP_ENC_KEY || '0'.repeat(64);
const test = require('node:test');
const assert = require('node:assert/strict');
const { episodeRange } = require('../src/routes/ingest');

test('single date', () => {
  assert.deepEqual(episodeRange('2026-10-07'), { text: '2026-10-07', start: '2026-10-07' });
});

test('range keeps start first and stores from/to', () => {
  assert.deepEqual(episodeRange('2026-10-01/2026-10-05'), { text: '2026-10-01/2026-10-05', start: '2026-10-01' });
});

test('a range of one day collapses to a single date', () => {
  assert.deepEqual(episodeRange('2026-10-05/2026-10-05'), { text: '2026-10-05', start: '2026-10-05' });
});

test('end before start is refused', () => {
  assert.throws(() => episodeRange('2026-10-05/2026-10-01'), /end date is before/);
});

test('junk and impossible dates are refused; empty is allowed', () => {
  assert.throws(() => episodeRange('soon'), /valid date/);
  assert.throws(() => episodeRange('2026-10-01/2026-13-40'), /valid date/);
  assert.deepEqual(episodeRange(''), { text: null, start: null });
});
