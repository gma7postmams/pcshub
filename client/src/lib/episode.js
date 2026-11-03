// Episode / Breakdate typed or pasted as text -> what the table stores: "YYYY-MM-DD", "YYYY-MM-DD/YYYY-MM-DD" (a range) or several of those
// joined by commas, oldest first ("2026-09-14/2026-09-18,2026-09-21/2026-09-25"). Understands "Sep 14-18, 21-25", "Sep 1, 7, 14", "Sep 14 - Sep 18; Sep 21 - Sep 25",
// "Sep 1, 2026; Sep 7, 2026" and the stored form itself. A day with no month takes the previous one's; no year = `year`. Returns null when it can't be read.
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONRE = '(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*\\.?';
const p2 = (n) => String(n).padStart(2, '0');
function real(y, m, d) { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${p2(m)}-${p2(d)}` : null; }
function parseEpisodeText(raw, year) {
  let t = String(raw ?? '').replace(/[–—]/g, '-').replace(/\s+to\s+/gi, ' - ').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const parts = [];
  for (const chunk of t.split(/;/)) {
    for (const tok of chunk.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (parts.length && /^\d{4}(?!-\d)/.test(tok) && !/;$/.test(parts[parts.length - 1])) parts[parts.length - 1] += `, ${tok}`; else parts.push(tok);
    }
    if (parts.length) parts[parts.length - 1] += ';';
  }
  const segs = [];
  let cm = 0; let cy = year || new Date().getFullYear();
  for (let seg of parts.map((x) => x.replace(/;$/, '').trim())) {
    let m;
    if ((m = /^(\d{4}-\d{2}-\d{2})(?:\s*(?:\/|-)\s*(\d{4}-\d{2}-\d{2}))?$/.exec(seg))) {
      const a = real(...m[1].split('-').map(Number)); const b = m[2] ? real(...m[2].split('-').map(Number)) : a;
      if (!a || !b || b < a) return null;
      segs.push(a === b ? a : `${a}/${b}`); cm = +m[1].slice(5, 7); cy = +m[1].slice(0, 4); continue;
    }
    const full = new RegExp(`^${MONRE}\\s*(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?(?:\\s*-\\s*(?:${MONRE}\\s*)?(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?)?$`, 'i').exec(seg);
    const bare = new RegExp(`^(\\d{1,2})(?:\\s*-\\s*(?:${MONRE}\\s*)?(\\d{1,2}))?$`, 'i').exec(seg);   // "21", "21-25" or "28 - Oct 2" (the month comes from the previous date)
    let y1; let m1; let d1; let y2; let m2; let d2;
    if (full) {
      m1 = MON[full[1].toLowerCase()]; d1 = +full[2]; d2 = full[5] ? +full[5] : null; m2 = full[4] ? MON[full[4].toLowerCase()] : m1;
      y2 = full[6] ? +full[6] : null; y1 = full[3] ? +full[3] : y2 && m2 >= m1 ? y2 : cy;
      if (y2 == null) y2 = m2 < m1 ? y1 + 1 : y1;   // "Dec 28 - Jan 3" runs into the next year
    } else if (bare && cm) {
      m1 = cm; y1 = cy; d1 = +bare[1]; d2 = bare[3] ? +bare[3] : null; m2 = bare[2] ? MON[bare[2].toLowerCase()] : m1; y2 = m2 < m1 ? y1 + 1 : y1;
    } else return null;
    const a = real(y1, m1, d1); const b = d2 ? real(y2, m2, d2) : a;
    if (!a || !b || b < a) return null;
    segs.push(a === b ? a : `${a}/${b}`); cm = m2; cy = y2;
  }
  if (!segs.length) return null;
  const out = [...new Set(segs)].sort();
  return out.join(',');
}

export { parseEpisodeText };
