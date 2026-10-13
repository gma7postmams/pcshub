// "Fill from team workbook": reads the team's original per-day workload workbook (one sheet per day per section, "SEP 10_main",
// "SEP 10_backup", "SEP 10_ojo", ... with merged cells, banner rows and extra columns) and turns it into a list of plug entries
// keyed by (date, Plug ID). The Workload route then copies the values into the BLANK cells of rows that already exist in the
// tracker (typically rows copied from the PSD Daily Plug List). Nothing here touches the database.
//
// What is read: the "_main" sheets (the "_backup" sheets only for a plug a day's main sheet does not list). The "_ojo" (Audio) sheets,
// TEMP / filter pool and anything without a "DATE: ..." line in the first rows are skipped.
// What each plug line gives: PSD, VO, Script, Art/STB, Audio Guide, Remarks, Total Mats, Prog Name, the VGFX / VEDIT breakdate
// (lines such as "VGFX: Sep 10, 10am"), the Units Concerned (which of VGFX / VEDIT have a breakdate line), and Priority ("PRIO ...").

const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const pad = (n) => String(n).padStart(2, '0');

/** Text of a cell: rich text joined, a formula's result, numbers as text; dates and errors are ignored. */
function cellStr(cell) {
  if (!cell) return '';
  let v = cell.value;
  if (v == null) return '';
  if (typeof v === 'object' && !(v instanceof Date)) {
    if (Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
    else if ('result' in v) v = v.result;
    else if (v.text != null) v = v.text;           // hyperlink cell
    else return '';
  }
  if (v == null || v instanceof Date || typeof v === 'object') return '';
  return String(v).replace(/\r\n?/g, '\n').trim();
}

/** "DATE: SEP 10, Thursday" -> { mon, day, dow } (or null). The workbook has no year. */
function sheetDay(ws) {
  for (let r = 1; r <= 6; r++) {
    const m = /DATE\s*:\s*([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2})(?:\s*,?\s*([A-Za-z]+))?/i.exec(cellStr(ws.getRow(r).getCell(1)));
    if (!m) continue;
    const mon = MON.indexOf(m[1].toLowerCase());
    const day = +m[2];
    if (mon >= 0 && day >= 1 && day <= 31) return { mon, day, dow: m[3] || '' };
  }
  return null;
}

/** One year for the whole workbook: the one in which most sheets' "Sep 10, Thursday" really is that weekday (a typo'd weekday on one sheet is outvoted). */
function workbookYear(days, nowYear) {
  const tally = new Map();
  for (const d of days) {
    const want = d.dow ? DOW.indexOf(d.dow.slice(0, 3).toLowerCase()) : -1;
    if (want < 0) continue;
    for (let y = nowYear + 1; y >= nowYear - 4; y--) {
      const t = new Date(Date.UTC(y, d.mon, d.day));
      if (t.getUTCMonth() === d.mon && t.getUTCDay() === want) tally.set(y, (tally.get(y) || 0) + 1);
    }
  }
  let best = nowYear;
  let n = 0;
  for (const [y, c] of tally) if (c > n || (c === n && y > best)) { best = y; n = c; }
  return best;
}

/** "10am", "4pm", "10:30am", "12nn" (noon), "12mn" (midnight) -> [hour, minute]; null when it is not a time. */
function parseTime(t) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(a\.?m?\.?|p\.?m?\.?|nn|mn)$/i.exec(String(t || '').trim());
  if (!m) return null;
  let h = +m[1];
  const mi = m[2] ? +m[2] : 0;
  const s = m[3].toLowerCase();
  if (h < 1 || h > 12 || mi > 59) return null;
  if (s === 'nn') h = 12;
  else if (s === 'mn') h = 0;
  else if (s[0] === 'p') h = h % 12 + 12;
  else h = h % 12;
  return [h, mi];
}

/**
 * The Breakdate cell of a plug line, e.g. "VGFX: Sep 10, 10am\nVEDIT: Sep 10, 11am\nPRIO PLS". Returns
 * { vgfx, vedit } as 'YYYY-MM-DDTHH:MM' (a date with no time = 12:00 AM, like the tracker), teams = the teams named,
 * priority, and leftover = the lines that are not a plain team + date (kept as a note in Remarks).
 */
function parseBreakdate(text, year) {
  const out = { vgfx: null, vedit: null, teams: [], priority: false, leftover: [] };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/\bprio(rity)?\b/i.test(line)) out.priority = true;
    const tm = /^(VGFX|VEDIT)\b\s*:?\s*(.*)$/i.exec(line);
    if (!tm) { out.leftover.push(line); continue; }
    const team = tm[1].toUpperCase();
    if (!out.teams.includes(team)) out.teams.push(team);
    const rest = tm[2].trim();
    const dm = /^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2})(?:\s*,?\s*(.+))?$/.exec(rest);
    const mon = dm ? MON.indexOf(dm[1].toLowerCase()) : -1;
    const time = dm && dm[3] ? parseTime(dm[3]) : null;
    if (mon < 0 || (dm[3] && !time)) { if (rest) out.leftover.push(line); continue; }   // "VEDIT:" on its own only names the team
    const d = new Date(Date.UTC(year, mon, +dm[2]));
    if (d.getUTCMonth() !== mon) { out.leftover.push(line); continue; }
    const [h, mi] = time || [0, 0];
    out[team === 'VGFX' ? 'vgfx' : 'vedit'] = `${year}-${pad(mon + 1)}-${pad(+dm[2])}T${pad(h)}:${pad(mi)}`;
  }
  return out;
}

