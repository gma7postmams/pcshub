'use strict';
// "Separate data by date into tabs" for the Excel exports: one sheet per unique date, named like "Sep 1" (with the year added only
// when the data spans more than one year, so the names stay unique), oldest date first. Rows with no date go on a "No date" sheet.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const isoOf = (d) => {
  if (!d) return '';
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(d));
  return m ? m[1] : '';
};

/** groupByDate(rows, (row) => date) -> [{ iso, name, rows }] */
function groupByDate(rows, dateOf) {
  const by = new Map();
  for (const r of rows) {
    const iso = isoOf(dateOf(r));
    if (!by.has(iso)) by.set(iso, []);
    by.get(iso).push(r);
  }
  const isos = [...by.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a < b ? -1 : a > b ? 1 : 0));
  const years = new Set(isos.filter(Boolean).map((i) => i.slice(0, 4)));
  return isos.map((iso) => {
    let name = 'No date';
    if (iso) { const m = +iso.slice(5, 7); const d = +iso.slice(8, 10); name = `${MONTHS[m - 1]} ${d}${years.size > 1 ? `, ${iso.slice(0, 4)}` : ''}`; }
    return { iso, name, rows: by.get(iso) };
  });
}

/** The dates an export covers, for its file name: "2026-09-01", "2026-09-01_to_2026-09-30", "from_2026-09-01", "until_2026-09-30" or "All_dates". */
const dateTag = (from, to) => {
  const ok = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? String(x) : '');
  const a = ok(from); const b = ok(to);
  if (a && b) return a === b ? a : `${a}_to_${b}`;
  if (a) return `from_${a}`;
  if (b) return `until_${b}`;
  return 'All_dates';
};
const truthy = (x) => x === '1' || x === 'true' || x === 'yes' || x === 'on';
module.exports = { groupByDate, truthy, isoOf, dateTag };
