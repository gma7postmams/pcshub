// Exports: a value that looks like a formula (=, +, -, @) must land in the .xlsx as plain text, never as a formula Excel would run.
// (Guards an exceljs upgrade or a future export that passes user data as { formula }.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

test('formula-looking text is written as text', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('s');
  const evil = ['=HYPERLINK("http://evil","x")', '+cmd|calc', '@SUM(1)', '-2+3', '=1+1'];
  ws.addRow(evil);
  const buf = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buf);
  const row = back.worksheets[0].getRow(1);
  evil.forEach((v, i) => {
    const c = row.getCell(i + 1);
    assert.strictEqual(c.formula, undefined, `cell ${i + 1} became a formula`);
    assert.strictEqual(c.value, v);
  });
});

test('no export builds a formula from data', () => {
  for (const f of ['src/routes/ingest.js', 'src/routes/workload.js', 'src/routes/plugs.js', 'src/admin-extra.js', 'src/export-sheets.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/^\s*\/\/.*$/gm, '');   // code only, not comments
    assert.ok(!/\bformula\s*:/.test(src), `${f} writes a formula cell; make sure no user text reaches it`);
    assert.ok(!/text\/csv/.test(src), `${f} exports CSV: prefix cells starting with = + - @ with ' there`);
  }
});
