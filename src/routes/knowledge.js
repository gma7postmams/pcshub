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
const MAX_FILES = 20;   // several PDFs can be added at once; each gets its own name
const TRASH_DAYS = 30;  // a deleted document stays in the Trash this long, then its file is removed
fs.mkdirSync(DIR, { recursive: true });

const COLS = 'id, title, filename, size_bytes, uploaded_name, created_at, updated_at, tags';
const TRASH_COLS = 'id, title, filename, size_bytes, tags, deleted_at, deleted_name';

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
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return next(new HttpError(400, `Upload at most ${MAX_FILES} PDFs at a time`));
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
/** Tags: trimmed, no empties or duplicates (case-insensitive), at most 10 of 30 characters. Accepts an array or a JSON array string. */
function cleanTags(raw) {
  let list = raw;
  if (typeof raw === 'string') { try { list = JSON.parse(raw); } catch (e) { list = raw.split(','); } }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const tag = String(t || '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
    if (out.length >= 10) break;
  }
  return out;
}
const titleFrom = (filename) => filename.replace(/\.pdf$/i, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Untitled';

/** Move a validated temp file into place and record it. Returns the new row. */
async function store(req, tmpPath, filename, size, hash, title, tags = []) {
  const stored = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.pdf`;
  fs.renameSync(tmpPath, path.join(DIR, stored));
  try {
    const { rows } = await db.query(
      `INSERT INTO knowledge_docs (title, filename, stored_name, size_bytes, sha256, uploaded_by, uploaded_name, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${COLS}`,
      [title, filename, stored, size, hash, req.user ? req.user.id : null, req.user ? (req.user.full_name || req.user.username) : null, tags]
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
      const dup = await db.query('SELECT 1 FROM knowledge_docs WHERE sha256=$1', [hash]);   // a seeded reference that was deleted is not brought back
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

router.get('/meta', (req, res) => res.json({ ready: true, maxMb: MAX_MB, maxFiles: MAX_FILES, trashDays: TRASH_DAYS }));

// Remove files that have been in the Trash longer than TRASH_DAYS (run whenever the list or Trash is opened).
async function purgeOldTrash() {
  const { rows } = await db.query(
    `DELETE FROM knowledge_docs WHERE deleted_at IS NOT NULL AND deleted_at < now() - ($1 || ' days')::interval RETURNING stored_name`, [String(TRASH_DAYS)]
  );
  rows.forEach((r) => rm(path.join(DIR, path.basename(r.stored_name))));
}

router.get('/', asyncH(async (req, res) => {
  await seedOnce(req);
  await purgeOldTrash();
  const { rows } = await db.query(`SELECT ${COLS} FROM knowledge_docs WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC`);
  res.json(rows);
}));

// Trash (people who can edit the Knowledge Base): list, restore, delete for good.
router.get('/trash', requireAction('knowledge.write'), asyncH(async (req, res) => {
  await purgeOldTrash();
  const { rows } = await db.query(`SELECT ${TRASH_COLS} FROM knowledge_docs WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC`);
  res.json({ days: TRASH_DAYS, docs: rows });
}));

// View in the browser (default) or download (?download=1)
router.get('/:id(\\d+)/file', asyncH(async (req, res) => {
  const { rows } = await db.query('SELECT filename, stored_name FROM knowledge_docs WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
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

// Drag-and-drop / browse upload: field name "files", up to MAX_FILES PDFs. "titles" is a JSON array of names, one per file
// (a blank or missing one defaults to the file name); "tags" is a JSON array applied to every file in the upload.
// Each file gets its own result so one bad file does not lose the rest.
router.post('/', requireAction('knowledge.write'), receive, asyncH(async (req, res) => {
  const files = req.files || [];
  const discard = () => files.forEach((f) => rm(f.path));
  if (!files.length) throw new HttpError(400, 'No files uploaded');
  let titles = [];
  try { titles = req.body && req.body.titles ? JSON.parse(req.body.titles) : (req.body && req.body.title ? [req.body.title] : []); } catch (e) { discard(); throw new HttpError(400, 'Names could not be read'); }
  if (!Array.isArray(titles)) titles = [];
  const tooLong = titles.find((t) => String(t || '').trim().length > 200);
  if (tooLong !== undefined) { discard(); throw new HttpError(400, 'A title is too long (max 200 characters)'); }
  const tags = cleanTags(req.body && req.body.tags);
  const results = [];
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    const filename = cleanName(f.originalname);
    try {
      const title = String(titles[i] || '').trim() || titleFrom(filename);
      if (!f.size) { rm(f.path); results.push({ filename, ok: false, error: 'The file is empty' }); continue; }
      if (!isPdf(f.path)) { rm(f.path); results.push({ filename, ok: false, error: 'Not a PDF file' }); continue; }
      const hash = sha256(f.path);
      const dup = await db.query('SELECT id, title, deleted_at FROM knowledge_docs WHERE sha256=$1 ORDER BY deleted_at NULLS FIRST LIMIT 1', [hash]);
      if (dup.rowCount) {
        rm(f.path);
        results.push({ filename, ok: false, error: dup.rows[0].deleted_at ? `"${dup.rows[0].title}" is in the Trash — restore it from there` : `Already uploaded as "${dup.rows[0].title}"` });
        continue;
      }
      const row = await store(req, f.path, filename, f.size, hash, title, tags);
      await audit(req, 'knowledge.upload', 'knowledge_docs', row.id, { filename, size: f.size, title, tags });
      results.push({ filename, ok: true, doc: row });
    } catch (e) {
      rm(f.path);
      console.error('[knowledge] upload failed', e);
      results.push({ filename, ok: false, error: 'Could not save this file' });
    }
  }
  res.status(results.some((r) => r.ok) ? 201 : 400).json({ results });
}));

// Rename and / or re-tag: send "title" and / or "tags".
router.put('/:id(\\d+)', requireAction('knowledge.write'), asyncH(async (req, res) => {
  const body = req.body || {};
  const sets = [];
  const params = [];
  const details = {};
  if (body.title !== undefined) {
    const title = String(body.title || '').trim();
    if (!title) throw new HttpError(400, 'Title is required');
    if (title.length > 200) throw new HttpError(400, 'Title is too long (max 200 characters)');
    params.push(title); sets.push(`title=$${params.length}`); details.title = title;
  }
  if (body.tags !== undefined) { const tags = cleanTags(body.tags); params.push(tags); sets.push(`tags=$${params.length}`); details.tags = tags; }
  if (!sets.length) throw new HttpError(400, 'Nothing to change');
  params.push(req.params.id);
  const { rows } = await db.query(`UPDATE knowledge_docs SET ${sets.join(', ')}, updated_at=now() WHERE id=$${params.length} AND deleted_at IS NULL RETURNING ${COLS}`, params);
  if (!rows[0]) throw new HttpError(404, 'Document not found');
  await audit(req, 'knowledge.rename', 'knowledge_docs', rows[0].id, details);
  res.json(rows[0]);
}));

// Delete = move to the Trash (the file stays on the server for TRASH_DAYS and can be restored).
router.delete('/:id(\\d+)', requireAction('knowledge.write'), asyncH(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE knowledge_docs SET deleted_at=now(), deleted_by=$2, deleted_name=$3 WHERE id=$1 AND deleted_at IS NULL RETURNING id, title, filename`,
    [req.params.id, req.user.id, req.user.full_name || req.user.username]
  );
  if (!rows[0]) throw new HttpError(404, 'Document not found');
  await audit(req, 'knowledge.delete', 'knowledge_docs', rows[0].id, { title: rows[0].title, filename: rows[0].filename, to: 'trash' });
  res.json({ ok: true });
}));

router.post('/:id(\\d+)/restore', requireAction('knowledge.write'), asyncH(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE knowledge_docs SET deleted_at=NULL, deleted_by=NULL, deleted_name=NULL, updated_at=now() WHERE id=$1 AND deleted_at IS NOT NULL RETURNING ${COLS}`, [req.params.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Document not found in the Trash');
  await audit(req, 'knowledge.restore', 'knowledge_docs', rows[0].id, { title: rows[0].title, filename: rows[0].filename });
  res.json(rows[0]);
}));

// Delete for good: only from the Trash. The row and the file are removed.
router.delete('/:id(\\d+)/purge', requireAction('knowledge.write'), asyncH(async (req, res) => {
  const { rows } = await db.query('DELETE FROM knowledge_docs WHERE id=$1 AND deleted_at IS NOT NULL RETURNING id, title, filename, stored_name', [req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Document not found in the Trash');
  rm(path.join(DIR, path.basename(rows[0].stored_name)));
  await audit(req, 'knowledge.purge', 'knowledge_docs', rows[0].id, { title: rows[0].title, filename: rows[0].filename });
  res.json({ ok: true });
}));

module.exports = router;
