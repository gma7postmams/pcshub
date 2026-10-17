// Offline location lookup: country, city and network from database files; private addresses; System Admin only; no files = no location.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures');
const geo = require('../src/geoip');

test('without database files there is no location (and nothing breaks)', async () => {
  await geo.load(path.join(os.tmpdir(), 'no-such-geoip-dir'));
  assert.strictEqual(geo.status().installed, false);
  assert.strictEqual(geo.lookup('203.0.113.9'), null);
  assert.strictEqual(geo.place(null), '');
  assert.strictEqual(geo.lookup('not an ip'), null);
});

test('country, city and network come from the city and network files', async () => {
  await geo.load(FIX);
  assert.strictEqual(geo.status().installed, true);
  const g = geo.lookup('203.0.113.9');
  assert.strictEqual(g.country, 'Philippines');
  assert.strictEqual(g.countryCode, 'PH');
  assert.strictEqual(g.city, 'Quezon City');
  assert.strictEqual(g.region, 'Metro Manila');
  assert.strictEqual(g.asn, 9299);
  assert.strictEqual(g.network, 'Philippine Long Distance Telephone Co. (AS9299)');
  assert.strictEqual(geo.place(g), 'Quezon City, Philippines · Philippine Long Distance Telephone Co. (AS9299)');
  assert.strictEqual(geo.lookup('::ffff:198.51.100.7').city, 'Ashburn');   // the IPv4-in-IPv6 form is the same address
  assert.strictEqual(geo.lookup('2001:db8::1').country, 'Japan');
});

test('an address the files do not know is "unknown", not an error', async () => {
  await geo.load(FIX);
  const g = geo.lookup('8.8.8.8');
  assert.ok(g && !g.private);
  assert.strictEqual(g.country, null);
  assert.strictEqual(g.city, null);
  assert.strictEqual(g.network, null);
});

test('private and local addresses are labelled, never looked up', async () => {
  await geo.load(FIX);
  for (const ip of ['10.1.2.3', '192.168.0.9', '172.16.5.5', '172.31.255.1', '127.0.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fd12:3456::1', 'fe80::1', '::ffff:10.0.0.5']) {
    const g = geo.lookup(ip);
    assert.strictEqual(g.private, true, ip);
    assert.strictEqual(g.network, 'Private network', ip);
    assert.strictEqual(g.city, null, ip);
  }
  assert.strictEqual(geo.lookup('172.32.0.1').private, false);   // just outside 172.16/12
  assert.strictEqual(geo.place(geo.lookup('10.0.0.1')), 'private network');
});

test('locations are handed to a System Admin only', async () => {
  await geo.load(FIX);
  const ips = ['203.0.113.9', '203.0.113.9', '', null, '10.0.0.1'];
  const m = geo.mapFor({ user: { role: 'System Admin' } }, ips);
  assert.deepStrictEqual(Object.keys(m).sort(), ['10.0.0.1', '203.0.113.9']);
  assert.strictEqual(m['203.0.113.9'].city, 'Quezon City');
  for (const role of ['Admin', 'Manager', 'User', 'Viewer', undefined]) assert.strictEqual(geo.mapFor({ user: { role } }, ips), undefined, String(role));
  assert.strictEqual(geo.mapFor({}, ips), undefined);        // not signed in
  assert.strictEqual(geo.mapFor(undefined, ips), undefined);
});

test('a country-only file still gives a country, and a city file wins when both are there', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-'));
  fs.copyFileSync(path.join(FIX, 'geo-city.mmdb'), path.join(d, 'a-city.mmdb'));
  await geo.load(d);
  assert.strictEqual(geo.status().city.level, 'city');   // DBIP-City-Lite
  assert.strictEqual(geo.status().asn, null);
  const g = geo.lookup('203.0.113.9');
  assert.strictEqual(g.city, 'Quezon City');
  assert.strictEqual(g.network, null);                    // no network file: that part stays empty
  fs.rmSync(d, { recursive: true, force: true });
});

test('a broken file is ignored with the others still working', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-'));
  fs.writeFileSync(path.join(d, 'broken.mmdb'), 'this is not a database');
  fs.copyFileSync(path.join(FIX, 'geo-asn.mmdb'), path.join(d, 'asn.mmdb'));
  await geo.load(d);
  assert.strictEqual(geo.status().asn.file, 'asn.mmdb');
  assert.strictEqual(geo.lookup('198.51.100.1').network, 'Amazon.com, Inc. (AS14618)');
  fs.rmSync(d, { recursive: true, force: true });
});
