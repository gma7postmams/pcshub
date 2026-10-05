const crypto = require('crypto');
const cfg = require('./config');

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const keyId = (key) => crypto.createHash('sha256').update(`id:${key}`).digest('hex').slice(0, 8);
const mac = (meta, key) => crypto.createHmac('sha256', key).update(canonical({ ...meta, signature: undefined })).digest('hex');

/** Adds an HMAC signature over the whole manifest; unsigned when BACKUP_SIGNING_KEY is not configured. */
function sign(meta) {
  if (!cfg.SIGNING_KEY) return { ...meta, signature: null };
  return { ...meta, signature: { alg: 'HMAC-SHA256', keyId: keyId(cfg.SIGNING_KEY), value: mac(meta, cfg.SIGNING_KEY) } };
}

/** @returns {'valid'|'invalid'|'unsigned'|'no_key'} */
function checkSignature(meta) {
  const sig = meta && meta.signature;
  if (!sig) return 'unsigned';
  if (!cfg.SIGNING_KEY) return 'no_key';
  if (sig.alg !== 'HMAC-SHA256' || sig.keyId !== keyId(cfg.SIGNING_KEY) || !/^[0-9a-f]{64}$/.test(sig.value || '')) return 'invalid';
  const a = Buffer.from(sig.value, 'hex');
  const b = Buffer.from(mac(meta, cfg.SIGNING_KEY), 'hex');
  return crypto.timingSafeEqual(a, b) ? 'valid' : 'invalid';
}

const checksumsText = (list) => `${list.map((f) => `${f.sha256}  ${f.path}`).join('\n')}\n`;

function parseChecksums(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) return null;
    out.set(m[2], m[1]);
  }
  return out;
}

module.exports = { canonical, sign, checkSignature, checksumsText, parseChecksums };
