const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const db = require('../db');
const v = require('../validate');
const { asyncH, HttpError, requireAction } = require('../middleware');
const { audit } = require('../audit');

// Mounted behind requirePageAccess('/knowledge') => any group that has the Knowledge Base page checked.
// Anyone who can open the page can read/download the PDFs; uploading, renaming and deleting need the
// 'knowledge.write' action (Admin and Manager roles, and the group must grant the Knowledge Base page).
//
// PDFs are stored on disk under uploads/knowledge/ with random names; the table keeps the real file name.
const router = express.Router();

const DIR = path.join(__dirname, '..', '..', 'uploads', 'knowledge');
const SEED_DIR = path.join(__dirname, '..', '..', 'knowledge-seed');
const MAX_MB = parseInt(process.env.KNOWLEDGE_MAX_MB, 10) || 25;
const MAX_FILES = 10;
fs.mkdirSync(DIR, { recursive: true });

const COLS = 'id, title, filename, size_bytes, uploaded_name, created_at, updated_at';

const upload = multer({
  storage: multer.diskStorage({
    destination: DIR,
    filename: (req, file, cb) => cb(null, `tmp-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`),
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: MAX_FILES },
});

// Turn multer's own errors into clean 4xx answers
const receive = (req, res, next) => upload.array('files', MAX_FILES)(req, res, (err) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, `A file is larger than ${MAX_MB} MB`));
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return next(new HttpError(400, `Upload up to ${MAX_FILES} PDFs at a time`));
  return next(err);
});

const isPdf = (file) => {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(5);
    fs.readSync(fd, head, 0, 5, 0);
    return head.toString('latin1') === '%PDF-';
  } finally { fs.closeSync(fd); }
};

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rm = (file) => fs.unlink(file, () => {});

