import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { writeFieldSheetWorkbook } from '../src/desktop/tables.js';
import { fieldSheetHtml, fieldSheetPrintRows, fieldSheetRows } from '../src/shared/fieldSheet.js';
import { fixture } from './helpers.js';

test('literal 未指定 remains visible in pending and started sheets; an explicit blank stays blank', async (t) => {
  const { store, directory } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'STATE',
    name: '状态',
  }).experimentId!;
  const itemId = store.command({
    type: 'addSamples',
    experimentId,
    patch: { name: '样品 A', state: '固溶', preparedCount: 1 },
    count: 1,
    prefix: 'G',
  }).itemId!;

  store.command({ type: 'updateFieldRow', itemId, sample: { state: '未指定' } });
  let snapshot = store.snapshot();
  assert.equal(snapshot.samples[0].parameters.state, '未指定');
  assert.match(fieldSheetRows(snapshot, experimentId)[0].identity, /状态：未指定/);
  assert.match(fieldSheetHtml(snapshot, experimentId), /状态：未指定/);

  const path = join(directory, '现场表.xlsx');
  await writeFieldSheetWorkbook(snapshot, experimentId, path);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.getWorksheet('现场规划表')!;
  const renderedIdentity = Array.from(
    { length: sheet.rowCount - 1 },
    (_, index) => sheet.getRow(index + 2).getCell(4).text,
  ).join('');
  assert.match(renderedIdentity, /状态：未指定/);
  assert.equal(
    renderedIdentity,
    fieldSheetPrintRows(fieldSheetRows(snapshot, experimentId))
      .map((row) => row.cells[3])
      .join(''),
  );

  store.command({ type: 'start', itemId });
  const started = structuredClone(store.snapshot().runs[0]);
  snapshot = store.snapshot();
  assert.equal(snapshot.runs[0].actualSample?.state, '未指定');
  assert.match(fieldSheetRows(snapshot, experimentId)[0].identity, /状态：未指定/);

  store.command({ type: 'updateFieldRow', itemId, sample: { state: '' } });
  snapshot = store.snapshot();
  assert.equal(snapshot.runs[0].actualSample?.state, '');
  assert.deepEqual(snapshot.runs[0].snapshot, started.snapshot);
  assert.match(
    fieldSheetRows(snapshot, experimentId)[0].identity,
    /实际样品状态：未填写 · 开始时：未指定/,
  );

  const repeatId = store.command({ type: 'repeat', itemId }).itemId!;
  snapshot = store.snapshot();
  const repeat = fieldSheetRows(snapshot, experimentId).find((row) => row.itemId === repeatId)!;
  assert.equal(snapshot.samples[0].parameters.state, '');
  assert.doesNotMatch(repeat.identity, /状态：/);
});
