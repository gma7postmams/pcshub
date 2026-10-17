// IP access rules: parsing, matching, allow-beats-block, expiry, safety rails, CSV / JSON import and export, the middleware.
const test = require('node:test');
const assert = require('node:assert');
require.cache[require.resolve('../src/db')] = { id: 'd', filename: 'd', loaded: true, exports: { query: async () => ({ rows: [] }) } };
const audits = [];
require.cache[require.resolve('../src/audit')] = { id: 'a', filename: 'a', loaded: true, exports: { audit: async (req, action, e, id, d) => { audits.push({ action, d }); } } };
const r = require('../src/ip-rules');
const guard = require('../src/login-guard');
const settings = require('../src/security-settings');

const set = (list) => r._set(list);

test('addresses and ranges are read and tidied; nonsense is refused with a reason', () => {
  assert.strictEqual(r.parseEntry(' 203.0.113.7 ').cidr, '203.0.113.7');
  assert.strictEqual(r.parseEntry('203.0.113.0/24').cidr, '203.0.113.0/24');
  assert.strictEqual(r.parseEntry('2001:DB8::/32').cidr, '2001:db8::/32');
  assert.strictEqual(r.parseEntry('::ffff:10.1.2.3').cidr, '10.1.2.3');   // IPv4-mapped IPv6 is the IPv4 address
  for (const bad of ['', 'abc', '1.2.3', '1.2.3.4/33', '1.2.3.4/x', '1.2.3.4/8/9', '999.1.1.1', 'fe80::1%eth0']) assert.throws(() => r.parseEntry(bad), undefined, bad);
  assert.throws(() => r.parseEntry('0.0.0.0/0'), /too many/);
  assert.throws(() => r.parseEntry('10.0.0.0/7'), /too many/);
  assert.doesNotThrow(() => r.parseEntry('10.0.0.0/8'));
});

test('a block covers its range, in either IPv4 form; an allow entry wins over a block', () => {
  set([{ kind: 'block', cidr: '203.0.113.0/24' }, { kind: 'allow', cidr: '203.0.113.9' }]);
  assert.strictEqual(r.isBlocked('203.0.113.5'), true);
  assert.strictEqual(r.isBlocked('::ffff:203.0.113.5'), true);
  assert.strictEqual(r.isBlocked('203.0.113.9'), false);   // allowed
  assert.strictEqual(r.isAllowed('203.0.113.9'), true);
  assert.strictEqual(r.isBlocked('198.51.100.1'), false);
  assert.strictEqual(r.isBlocked('not-an-ip'), false);
});

test('IPv6 ranges work', () => {
  set([{ kind: 'block', cidr: '2001:db8::/32' }]);
  assert.strictEqual(r.isBlocked('2001:db8:1::5'), true);
  assert.strictEqual(r.isBlocked('2001:db9::5'), false);
});

test('an entry stops applying when it expires', () => {
  set([{ kind: 'block', cidr: '203.0.113.7', expires_at: new Date(Date.now() + 50).toISOString() }]);
  assert.strictEqual(r.isBlocked('203.0.113.7'), true);
  return new Promise((res) => setTimeout(() => { assert.strictEqual(r.isBlocked('203.0.113.7'), false); res(); }, 80));
});

test('a block may not cover the person adding it, the proxy, or localhost', () => {
  assert.throws(() => r.check('block', '203.0.113.0/24', { self: ['203.0.113.50'] }), /your own address/);
  assert.throws(() => r.check('block', '127.0.0.1'), /localhost/);
  assert.throws(() => r.check('block', '::1'), /localhost/);
  assert.doesNotThrow(() => r.check('block', '198.51.100.0/24', { self: ['203.0.113.50'] }));
  assert.doesNotThrow(() => r.check('allow', '127.0.0.1'));   // allowing yourself is fine
  assert.throws(() => r.check('maybe', '1.2.3.4'), /block or allow/);
});

test('expiry must be a future date', () => {
  assert.strictEqual(r.parseExpiry(''), null);
  assert.ok(r.parseExpiry(new Date(Date.now() + 3600e3).toISOString()));
  assert.throws(() => r.parseExpiry('2001-01-01'), /past/);
  assert.throws(() => r.parseExpiry('soon'), /not a date/);
});

test('CSV import: header row, quotes, comments, default list, and every bad row is reported', () => {
  const csv = 'ip,list,note,expires\n203.0.113.7,block,"scanner, noisy",\n198.51.100.0/24,allow,Office,\n# a comment\nnope,block,,\n10.0.0.0/4,block,,\n203.0.113.7,block,again,\n';
  const p = r.parseImport(csv, { self: [] });
  assert.strictEqual(p.entries.length, 2);
  assert.strictEqual(p.duplicates, 1);
  assert.strictEqual(p.entries.find((e) => e.cidr === '203.0.113.7').note, 'again');   // the later row wins
  assert.deepStrictEqual(p.errors.map((e) => e.value), ['nope', '10.0.0.0/4']);
  assert.ok(p.errors.every((e) => e.line >= 1 && e.error));
});

