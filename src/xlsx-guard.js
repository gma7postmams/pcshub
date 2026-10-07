// An .xlsx file is a zip archive. Before the spreadsheet library unpacks an upload into memory, this walks the
// archive and refuses anything that is not a plausible workbook: wrong file type, too many parts, or content that
// expands far beyond what a real tracker file needs (a "zip bomb" a few MB in size would otherwise be unpacked whole).
// Sizes are measured by actually inflating each part against a hard ceiling; the sizes written in the archive's own
// headers are never trusted.
//
// The spreadsheet library needs roughly 10-15x the unpacked sheet size in memory while it reads, so the ceilings are
// deliberately modest, and imports are handled one at a time (oneImportAtATime) so several cannot pile up.
const yauzl = require('yauzl');
const { HttpError } = require('./middleware');

const mb = (v, def) => (Number.isFinite(parseInt(v, 10)) && parseInt(v, 10) > 0 ? parseInt(v, 10) : def) * 1024 * 1024;
const LIMITS = {
  entries: 2000,                                            // parts inside the workbook (a normal one has a few dozen)
  total: mb(process.env.IMPORT_MAX_UNPACKED_MB, 40),        // everything unpacked
  entry: mb(process.env.IMPORT_MAX_SHEET_MB, 25),           // any single part (one worksheet's XML)
};

const BAD = 'That file is not a valid Excel workbook (.xlsx)';
const TOO_BIG = 'That workbook is too large to import. Split it into smaller files.';

const open = (buf) => new Promise((resolve, reject) => {
  // decodeStrings: false = names are left as raw bytes: nothing is ever written to disk here, so odd but harmless
  // names (a leading slash, backslashes) written by some spreadsheet tools are not a reason to refuse the file.
  yauzl.fromBuffer(buf, { lazyEntries: true, validateEntrySizes: true, decodeStrings: false }, (e, z) => (e ? reject(e) : resolve(z)));
});

/** Throws HttpError 400 / 413 unless `buf` is a well-formed .xlsx within the limits. `name` is the uploaded file name. */
async function assertSafeXlsx(buf, name) {
  if (name && !/\.xls[xm]$/i.test(String(name))) throw new HttpError(400, 'Upload an Excel workbook saved as .xlsx');
  // zip local-file signature "PK\x03\x04" (also rules out the old binary .xls format and renamed files)
  if (!Buffer.isBuffer(buf) || buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new HttpError(400, BAD);

  let zip;
  try { zip = await open(buf); } catch (e) { throw new HttpError(400, BAD); }
  if (zip.entryCount > LIMITS.entries) { zip.close(); throw new HttpError(413, TOO_BIG); }

  let total = 0;
  let sawWorkbook = false;
  await new Promise((resolve, reject) => {
    const stop = (err) => { try { zip.close(); } catch (e) { /* already closed */ } reject(err); };
    zip.on('error', () => stop(new HttpError(400, BAD)));
    zip.on('end', resolve);
    zip.on('entry', (entry) => {
      const name = entry.fileName.toString('utf8').replace(/\\/g, '/').replace(/^\/+/, '');
      if (name === '[Content_Types].xml' || /^xl\/workbook\.xml$/i.test(name)) sawWorkbook = true;
      if (/\/$/.test(name)) return zip.readEntry();
      if (entry.isEncrypted && entry.isEncrypted()) return stop(new HttpError(400, 'Password-protected workbooks cannot be imported'));
      if (entry.uncompressedSize > LIMITS.entry || total + entry.uncompressedSize > LIMITS.total) return stop(new HttpError(413, TOO_BIG));
      return zip.openReadStream(entry, (err, stream) => {
        if (err) return stop(new HttpError(400, BAD));
        let size = 0;
        stream.on('data', (chunk) => {
          size += chunk.length;
          total += chunk.length;
          if (size > LIMITS.entry || total > LIMITS.total) { stream.destroy(); stop(new HttpError(413, TOO_BIG)); }
        });
        stream.on('error', () => stop(new HttpError(400, BAD)));
        stream.on('end', () => zip.readEntry());
        return undefined;
      });
    });
    zip.readEntry();
  });
  if (!sawWorkbook) throw new HttpError(400, BAD);
}

// One import at a time for the whole server. Put it after the upload middleware (the file is already received) and
// before the handler; a second import arriving meanwhile is told to retry instead of doubling the memory in use.
let importing = false;
function oneImportAtATime(req, res, next) {
  if (importing) return res.status(429).json({ error: 'Another import is being processed. Try again in a moment.' });
  importing = true;
  let released = false;
  const release = () => { if (!released) { released = true; importing = false; } };
  res.once('finish', release);
  res.once('close', release);
  return next();
}

module.exports = { assertSafeXlsx, oneImportAtATime, LIMITS };
