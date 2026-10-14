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

/** The dates an export covers, for its file name: "Sep_1", "Sep_2-30", "Sep_28-Oct_5", a whole month "Sep_2026" ("Sep_2026-Nov_2026" for several),
    "from_Sep_1", "until_Sep_30", or "" when no dates are selected. The year is added ("Sep_2-30_2025") only when the dates are outside the current year. */
const dateTag = (from, to) => {
  const ok = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? String(x) : '');
  const a = ok(from); const b = ok(to);
  const thisYear = String(new Date().getFullYear());
  const md = (iso) => `${MONTHS[+iso.slice(5, 7) - 1]}_${+iso.slice(8, 10)}`;
  const yr = (iso) => (iso.slice(0, 4) === thisYear ? '' : `_${iso.slice(0, 4)}`);
  const lastDay = (iso) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7), 0)).getUTCDate();
  if (a && b) {
    if (a.slice(8, 10) === '01' && +b.slice(8, 10) === lastDay(b)) {   // whole months: month and year
      const my = (iso) => `${MONTHS[+iso.slice(5, 7) - 1]}_${iso.slice(0, 4)}`;
      return a.slice(0, 7) === b.slice(0, 7) ? my(a) : `${my(a)}-${my(b)}`;
    }
    if (a === b) return `${md(a)}${yr(a)}`;
    if (a.slice(0, 4) !== b.slice(0, 4)) return `${md(a)}_${a.slice(0, 4)}-${md(b)}_${b.slice(0, 4)}`;
    if (a.slice(0, 7) === b.slice(0, 7)) return `${md(a)}-${+b.slice(8, 10)}${yr(a)}`;
    return `${md(a)}-${md(b)}${yr(a)}`;
  }
  if (a) return `from_${md(a)}${yr(a)}`;
  if (b) return `until_${md(b)}${yr(b)}`;
  return '';   // no dates selected: nothing is added to the name
};
const truthy = (x) => x === '1' || x === 'true' || x === 'yes' || x === 'on';
module.exports = { groupByDate, truthy, isoOf, dateTag };
