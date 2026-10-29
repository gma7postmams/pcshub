// Plug List import: choosing which tabs of the workbook to read (all tabs, or only the ones named).
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

// The route module loads the database module, which insists on a connection string. Nothing here ever queries it (the parser is pure).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:1/test';
const { parsePlugWorkbook } = require('../src/routes/plugs');

function workbook() {
  const wb = new ExcelJS.Workbook();
  [['Sept 28', ['PV_AAA_092826_LN015', 'PV_BBB_092826_LN030']], ['Sept 29', ['PV_CCC_092926_LN015']], ['Sept 30', ['PV_DDD_093026_LN015', 'PV_EEE_093026_LN060', 'PV_FFF_093026_LN030']]]
    .forEach(([name, ids]) => {
      const ws = wb.addWorksheet(name);
      ws.addRow(['NO', 'PLUG ID', 'PROG NAME/PROJ TITLE', 'PSD', 'Account By']);
      ids.forEach((id, i) => ws.addRow([i + 1, id, `Show ${id}`, 'PSD1', '']));
    });
  return wb;
}

test('no tab list: every tab is read', () => {
  const { sheets } = parsePlugWorkbook(workbook(), 2026);
  assert.deepEqual(sheets.map((s) => s.sheet), ['Sept 28', 'Sept 29', 'Sept 30']);
  assert.equal(sheets.reduce((n, s) => n + s.plugs.length, 0), 6);
});

test('a tab list: only those tabs are read', () => {
  const { sheets, warnings } = parsePlugWorkbook(workbook(), 2026, ['Sept 29', 'Sept 30']);
  assert.deepEqual(sheets.map((s) => s.sheet), ['Sept 29', 'Sept 30']);
  assert.deepEqual(sheets.map((s) => s.date), ['2026-09-29', '2026-09-30']);
  assert.equal(warnings.length, 0);
});

test('a tab that is not ticked is not read at all, even a broken one (no warning)', () => {
  const wb = workbook();
  const bad = wb.addWorksheet('Notes');
  bad.addRow(['nothing', 'useful']); bad.addRow(['here', 'either']);
  assert.ok(parsePlugWorkbook(wb, 2026).warnings.some((w) => w.includes('Notes')));
  const { sheets, warnings } = parsePlugWorkbook(wb, 2026, ['Sept 28']);
  assert.deepEqual(sheets.map((s) => s.sheet), ['Sept 28']);
  assert.equal(warnings.length, 0);
});

test('names that match no tab give nothing', () => {
  assert.equal(parsePlugWorkbook(workbook(), 2026, ['Oct 1']).sheets.length, 0);
});
