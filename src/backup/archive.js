const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');
const { pipeline } = require('stream/promises');
const archiver = require('archiver');
const yauzl = require('yauzl');
const cfg = require('./config');

const FIXED_ENTRIES = new Set(['metadata.json', 'summary.json', 'database.dump', 'checksums.sha256']);
const DIR_ENTRY = /^uploads\/(?:(?:branding|knowledge)\/(?:.+\/)?)?$/;

function isSafeUploadName(name) {
  if (!/^uploads\/(branding|knowledge)\/[^\\\0:]+$/.test(name)) return false;
  return name.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}
const isAllowedEntry = (name) => FIXED_ENTRIES.has(name) || isSafeUploadName(name);

// ---------- Encryption at rest ----------
// File layout: "PCHBENC1" | 12-byte IV | AES-256-GCM ciphertext of the whole .zip | 16-byte auth tag.
// A file is only used after the tag checks out, so a wrong key or a single changed byte is refused, never half-read.
const MAGIC = Buffer.from('PCHBENC1');
const IV_LEN = 12;
const TAG_LEN = 16;
const encKey = () => (cfg.ENC_KEY ? crypto.createHash('sha256').update(`pcshub-backup-v1:${cfg.ENC_KEY}`).digest() : null);
const encryptionOn = () => Boolean(encKey());

async function isEncrypted(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const b = Buffer.alloc(MAGIC.length);
    const { bytesRead } = await fh.read(b, 0, b.length, 0);
    return bytesRead === MAGIC.length && b.equals(MAGIC);
  } finally { await fh.close(); }
}

async function encryptFile(src, dst) {
  const key = encKey();
  if (!key) throw new Error('BACKUP_ENC_KEY is not set');
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = fs.createWriteStream(dst, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, iv]));
  await pipeline(fs.createReadStream(src), cipher, out, { end: false });
  await new Promise((resolve, reject) => out.end(cipher.getAuthTag(), (e) => (e ? reject(e) : resolve())));
}

async function decryptFile(src, dst) {
  const key = encKey();
  if (!key) throw new Error('This backup is encrypted, and BACKUP_ENC_KEY is not set on this server');
  const { size } = await fsp.stat(src);
  if (size < MAGIC.length + IV_LEN + TAG_LEN) throw new Error('Encrypted backup is truncated');
  const fh = await fsp.open(src, 'r');
  const iv = Buffer.alloc(IV_LEN);
  const tag = Buffer.alloc(TAG_LEN);
  try {
    await fh.read(iv, 0, IV_LEN, MAGIC.length);
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
  } finally { await fh.close(); }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(fs.createReadStream(src, { start: MAGIC.length + IV_LEN, end: size - TAG_LEN - 1 }), decipher, fs.createWriteStream(dst, { mode: 0o600 }));
  } catch (e) {
    await fsp.unlink(dst).catch(() => {});
    throw new Error(/auth/i.test(e.message) ? 'Cannot decrypt this backup: wrong BACKUP_ENC_KEY, or the file was changed' : e.message);
  }
}

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

/** Regular files only (symlinks and special files are never backed up). Paths are POSIX-relative to dir. */
async function walk(dir, prefix = '', out = []) {
  let items;
  try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return out; throw e; }
  for (const it of items) {
    const abs = path.join(dir, it.name);
    const rel = prefix ? `${prefix}/${it.name}` : it.name;
    if (it.isDirectory()) await walk(abs, rel, out);
    else if (it.isFile()) {
      const st = await fsp.lstat(abs);
      out.push({ abs, rel, size: st.size });
      if (out.length > cfg.ZIP_MAX_ENTRIES - 10) throw new Error('Too many files to back up');
    }
  }
  return out;
}

function writeZip(outPath, files, texts) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outPath, { mode: 0o600 });
    const zip = archiver('zip', { zlib: { level: 6 } });
    out.on('close', resolve);
    out.on('error', reject);
    zip.on('error', reject);
    zip.on('warning', reject);
    zip.pipe(out);
    for (const [name, content] of Object.entries(texts)) zip.append(content, { name });
    for (const f of files) zip.file(f.abs, { name: f.name, store: !!f.store });
    zip.finalize();
  });
}