// busboy hands over names as latin1; recover UTF-8 names (keep the original if that fails)
function cleanName(name) {
  let n = String(name || '');
  try {
    const u = Buffer.from(n, 'latin1').toString('utf8');
    if (!u.includes('\uFFFD')) n = u;
  } catch (e) { /* keep n */ }
  n = path.basename(n.replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim();
  return n.slice(0, 200) || 'document.pdf';
}
const titleFrom = (filename) => filename.replace(/\.pdf$/i, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Untitled';

/** Move a validated temp file into place and record it. Returns the new row. */
async function store(req, tmpPath, filename, size, hash, title) {
  const stored = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.pdf`;
  fs.renameSync(tmpPath, path.join(DIR, stored));
  try {
    const { rows } = await db.query(
      `INSERT INTO knowledge_docs (title, filename, stored_name, size_bytes, sha256, uploaded_by, uploaded_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${COLS}`,
      [title, filename, stored, size, hash, req.user ? req.user.id : null, req.user ? (req.user.full_name || req.user.username) : null]
    );
    return rows[0];
  } catch (e) {
    rm(path.join(DIR, stored));
    throw e;
  }
}

// First visit: put the reference PDFs shipped in knowledge-seed/ into the list once.
// A settings flag means a deleted reference is not brought back.
async function seedOnce(req) {
  const claim = await db.query(
    `INSERT INTO app_settings (key, value) VALUES ('knowledge_seeded', '1') ON CONFLICT (key) DO NOTHING RETURNING key`
  );
  if (!claim.rowCount) return;
  let names = [];
  try { names = fs.readdirSync(SEED_DIR).filter((f) => /\.pdf$/i.test(f)).sort(); } catch (e) { return; }
  for (const name of names) {
    try {
      const tmp = path.join(DIR, `tmp-seed-${crypto.randomBytes(6).toString('hex')}`);
      fs.copyFileSync(path.join(SEED_DIR, name), tmp);
      if (!isPdf(tmp)) { rm(tmp); continue; }
      const hash = sha256(tmp);
      const dup = await db.query('SELECT 1 FROM knowledge_docs WHERE sha256=$1', [hash]);
      if (dup.rowCount) { rm(tmp); continue; }
      const row = await store({ user: null }, tmp, name, fs.statSync(tmp).size, hash, titleFrom(name));
      await audit(req, 'knowledge.seed', 'knowledge_docs', row.id, { filename: name });
    } catch (e) {
      console.error('[knowledge] seed failed for', name, e.message);
    }
  }
}

// Ids are 32-bit in the database: an out-of-range number is simply a document that does not exist.
router.param('id', (req, res, next, raw) => {
  try { req.params.id = v.id(raw); } catch (e) { return res.status(404).json({ error: 'Document not found' }); }
  return next();
});

router.get('/meta', (req, res) => res.json({ ready: true, maxMb: MAX_MB, maxFiles: MAX_FILES }));

router.get('/', asyncH(async (req, res) => {
  await seedOnce(req);
  const { rows } = await db.query(`SELECT ${COLS} FROM knowledge_docs ORDER BY created_at DESC, id DESC`);
  res.json(rows);
}));

// View in the browser (default) or download (?download=1)
router.get('/:id(\\d+)/file', asyncH(async (req, res) => {
  const { rows } = await db.query('SELECT filename, stored_name FROM knowledge_docs WHERE id=$1', [req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Document not found');
  const file = path.join(DIR, path.basename(rows[0].stored_name));
  if (!fs.existsSync(file)) throw new HttpError(404, 'The file is missing on the server');
  const name = /\.pdf$/i.test(rows[0].filename) ? rows[0].filename : `${rows[0].filename}.pdf`;
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-cache',
  });
  res.sendFile(file);
}));

// Drag-and-drop / browse upload: field name "files", up to MAX_FILES PDFs. Each file gets its own result
// so one bad file does not lose the rest.
router.post('/', requireAction('knowledge.write'), receive, asyncH(async (req, res) => {
  const files = req.files || [];
  if (!files.length) throw new HttpError(400, 'No files uploaded');
  const results = [];
  for (const f of files) {
    const filename = cleanName(f.originalname);
    try {
      if (!f.size) { rm(f.path); results.push({ filename, ok: false, error: 'The file is empty' }); continue; }
      if (!isPdf(f.path)) { rm(f.path); results.push({ filename, ok: false, error: 'Not a PDF file' }); continue; }
      const hash = sha256(f.path);
      const dup = await db.query('SELECT id, title FROM knowledge_docs WHERE sha256=$1', [hash]);
      if (dup.rowCount) { rm(f.path); results.push({ filename, ok: false, error: `Already uploaded as "${dup.rows[0].title}"` }); continue; }
      const row = await store(req, f.path, filename, f.size, hash, titleFrom(filename));
      await audit(req, 'knowledge.upload', 'knowledge_docs', row.id, { filename, size: f.size });
      results.push({ filename, ok: true, doc: row });
    } catch (e) {
      rm(f.path);
      console.error('[knowledge] upload failed', e);
      results.push({ filename, ok: false, error: 'Could not save this file' });
    }
  }
  res.status(results.some((r) => r.ok) ? 201 : 400).json({ results });
}));

router.put('/:id(\\d+)', requireAction('knowledge.write'), asyncH(async (req, res) => {
  const title = String((req.body && req.body.title) || '').trim();
  if (!title) throw new HttpError(400, 'Title is required');
  if (title.length > 200) throw new HttpError(400, 'Title is too long (max 200 characters)');
  const { rows } = await db.query(
    `UPDATE knowledge_docs SET title=$1, updated_at=now() WHERE id=$2 RETURNING ${COLS}`, [title, req.params.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Document not found');
  await audit(req, 'knowledge.rename', 'knowledge_docs', rows[0].id, { title });
  res.json(rows[0]);
}));

router.delete('/:id(\\d+)', requireAction('knowledge.write'), asyncH(async (req, res) => {
  const { rows } = await db.query('DELETE FROM knowledge_docs WHERE id=$1 RETURNING id, title, filename, stored_name', [req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Document not found');
  rm(path.join(DIR, path.basename(rows[0].stored_name)));
  await audit(req, 'knowledge.delete', 'knowledge_docs', rows[0].id, { title: rows[0].title, filename: rows[0].filename });
  res.json({ ok: true });
}));

module.exports = router;
