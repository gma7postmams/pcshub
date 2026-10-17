#!/usr/bin/env node
// Download the free DB-IP "Lite" city and ASN databases (monthly files, CC BY 4.0, no account needed) into GEOIP_DIR (default ./data/geoip).
//   npm run geoip:update            both files        node scripts/update-geoip.js --only city|asn   one of them
// Run it once now and monthly after (DB-IP publishes at the start of each month). The app picks up new files within a minute, no restart.
// A failed download never touches the files already there. GEOIP_BASE_URL can point at a mirror (default https://download.db-ip.com/free).
// DB-IP asks for a link back wherever its data is shown: the screens carry "IP Geolocation by DB-IP".
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const maxmind = require('maxmind');

const BASE = (process.env.GEOIP_BASE_URL || 'https://download.db-ip.com/free').replace(/\/+$/, '');
const DIR = path.resolve(process.env.GEOIP_DIR || path.join(__dirname, '..', 'data', 'geoip'));
const EDITIONS = { city: 'city-lite', asn: 'asn-lite' };

function fetchTo(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('http:') ? http : https;
    const req = lib.get(url, { headers: { 'User-Agent': 'pcshub-geoip-update' }, timeout: 60000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume(); return resolve(fetchTo(new URL(res.headers.location, url).toString(), dest, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); const e = new Error(`HTTP ${res.statusCode}`); e.status = res.statusCode; return reject(e); }
      const out = fs.createWriteStream(dest);
      res.pipe(zlib.createGunzip()).on('error', reject).pipe(out).on('error', reject).on('finish', resolve);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

async function one(kind) {
  const edition = EDITIONS[kind];
  const d = new Date();
  for (let back = 0; back < 3; back++) {   // this month's file may not be out yet: try the last two months too
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));
    const ym = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
    const url = `${BASE}/dbip-${edition}-${ym}.mmdb.gz`;
    const tmp = path.join(DIR, `.${edition}.download`);
    try {
      await fetchTo(url, tmp);
      const r = await maxmind.open(tmp);   // must be a readable database of the right kind before it replaces anything
      const type = String(r.metadata.databaseType || '');
      if (!(kind === 'asn' ? /asn/i : /city|country/i).test(type) || !r.metadata.nodeCount) throw new Error(`not a ${kind} database (${type || 'unknown'})`);
      fs.renameSync(tmp, path.join(DIR, `dbip-${edition}.mmdb`));
      console.log(`${kind}: dbip-${edition}-${ym} installed (${type})`);
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* nothing to remove */ }
      if (e.status === 404 && back < 2) continue;
      console.error(`${kind}: ${url} failed: ${e.message}`);
      return false;
    }
  }
  return false;
}

(async () => {
  const i = process.argv.indexOf('--only');
  const kinds = i > 0 && EDITIONS[process.argv[i + 1]] ? [process.argv[i + 1]] : Object.keys(EDITIONS);
  fs.mkdirSync(DIR, { recursive: true });
  const ok = [];
  for (const k of kinds) ok.push(await one(k));
  console.log(ok.every(Boolean) ? `Done: ${DIR}` : 'Some downloads failed; the files already there are unchanged.');
  process.exit(ok.every(Boolean) ? 0 : 1);
})();
