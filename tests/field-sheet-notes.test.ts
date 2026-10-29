import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { fixture } from './helpers.js';
import {
  experimentSnapshot,
  importTable,
  operationRows,
  previewRows,
  writeFieldSheetWorkbook,
} from '../src/desktop/tables.js';
import {
  fieldSheetHtml,
  fieldSheetNoteText,
  fieldSheetPrintRows,
  fieldSheetRows,
  fieldSheetTable,
} from '../src/shared/fieldSheet.js';

test('five-column notes keep each measurement and each old note source distinct', async (t) => {
  const { store, directory } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'NOTES',
    name: '备注',
  }).experimentId!;
  const firstId = store.command({
    type: 'addSamples',
    experimentId,
    count: 1,
    prefix: 'G',
    patch: { name: '钛合金', state: '固溶', notes: '旧组备注', preparedCount: 2 },
    specimens: [{ name: 'A-01', notes: '旧单件备注' }],
  }).itemId!;
  const secondId = store.command({ type: 'scheduleMeasurements', itemIds: [firstId] }).itemId!;
  let snapshot = store.snapshot();
  let rows = fieldSheetRows(snapshot, experimentId);
  assert.deepEqual(
    rows.map((row) => row.code),
    ['G-1', 'G-1-2'],
  );
  assert.equal(rows[0].noteSource, 'empty');
  assert.equal(rows[0].note, '');
  assert.match(rows[0].legacyNotes, /样品备注：旧单件备注/);
  assert.match(rows[0].legacyNotes, /样品组备注：旧组备注/);
  assert.equal(snapshot.runs.length, 0);

  store.command({ type: 'start', itemId: firstId });
  const run = store.snapshot().runs[0];
  store.command({ type: 'saveRun', runId: run.id, notes: '旧现场备注\n第二行' });
  snapshot = store.snapshot();
  rows = fieldSheetRows(snapshot, experimentId);
  assert.equal(rows[0].noteSource, 'legacy-run');
  assert.equal(rows[0].note, '旧现场备注\n第二行');
  assert.match(fieldSheetNoteText(rows[0]), /原现场备注：旧现场备注\n第二行/);
  assert.match(rows[0].legacyNotes, /当前样品组备注：旧组备注/);
  assert.equal(rows[1].note, '');

  const editable = structuredClone(snapshot);
  editable.items.find((item) => item.id === firstId)!.fieldNote = '现场新情况';
  editable.items.find((item) => item.id === secondId)!.fieldNote = '';
  rows = fieldSheetRows(editable, experimentId);
  assert.equal(rows[0].noteSource, 'field');
  assert.equal(rows[0].note, '现场新情况');
  assert.match(rows[0].legacyNotes, /原现场备注：旧现场备注/);
  assert.equal(rows[1].noteSource, 'field');
  assert.equal(rows[1].note, '', 'an explicitly cleared note does not revive an old one');
  assert.deepEqual(snapshot.runs[0].snapshot, run.snapshot);
  const operations = operationRows(editable, experimentId);
  const newNoteColumn = operations[0].indexOf('测量备注');
  const legacyColumn = operations[0].indexOf('现场备注');
  assert.notEqual(newNoteColumn, -1);
  assert.equal(operations[1][newNoteColumn], '现场新情况');
  assert.equal(operations[1][legacyColumn], '旧现场备注\n第二行');
  assert.equal(operations[2][newNoteColumn], '');
  assert.equal(experimentSnapshot(editable, experimentId).schemaVersion, 3);
  assert.equal(
    experimentSnapshot({ ...editable, schemaVersion: 1 }, experimentId).schemaVersion,
    1,
  );

  const html = fieldSheetHtml(editable, experimentId);
  assert.match(html, /<th>备注<\/th>/);
  assert.match(html, /现场新情况/);
  assert.match(html, /原现场备注：旧现场备注/);
  assert.match(html, /min-height: 3em/);
  const workbookPath = join(directory, '备注现场表.xlsx');
  await writeFieldSheetWorkbook(editable, experimentId, workbookPath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);
  const sheet = workbook.getWorksheet('现场规划表')!;
  assert.equal(sheet.getRow(1).getCell(5).value, '备注');
  assert.match(sheet.getRow(2).getCell(5).text, /现场新情况/);
  assert.ok(sheet.getRow(2).height! >= 52, 'handwriting room remains on a normal row');
  assert.equal(sheet.pageSetup.orientation, 'landscape');
  assert.equal(sheet.pageSetup.printTitlesRow, '1:1');
});

