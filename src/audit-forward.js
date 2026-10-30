// Sends the protected audit lines (auth.*, security.*, admin.*) to a syslog server on ANOTHER machine as they happen, so an intruder who takes over
// this server still cannot erase what they did: the copy is already somewhere else.
//   AUDIT_SYSLOG=udp://10.0.0.5:514        (or tcp://host:514, or tls://host:6514 for an encrypted link)
//   AUDIT_SYSLOG_ALL=true                  also send ordinary audit lines (default: only the protected ones, the same lines the server log gets)
//   AUDIT_SYSLOG_APP=pulse                 the program name in each message
// Format: RFC 5424 syslog, facility "log audit" (13), the line itself as one JSON object. TCP and TLS send one message per line and reconnect
// by themselves; messages wait in memory (up to 1000) while the server is unreachable. This never slows or breaks the app: failures are only counted
// (Administration → Security → self-check shows them).
const dgram = require('dgram');
const net = require('net');
const tls = require('tls');
const os = require('os');

const QUEUE_MAX = 1000;
const state = { sent: 0, dropped: 0, lastError: null, lastOkAt: null };
let sock = null;          // tcp / tls socket
let udp = null;
let connecting = false;
let queue = [];
let retryAt = 0;
let cached = null;

function target() {
  const raw = String(process.env.AUDIT_SYSLOG || '').trim();
  if (!raw) return null;
  if (cached && cached.raw === raw) return cached.t;
  const m = /^(udp|tcp|tls):\/\/(\[[^\]]+\]|[^:/]+)(?::(\d{1,5}))?$/i.exec(raw);
  const t = m ? { proto: m[1].toLowerCase(), host: m[2].replace(/^\[|\]$/g, ''), port: Number(m[3]) || (m[1].toLowerCase() === 'tls' ? 6514 : 514) } : { invalid: true };
  cached = { raw, t };
  return t;
}
const configured = () => { const t = target(); return Boolean(t && !t.invalid); };
const all = () => String(process.env.AUDIT_SYSLOG_ALL || '').toLowerCase() === 'true';

const sevOf = (action) => (/^security\.(alert|malware_blocked)$/.test(action) ? 3 : /^security\./.test(action) ? 4 : /^auth\.(login_failed|locked|2fa_failed|reauth_failed)/.test(action) ? 5 : 6);
const clean = (s, n) => String(s || '-').replace(/[^\x21-\x7e]/g, '_').slice(0, n) || '-';

/** One syslog line (RFC 5424) for an audit entry { at, action, ... }. */
function format(entry) {
  const pri = 13 * 8 + sevOf(entry.action || '');
  return `<${pri}>1 ${entry.at || new Date().toISOString()} ${clean(os.hostname(), 255)} ${clean(process.env.AUDIT_SYSLOG_APP || 'pulse', 48)} ${process.pid} ${clean(entry.action, 32)} - ${JSON.stringify(entry).replace(/[\r\n]+/g, ' ')}`;
}

function fail(e) { state.lastError = String((e && e.message) || e).slice(0, 200); }
function ok() { state.lastOkAt = new Date().toISOString(); state.lastError = null; }

function flush() {
  if (!sock || sock.destroyed || !sock.writable || sock.connecting) return;
  while (queue.length) {
    const msg = queue.shift();
    if (!sock.write(`${msg}\n`)) { /* the socket buffers it; keep going */ }
    state.sent++;
  }
}

function connect(t) {
  if (connecting || (sock && !sock.destroyed) || Date.now() < retryAt) return;
  connecting = true;
  const onUp = () => { connecting = false; ok(); flush(); };
  const s = t.proto === 'tls' ? tls.connect({ host: t.host, port: t.port, servername: net.isIP(t.host) ? undefined : t.host }, onUp) : net.connect({ host: t.host, port: t.port }, onUp);
  s.setKeepAlive(true, 30000);
  s.on('error', (e) => { fail(e); });
  s.on('close', () => { connecting = false; if (sock === s) sock = null; retryAt = Date.now() + 5000; });
  sock = s;
}

/** Hand one audit entry over. Returns at once; never throws. */
function send(entry) {
  try {
    const t = target();
    if (!t || t.invalid) return;
    const msg = format(entry);
    if (t.proto === 'udp') {
      if (!udp) { udp = dgram.createSocket(net.isIPv6(t.host) ? 'udp6' : 'udp4'); udp.on('error', fail); udp.unref(); }
      udp.send(Buffer.from(msg), t.port, t.host, (e) => { if (e) { fail(e); state.dropped++; } else { state.sent++; ok(); } });
      return;
    }
    if (queue.length >= QUEUE_MAX) { queue.shift(); state.dropped++; }
    queue.push(msg);
    connect(t);
    flush();
  } catch (e) { fail(e); }
}

/** For the self-check and tests. */
function status() {
  const t = target();
  return { configured: configured(), invalid: Boolean(t && t.invalid), target: configured() ? `${t.proto}://${t.host}:${t.port}` : null, queued: queue.length, ...state, connected: Boolean(sock && !sock.destroyed && sock.writable && !sock.connecting) };
}

function _reset() { if (sock) sock.destroy(); if (udp) { try { udp.close(); } catch (_) { /* closed */ } } sock = null; udp = null; connecting = false; queue = []; retryAt = 0; cached = null; Object.assign(state, { sent: 0, dropped: 0, lastError: null, lastOkAt: null }); }

module.exports = { send, status, configured, format, all, _reset };
