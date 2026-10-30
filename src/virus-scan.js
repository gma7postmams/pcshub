// Virus scan for every uploaded file (Ingest, Plug List and Workload imports, Knowledge Base, profile pictures, logos, backup ZIPs).
//
// The scan is done by ClamAV's daemon (clamd), which must run on this server or on one the app can reach. Nothing is installed in the app itself:
//   sudo apt install clamav-daemon clamav-freshclam      (freshclam keeps the virus signatures up to date)
//   CLAMAV_SOCKET=/var/run/clamav/clamd.ctl              or  CLAMAV_HOST=127.0.0.1  CLAMAV_PORT=3310        (in .env)
// With neither set, scanning is off and the Security self-check says so.
//
// How a file is judged:
//   clean            continues as before
//   infected         refused (422), the temporary file is deleted, the attempt is written to the audit log and the System Admins are alerted
//   scanner down     refused (503) by default, because a file that could not be checked is not known to be safe; CLAMAV_FAIL=open lets it through
//                    (audited) when you prefer uploads to keep working over the scan
//   too large        clamd only reads CLAMAV_MAX_MB per file (its StreamMaxLength, 25 MB unless raised in clamd.conf). A bigger file is accepted but
//                    audited as "not scanned"; set CLAMAV_MAX_MB to the same value as clamd.conf's StreamMaxLength. CLAMAV_LARGE=block refuses them.
//   encrypted backup (.zip.enc) cannot be read by a scanner; it is signed by this server's own key and checked by the restore analysis instead.
const net = require('net');
const fs = require('fs');

const env = (k, d) => (process.env[k] && String(process.env[k]).trim() ? String(process.env[k]).trim() : d);
const num = (k, d) => (Number.isFinite(parseInt(process.env[k], 10)) && parseInt(process.env[k], 10) > 0 ? parseInt(process.env[k], 10) : d);

const target = () => {
  const socket = env('CLAMAV_SOCKET', '');
  if (socket) return { path: socket };
  const host = env('CLAMAV_HOST', '');
  return host ? { host, port: num('CLAMAV_PORT', 3310) } : null;
};
const enabled = () => Boolean(target()) && env('CLAMAV_MODE', 'on').toLowerCase() !== 'off';
const failOpen = () => env('CLAMAV_FAIL', 'closed').toLowerCase() === 'open';
const blockLarge = () => env('CLAMAV_LARGE', 'allow').toLowerCase() === 'block';
const maxBytes = () => num('CLAMAV_MAX_MB', 25) * 1024 * 1024;
const timeoutMs = () => num('CLAMAV_TIMEOUT_SECONDS', 60) * 1000;

// The standard EICAR anti-virus test string (harmless; every scanner reports it). Written in two pieces so this file is not itself flagged.
const EICAR = Buffer.from(['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''));

/** One conversation with clamd: send `command` (and optionally a stream of chunks), return its answer text. Rejects when it cannot be reached. */
function talk(command, chunks) {
  const t = target();
  if (!t) return Promise.reject(new Error('The virus scanner is not set up'));
  return new Promise((resolve, reject) => {
    const sock = net.connect(t);
    let out = '';
    let done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); if (err) reject(err); else resolve(val); };
    const timer = setTimeout(() => finish(new Error('The virus scanner did not answer in time')), timeoutMs());
    sock.on('data', (d) => { out += d.toString('utf8'); if (out.includes('\0') || out.endsWith('\n')) finish(null, out.replace(/\0|\n/g, '').trim()); });
    sock.on('end', () => finish(out ? null : new Error('The virus scanner closed the connection'), out.replace(/\0|\n/g, '').trim()));
    sock.on('error', (e) => { if (out) finish(null, out.replace(/\0|\n/g, '').trim()); else finish(e); });   // clamd may answer ("size limit exceeded") and hang up while we are still sending
    sock.on('connect', async () => {
      try {
        sock.write(`z${command}\0`);
        if (chunks) {
          for await (const c of chunks) {
            for (let i = 0; i < c.length; i += 65536) {
              const part = c.subarray(i, i + 65536);
              const head = Buffer.alloc(4); head.writeUInt32BE(part.length);
              if (!sock.write(Buffer.concat([head, part]))) await new Promise((r) => sock.once('drain', r));
            }
          }
          sock.write(Buffer.alloc(4));   // a zero-length chunk ends the stream
        }
      } catch (e) { if (!done && !out) finish(e); }
    });
  });
}

/** clamd's answer -> { status: 'clean' | 'infected' | 'error', signature?, message? } */
function parse(answer) {
  const s = String(answer || '');
  if (/^stream: OK$/i.test(s)) return { status: 'clean' };
  const m = /^(?:stream: )?(.+) FOUND$/i.exec(s);
  if (m) return { status: 'infected', signature: m[1].trim() };
  return { status: 'error', message: s || 'No answer from the virus scanner' };
}