/** The Plug ID itself: the team writes "PV_FIREWA_092926_LN015 - 24p" / "... - 24p, 4k" in the cell; the tracker and the plug list keep only the ID. */
const plugKey = (t) => String(t || '').split('\n')[0].trim().split(/\s+/)[0].replace(/[,;:]+$/, '').toUpperCase();

const unitsOf = (teams) => (teams.includes('VGFX') && teams.includes('VEDIT') ? 'VGFX/VEDIT' : teams.includes('VGFX') ? 'VGFX Only' : teams.includes('VEDIT') ? 'VEDIT Only' : null);

const HEADERS = [
  ['psd', /^PSD$/i], ['breakdate', /^BREAK\s*DATE/i], ['vo', /^VO$/i], ['script', /^SCRIPT$/i], ['art_stb', /^ART/i],
  ['audio_guide', /^AUDIO\s*GUIDE/i], ['remarks', /^REMARKS?$/i], ['total_mats', /^TOTAL\s*MATS?/i], ['prog_name', /^PROG/i],
];

/**
 * wb = an exceljs Workbook. Returns { entries: Map('YYYY-MM-DD|PLUGID' -> [entry, ...]), sheets: [{ name, date, plugs }], skipped: [names] }.
 * An entry holds only the fields the sheet actually had text for.
 */
function readTeamWorkbook(wb, nowYear = new Date().getFullYear()) {
  const main = new Map();
  const backup = new Map();
  const sheets = [];
  const skipped = [];
  const year = workbookYear(wb.worksheets.map(sheetDay).filter(Boolean), nowYear);
  const votes = new Map();   // Plug ID -> the units its own Breakdate lines gave, on any day
  for (const ws of wb.worksheets) {
    const name = ws.name || '';
    if (/ojo|^temp$|filter\s*pool/i.test(name)) { skipped.push(name); continue; }
    const day = sheetDay(ws);
    const date = day ? `${year}-${pad(day.mon + 1)}-${pad(day.day)}` : null;
    // header row = the one with a "PLUG ID" cell in the first rows
    let hdr = 0;
    let plugCol = 0;
    for (let r = 1; r <= 12 && !hdr; r++) {
      const row = ws.getRow(r);
      for (let c = 1; c <= Math.min(ws.columnCount || 20, 30); c++) if (/^PLUG\s*ID$/i.test(cellStr(row.getCell(c)))) { hdr = r; plugCol = c; break; }
    }
    if (!date || !hdr) { skipped.push(name); continue; }
    const cols = {};
    const hrow = ws.getRow(hdr);
    for (let c = 1; c <= Math.min(ws.columnCount || 20, 30); c++) {
      const h = cellStr(hrow.getCell(c)).replace(/\s+/g, ' ');
      const hit = h && HEADERS.find(([k, re]) => !cols[k] && re.test(h));
      if (hit) cols[hit[0]] = c;
    }
    const target = /back\s*up/i.test(name) ? backup : main;
    let plugs = 0;
    let lastUnit = null;
    for (let r = hdr + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const pid = plugKey(cellStr(row.getCell(plugCol)));
      if (!pid || pid === 'PLUG ID') continue;
      const e = { sheet: name, row: r };
      for (const k of ['psd', 'vo', 'script', 'art_stb', 'audio_guide', 'remarks', 'total_mats', 'prog_name']) {
        if (cols[k]) { const t = cellStr(row.getCell(cols[k])); if (t) e[k] = t; }
      }
      const bd = cols.breakdate ? parseBreakdate(cellStr(row.getCell(cols.breakdate)), year) : null;
      if (bd) {
        if (bd.vgfx) e.breakdate_vgfx = bd.vgfx;
        if (bd.vedit) e.breakdate_vedit = bd.vedit;
        if (bd.priority) e.is_priority = true;
        const u = unitsOf(bd.teams);
        if (u) { e.units_concerned = u; lastUnit = u; if (!votes.has(pid)) votes.set(pid, new Set()); votes.get(pid).add(u); }
        else if (lastUnit && /^\s*rehash/i.test(e.remarks || '')) e.units_concerned = lastUnit;   // a "Rehash for digital" line follows the plug it is rehashed from
        if (bd.leftover.length) e.note = bd.leftover.join('\n');
      }
      const k = `${date}|${pid}`;
      if (!target.has(k)) target.set(k, []);
      target.get(k).push(e);
      plugs++;
    }
    sheets.push({ name, date, plugs });
  }
  // the day's main sheet wins; its backup only supplies plugs the main sheet does not list
  const entries = new Map(main);
  for (const [k, list] of backup) if (!entries.has(k)) entries.set(k, list);
  // a Plug ID whose other days all name the same team(s) lends that to a day that does not name any
  const unitByPlug = new Map();
  for (const [pid, set] of votes) if (set.size === 1) unitByPlug.set(pid, [...set][0]);
  return { entries, sheets, skipped, unitByPlug };
}

module.exports = { plugKey, readTeamWorkbook, parseBreakdate, parseTime, sheetDay, workbookYear, cellStr };
