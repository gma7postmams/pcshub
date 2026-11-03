// Where an IP address is, looked up OFFLINE in free DB-IP "Lite" (or MaxMind GeoLite2) database files: no address ever leaves this server.
// Country, city and network (the provider / organisation that owns the address, with its AS number). City-level answers are often only
// approximate and a VPN, proxy or mobile network can show another place; private addresses (10.x, 192.168.x ...) have no place at all.
//
// Files: *.mmdb in GEOIP_DIR (default ./data/geoip). Fetch them with  npm run geoip:update  (monthly), or copy GeoLite2-City.mmdb /
// GeoLite2-ASN.mmdb there yourself. Without files every lookup answers null and the screens say how to install them.
// Only a System Admin is ever sent a location (see mapFor); it is never written to the audit log.
const fs = require('fs');
const path = require('path');
const net = require('net');
const maxmind = require('maxmind');

const dir = () => path.resolve(process.env.GEOIP_DIR || path.join(__dirname, '..', 'data', 'geoip'));
const CHECK_MS = 60 * 1000;
const CACHE_MAX = 2000;

let readers = { city: null, asn: null };
let info = { city: null, asn: null };
let stamp = '';
let checked = 0;
let loading = null;
const cache = new Map();

const PRIVATE = new net.BlockList();
[['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15]].forEach(([a, p]) => PRIVATE.addSubnet(a, p, 'ipv4'));
[['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]].forEach(([a, p]) => PRIVATE.addSubnet(a, p, 'ipv6'));

const unmap = (ip) => { const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(String(ip || '')); return m ? m[1] : String(ip || ''); };
const fileStamp = (d) => { try { return fs.readdirSync(d).filter((f) => /\.mmdb$/i.test(f)).sort().map((f) => { const s = fs.statSync(path.join(d, f)); return `${f}:${s.size}:${s.mtimeMs}`; }).join('|'); } catch (_) { return ''; } };

/** Open the database files in the folder. Never throws: a missing or broken file just means no location. */
async function load(d = dir()) {
  const found = { city: null, asn: null };
  let files = [];
  try { files = fs.readdirSync(d).filter((f) => /\.mmdb$/i.test(f)); } catch (_) { /* folder not there yet */ }
  for (const f of files) {
    try {
      const reader = await maxmind.open(path.join(d, f));
      const type = String(reader.metadata.databaseType || '');
      const built = reader.metadata.buildEpoch ? new Date(reader.metadata.buildEpoch) : null;
      const kind = /asn/i.test(type) ? 'asn' : /city|country/i.test(type) ? 'city' : null;
      if (!kind) continue;
      const rank = /city/i.test(type) ? 2 : 1;   // a city database beats a country-only one
      const cur = found[kind];
      if (!cur || rank > cur.rank || (rank === cur.rank && built && cur.built && built > cur.built)) found[kind] = { reader, type, built, file: f, rank };
    } catch (e) { console.warn(`[geoip] could not read ${f}: ${e.message}`); }
  }
  readers = { city: found.city && found.city.reader, asn: found.asn && found.asn.reader };
  info = {
    city: found.city ? { type: found.city.type, built: found.city.built, file: found.city.file, level: found.city.rank === 2 ? 'city' : 'country' } : null,
    asn: found.asn ? { type: found.asn.type, built: found.asn.built, file: found.asn.file } : null,
  };
  stamp = fileStamp(d); checked = Date.now(); cache.clear();
  if (info.city || info.asn) console.log(`[geoip] ${info.city ? `${info.city.level} database ${info.city.file}` : 'no city database'}; ${info.asn ? `network database ${info.asn.file}` : 'no network database'}`);
}

/** Pick up new files (after npm run geoip:update) without a restart: looked at most once a minute. */
function maybeReload() {
  if (loading || Date.now() - checked < CHECK_MS) return;
  checked = Date.now();
  if (fileStamp(dir()) !== stamp) loading = load().finally(() => { loading = null; });
}

const name = (o) => (o && o.names && (o.names.en || Object.values(o.names)[0])) || null;
const EMPTY = { private: false, country: null, countryCode: null, region: null, city: null, asn: null, org: null, network: null };

/** { country, countryCode, region, city, asn, org, network, private } for one address; null when no database is installed. */
function lookup(ip) {
  maybeReload();
  const a = unmap(ip);
  const fam = net.isIP(a);
  if (!fam) return null;
  if (PRIVATE.check(a, fam === 4 ? 'ipv4' : 'ipv6')) return { ...EMPTY, private: true, network: 'Private network' };
  if (!readers.city && !readers.asn) return null;
  if (cache.has(a)) return cache.get(a);
  const out = { ...EMPTY };
  try {
    const c = readers.city && readers.city.get(a);
    if (c) {
      out.country = name(c.country) || name(c.registered_country);
      out.countryCode = (c.country && c.country.iso_code) || null;
      out.region = name(c.subdivisions && c.subdivisions[0]);
      out.city = name(c.city);
    }
    const n = readers.asn && readers.asn.get(a);
    if (n) {
      out.asn = n.autonomous_system_number || null;
      out.org = n.autonomous_system_organization || null;
      out.network = out.org ? `${out.org}${out.asn ? ` (AS${out.asn})` : ''}` : (out.asn ? `AS${out.asn}` : null);
    }
  } catch (_) { /* an address the file cannot answer: leave it blank */ }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(a, out);
  return out;
}

/** "Quezon City, Philippines · Philippine Long Distance Telephone Co. (AS9299)" or '' */
function place(geo) {
  if (!geo) return '';
  if (geo.private) return 'private network';
  const where = [geo.city, geo.country].filter(Boolean).join(', ');
  return [where, geo.network].filter(Boolean).join(' · ');
}

/** Locations for these addresses, for a System Admin only: anybody else gets undefined, so nothing leaks into their response. */
function mapFor(req, ips) {
  if (!req || !req.user || req.user.role !== 'System Admin') return undefined;
  const out = {};
  for (const ip of new Set(ips || [])) { if (!ip) continue; const g = lookup(ip); if (g) out[ip] = g; }
  return out;
}

const status = () => ({ installed: Boolean(info.city || info.asn), city: info.city, asn: info.asn, dir: dir() });

module.exports = { load, lookup, place, mapFor, status, unmap, dir };