const openZip = (file) => new Promise((resolve, reject) => {
  yauzl.open(file, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (e, z) => (e ? reject(e) : resolve(z)));
});
const openStream = (zip, entry) => new Promise((resolve, reject) => {
  zip.openReadStream(entry, (e, s) => (e ? reject(e) : resolve(s)));
});

/**
 * Streams every entry once: validates names/limits and hashes content without extracting to disk.
 * read: entry names to return as text; extract: { entryName: destinationPath } for entries needed on disk.
 * @returns {{entries: {name,size,sha256}[], texts: object, problems: string[]}}
 */
async function scanZip(file, opts = {}) {
  // An encrypted backup is decrypted to a private temporary file for the scan, which is removed straight after
  let plain = file;
  try {
    if (await isEncrypted(file)) {
      const tmpDir = path.join(cfg.BACKUP_DIR, '.tmp');
      await fsp.mkdir(tmpDir, { recursive: true, mode: 0o700 });
      plain = path.join(tmpDir, `dec-${crypto.randomBytes(8).toString('hex')}.zip`);
      await decryptFile(file, plain);
    }
  } catch (e) {
    return { entries: [], texts: {}, problems: [e.message], encrypted: true };
  }
  try {
    const r = await scanPlainZip(plain, opts);
    return { ...r, encrypted: plain !== file };
  } finally {
    if (plain !== file) await fsp.unlink(plain).catch(() => {});
  }
}

async function scanPlainZip(file, { read = [], extract = {} } = {}) {
  const entries = [];
  const texts = {};
  const problems = [];
  const seen = new Set();
  let count = 0;
  let total = 0;
  let zip;
  try {
    zip = await openZip(file);
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', async (entry) => {
        try {
          const name = entry.fileName;
          if (++count > cfg.ZIP_MAX_ENTRIES) throw new Error('Archive has too many entries');
          total += entry.uncompressedSize;
          if (total > cfg.ZIP_MAX_UNCOMPRESSED) throw new Error('Archive expands beyond the allowed size');
          if (name.endsWith('/')) {
            if (!DIR_ENTRY.test(name)) problems.push(`Unexpected directory entry: ${name}`);
          } else if (!isAllowedEntry(name)) {
            problems.push(`Unexpected entry: ${name}`);
          } else if (seen.has(name)) {
            problems.push(`Duplicate entry: ${name}`);
          } else if (entry.isEncrypted()) {
            problems.push(`Encrypted entry not supported: ${name}`);
          } else if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) {
            problems.push(`Symbolic link entry rejected: ${name}`);
          } else {
            seen.add(name);
            if (entry.uncompressedSize > 10 * 1024 * 1024 && entry.compressedSize > 0
              && entry.uncompressedSize / entry.compressedSize > cfg.ZIP_MAX_RATIO) {
              problems.push(`Suspicious compression ratio: ${name}`);
            } else {
              entries.push(await hashEntry(zip, entry, { text: read.includes(name), dest: extract[name], texts }));
            }
          }
          zip.readEntry();
        } catch (e) { reject(e); }
      });
      zip.readEntry();
    });
  } catch (e) {
    problems.push(`Archive unreadable: ${e.message}`);
  } finally {
    if (zip) zip.close();
  }
  return { entries, texts, problems };
}

async function hashEntry(zip, entry, { text, dest, texts }) {
  const stream = await openStream(zip, entry);
  const hash = crypto.createHash('sha256');
  const chunks = text ? [] : null;
  const out = dest ? fs.createWriteStream(dest, { mode: 0o600 }) : null;
  let size = 0;
  const sink = new Writable({
    write(chunk, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      if (size > entry.uncompressedSize) return cb(new Error(`Entry larger than declared: ${entry.fileName}`));
      if (chunks) {
        chunks.push(chunk);
        if (size > cfg.ZIP_MAX_TEXT_BYTES) return cb(new Error(`Metadata entry too large: ${entry.fileName}`));
      }
      return out ? out.write(chunk, cb) : cb();
    },
    final(cb) { return out ? out.end(cb) : cb(); },
  });
  await pipeline(stream, sink);
  if (chunks) texts[entry.fileName] = Buffer.concat(chunks).toString('utf8');
  return { name: entry.fileName, size, sha256: hash.digest('hex') };
}

module.exports = { sha256File, walk, writeZip, scanZip, isAllowedEntry, encryptFile, decryptFile, isEncrypted, encryptionOn };