test('CSV without a header: one address per line takes the chosen list; without one it is refused row by row', () => {
  const p = r.parseImport('203.0.113.7\n198.51.100.8\n', { defaultList: 'block' });
  assert.deepStrictEqual(p.entries.map((e) => e.kind), ['block', 'block']);
  const q = r.parseImport('203.0.113.7\n', {});
  assert.strictEqual(q.entries.length, 0);
  assert.match(q.errors[0].error, /No list/);
  const s = r.parseImport('203.0.113.7;allow;mine\n', {});   // semicolons (Excel in some countries)
  assert.strictEqual(s.entries[0].kind, 'allow');
});

test('JSON import: an array of entries, or { block: [...], allow: [...] }', () => {
  const a = r.parseImport('[{"ip":"203.0.113.0/24","list":"block","note":"x"},"198.51.100.7"]', { defaultList: 'allow' });
  assert.deepStrictEqual(a.entries.map((e) => [e.cidr, e.kind]), [['203.0.113.0/24', 'block'], ['198.51.100.7', 'allow']]);
  const b = r.parseImport('{"block":["203.0.113.1"],"whitelist":[{"address":"198.51.100.2","reason":"vpn"}]}', {});
  assert.deepStrictEqual(b.entries.map((e) => [e.cidr, e.kind, e.note]), [['203.0.113.1', 'block', null], ['198.51.100.2', 'allow', 'vpn']]);
  assert.throws(() => r.parseImport('{"oops":[1]}', {}), /Unexpected key/);
  assert.throws(() => r.parseImport('[{bad json', {}), /valid JSON/);
  assert.throws(() => r.parseImport('   ', {}), /empty/);
});

test('an import cannot block the person doing it', () => {
  const p = r.parseImport('203.0.113.50,block\n198.51.100.1,block\n', { self: ['203.0.113.50'] });
  assert.strictEqual(p.entries.length, 1);
  assert.match(p.errors[0].error, /your own address/);
});

test('export then import gives back the same entries; spreadsheet formulas in a note are defused', () => {
  const list = [
    { cidr: '203.0.113.0/24', kind: 'block', note: '=HYPERLINK("http://evil")', expires_at: null, created_by: 'Jun', created_at: '2026-10-17T00:00:00Z' },
    { cidr: '198.51.100.7', kind: 'allow', note: 'Office, main', expires_at: null, created_by: 'Jun', created_at: '2026-10-17T00:00:00Z' },
  ];
  const csv = r.toCsv(list);
  assert.match(csv, /'=HYPERLINK/);
  const back = r.parseImport(csv, {});
  assert.deepStrictEqual(back.entries.map((e) => [e.cidr, e.kind]), [['203.0.113.0/24', 'block'], ['198.51.100.7', 'allow']]);
  const json = r.parseImport(r.toJson(list), {});
  assert.strictEqual(json.entries.length, 2);
  assert.strictEqual(json.errors.length, 0);
});

test('a file with more than the limit is refused', () => {
  assert.throws(() => r.parseImport(Array.from({ length: r.MAX_RULES + 1 }, (_, i) => `10.${i >> 8 & 255}.${i & 255}.1,block`).join('\n'), {}), /At most/);
});

const call = (ip) => { const out = { code: 200, next: false }; const res = { status(c) { out.code = c; return this; }, set() { return this; }, type() { return this; }, send(b) { out.body = b; } }; r.middleware({ ip, method: 'GET', originalUrl: '/api/x?y=1' }, res, () => { out.next = true; }); return out; };

test('the middleware answers 403 to a blocked address, lets everyone else through, and audits once', async () => {
  set([{ kind: 'block', cidr: '203.0.113.0/24' }]);
  audits.length = 0;
  assert.strictEqual(call('203.0.113.5').code, 403);
  assert.strictEqual(call('203.0.113.5').code, 403);
  assert.strictEqual(call('198.51.100.1').next, true);
  await new Promise((x) => setImmediate(x));
  assert.strictEqual(audits.filter((a) => a.action === 'security.ip_blocked').length, 1);
  process.env.IP_RULES_DISABLE = 'true';
  assert.strictEqual(call('203.0.113.5').next, true);   // the escape hatch
  delete process.env.IP_RULES_DISABLE;
});

test('an allowed address is never shut out by wrong passwords, and the lock list can be read and cleared', () => {
  const N = settings.get().lockAfterFailures;
  set([{ kind: 'allow', cidr: '198.51.100.7' }]);
  guard.reset();
  for (let i = 0; i < N * 3; i++) assert.strictEqual(guard.fail('alice', '198.51.100.7').locked, false);
  assert.strictEqual(guard.blockedUntil('alice', '198.51.100.7'), 0);
  for (let i = 0; i < N; i++) guard.fail('alice', '203.0.113.99');
  assert.deepStrictEqual(guard.list().map((a) => [a.user, a.ip]), [['alice', '203.0.113.99']]);
  assert.strictEqual(guard.unblock('alice', '203.0.113.99'), true);
  assert.strictEqual(guard.list().length, 0);
  set([]);
});