async function* bufferChunks(buf) { yield buf; }

/** Scan bytes held in memory. */
const scanBuffer = async (buf) => parse(await talk('INSTREAM', bufferChunks(buf)));
/** Scan a file on disk (streamed, never read into memory whole). */
const scanFile = async (file) => parse(await talk('INSTREAM', fs.createReadStream(file)));

const ping = async () => (await talk('PING')) === 'PONG';
const version = () => talk('VERSION');

/** What an Admin should know: is it on, does it answer, how old are the signatures. Never throws. */
async function status() {
  if (!enabled()) return { enabled: false, configured: Boolean(target()) };
  try {
    const ver = await version();   // "ClamAV 1.0.5/27345/Tue Oct 28 08:32:11 2026"
    const m = /^(ClamAV [^/]+)\/(\d+)\/(.+)$/.exec(ver);
    const dbDate = m ? new Date(m[3]) : null;
    const test = await scanBuffer(EICAR);
    return {
      enabled: true, configured: true, reachable: true, version: m ? m[1] : ver, signatures: m ? Number(m[2]) : null,
      databaseAt: dbDate && !Number.isNaN(dbDate.getTime()) ? dbDate.toISOString() : null,
      detectsTestFile: test.status === 'infected', failOpen: failOpen(),
    };
  } catch (e) {
    return { enabled: true, configured: true, reachable: false, error: e.message, failOpen: failOpen() };
  }
}

// ---------- The upload guard ----------

/** Every file multer has handed over: { name, size, buffer?, path? } */
function filesOf(req) {
  const list = [];
  const add = (f) => { if (f && (f.buffer || f.path)) list.push({ name: f.originalname || f.filename || 'file', size: f.size != null ? f.size : (f.buffer ? f.buffer.length : 0), buffer: f.buffer, path: f.path, src: f }); };
  if (req.file) add(req.file);
  if (Array.isArray(req.files)) req.files.forEach(add);
  else if (req.files && typeof req.files === 'object') Object.values(req.files).forEach((a) => (Array.isArray(a) ? a : [a]).forEach(add));
  return list;
}
const dropFiles = (files) => Promise.all(files.filter((f) => f.path).map((f) => fs.promises.unlink(f.path).catch(() => {})));
const seenDown = { at: 0 };

/**
 * Express middleware, placed straight after multer: nothing reaches a route's own code before it has been scanned.
 *   router.post('/import', upload.single('file'), virusScan, handler)
 */
async function guard(req, res, next) {
  if (!enabled()) return next();
  const files = filesOf(req);
  if (!files.length) return next();
  const audit = (action, details) => { try { require('./audit').audit(req, action, 'security', null, { route: `${req.method} ${(req.originalUrl || '').split('?')[0]}`, ...details }).catch(() => {}); } catch (_) { /* best effort */ } };
  const refuse = async (status, error) => { await dropFiles(files); return res.status(status).json({ error }); };
  try {
    for (const f of files) {
      if (/\.enc$/i.test(f.name)) { audit('security.scan_skipped', { file: f.name, reason: 'encrypted backup' }); continue; }
      if (f.size > maxBytes()) {
        if (blockLarge()) { audit('security.scan_skipped', { file: f.name, size: f.size, reason: 'too large to scan', refused: true }); return refuse(413, `"${f.name}" is too large to be checked for viruses`); }
        audit('security.scan_skipped', { file: f.name, size: f.size, reason: 'too large to scan' });
        continue;
      }
      let r;
      try { r = f.buffer ? await scanBuffer(f.buffer) : await scanFile(f.path); } catch (e) { r = { status: 'error', message: e.message, down: true }; }
      if (r.status === 'infected') {
        console.warn(`[security] virus found in upload "${f.name}": ${r.signature} (${req.ip}${req.user ? `, ${req.user.username}` : ''})`);
        audit('security.malware_blocked', { file: f.name, size: f.size, signature: r.signature });
        require('./security-watch').malware(req, f.name, r.signature);
        return refuse(422, `"${f.name}" was rejected: the virus scanner found ${r.signature}.`);
      }
      if (r.status === 'error') {
        const now = Date.now();
        if (now - seenDown.at > 15 * 60 * 1000) { seenDown.at = now; require('./security-watch').scannerDown(r.message); }   // one alert per 15 minutes, not one per upload
        audit('security.scan_failed', { file: f.name, reason: String(r.message).slice(0, 200), refused: !failOpen() });
        if (!failOpen()) return refuse(503, 'The virus scanner is not available right now, so the file was not accepted. Try again in a few minutes, or ask a System Admin.');
      }
    }
  } catch (e) {
    await dropFiles(files);
    return next(e);
  }
  return next();
}

module.exports = { enabled, target, status, scanBuffer, scanFile, ping, version, guard, filesOf, parse, EICAR, maxBytes };