test('printed Excel rows reserve space for mixed-language words and show cell borders', async (t) => {
  const { store, directory } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'PRINT',
    name: '打印行高',
  }).experimentId!;
  const legacyId = store.command({
    type: 'addSamples',
    experimentId,
    count: 1,
    prefix: 'G',
    patch: { name: '旧样品', notes: 'GROUP_OLD_NOTE_003 样品组备注', preparedCount: 1 },
    specimens: [{ name: 'B-02', notes: 'SAMPLE_OLD_NOTE_002 样品备注' }],
  }).itemId!;
  const mixedId = store.command({
    type: 'addSamples',
    experimentId,
    count: 1,
    prefix: 'G',
    patch: { name: '混合备注样品', preparedCount: 1 },
  }).itemId!;
  const multilineId = store.command({
    type: 'addSamples',
    experimentId,
    count: 1,
    prefix: 'G',
    patch: { name: '多行备注样品', preparedCount: 1 },
  }).itemId!;
  const snapshot = store.snapshot();
  snapshot.items.find((item) => item.id === mixedId)!.fieldNote =
    'ALPHA_REFERENCE_001 BETA_REFERENCE_002 GAMMA_REFERENCE_003 DELTA_REFERENCE_004\n实际记录';
  const multiline = Array.from({ length: 12 }, () => `${'字'.repeat(10)}AA`).join('\n');
  snapshot.items.find((item) => item.id === multilineId)!.fieldNote = multiline;
  const printRows = fieldSheetPrintRows(fieldSheetRows(snapshot, experimentId));
  const legacyIndex = printRows.findIndex((row) => row.cells[0] === 'G-1');
  const mixedIndex = printRows.findIndex((row) => row.cells[0] === 'G-2');
  assert.ok(legacyIndex >= 0 && mixedIndex >= 0);
  assert.equal(snapshot.items.find((item) => item.id === legacyId)?.fieldNote, undefined);

  const path = join(directory, 'mixed-print.xlsx');
  await writeFieldSheetWorkbook(snapshot, experimentId, path);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.getWorksheet('现场规划表')!;
  const legacyRow = sheet.getRow(legacyIndex + 2);
  assert.equal(
    legacyRow.getCell(5).text,
    '样品备注：SAMPLE_OLD_NOTE_002 样品备注\n样品组备注：GROUP_OLD_NOTE_003 样品组备注',
  );
  // Real Excel renders this example as six lines: three for each old-note source.
  assert.ok(
    legacyRow.height! >= 6 * 16 + 8,
    `legacy notes need six lines (${legacyRow.height} pt)`,
  );
  const mixedRow = sheet.getRow(mixedIndex + 2);
  assert.ok(
    mixedRow.height! >= 5 * 16 + 8,
    `separated words and newlines need room (${mixedRow.height} pt)`,
  );
  const multilineRows = sheet
    .getRows(2, sheet.rowCount - 1)!
    .filter((excelRow) => excelRow.getCell(1).value === 'G-3');
  assert.ok(multilineRows.length > 1, 'mixed multiline text continues before the row-height limit');
  const logical = fieldSheetRows(snapshot, experimentId).find((row) => row.code === 'G-3')!;
  const expectedCells = [
    logical.size,
    logical.protocol,
    logical.identity,
    fieldSheetNoteText(logical),
  ];
  for (let column = 2; column <= 5; column += 1) {
    assert.equal(
      multilineRows.map((excelRow) => excelRow.getCell(column).text).join(''),
      expectedCells[column - 2],
      `column ${column} reconstructs exactly`,
    );
  }
  assert.ok(
    multilineRows.every((excelRow) => excelRow.height! < 380),
    'continuations leave room for their full conservative wrap estimate',
  );

  for (let row = 1; row <= sheet.rowCount; row += 1) {
    for (let column = 1; column <= 5; column += 1) {
      const border = sheet.getRow(row).getCell(column).border;
      for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
        assert.equal(
          border?.[edge]?.style,
          'thin',
          `visible border at row ${row}, column ${column}`,
        );
      }
    }
  }
});

test('long notes round-trip through print continuations and both field-sheet generations are protected', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'NOTES2',
    name: '备注续行',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    count: 1,
    patch: { name: '样品', preparedCount: 1 },
  });
  const snapshot = store.snapshot();
  const longNote = Array.from(
    { length: 80 },
    (_, index) => `第${index}次观察：${'WM'.repeat(8)}；`,
  ).join('\n');
  snapshot.items[0].fieldNote = longNote;
  const logical = fieldSheetRows(snapshot, experimentId);
  const printRows = fieldSheetPrintRows(logical);
  assert.ok(printRows.length > 1);
  assert.ok(printRows.every((row) => row.cells[0] === logical[0].code));
  assert.equal(printRows.map((row) => row.cells[4]).join(''), longNote);
  assert.equal(fieldSheetTable(snapshot, experimentId)[1][4], longNote);

  for (const headers of [
    ['简写编号', '尺寸', '原位参数', '实际样品信息'],
    ['备注', '实际样品信息', '简写编号', '尺寸', '原位参数', '额外列'],
  ]) {
    const preview = previewRows([headers, headers.map(() => '示例')]);
    assert.match(preview.warnings.join('\n'), /现场规划表/);
    assert.throws(
      () =>
        importTable(store, {
          experimentId,
          table: preview,
          mapping: { name: 0 },
          keepOtherColumns: true,
        }),
      /现场规划表只用于打印对照/,
    );
  }
  const normal = previewRows([
    ['样品状态', '尺寸', '备注'],
    ['固溶', '1 mm', '旧表备注'],
  ]);
  assert.doesNotMatch(normal.warnings.join('\n'), /现场规划表/);
  assert.equal(store.snapshot().runs.length, 0);
});

test('actual specimen name and state compare against the matching start snapshot', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'ACT',
    name: '状态',
  }).experimentId!;
  const itemId = store.command({
    type: 'addSamples',
    experimentId,
    count: 1,
    patch: { name: 'Ti2448', state: '固溶', preparedCount: 1 },
  }).itemId!;
  store.command({ type: 'start', itemId });
  const initial = store.snapshot().runs[0];
  assert.doesNotMatch(fieldSheetRows(store.snapshot(), experimentId)[0].identity, /实际样品/);
  store.command({
    type: 'saveRun',
    runId: initial.id,
    actualSample: { specimenName: 'TA-17', state: '已变形' },
  });
  const updated = store.snapshot();
  const identity = fieldSheetRows(updated, experimentId)[0].identity;
  assert.match(identity, /Ti2448/);
  assert.match(identity, /实际样品名：TA-17 · 开始时：未填写/);
  assert.match(identity, /实际样品状态：已变形 · 开始时：固溶/);
  assert.deepEqual(updated.runs[0].snapshot, initial.snapshot);
  assert.equal(updated.runs[0].originalStartedAt, initial.originalStartedAt);
});
