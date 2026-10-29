import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { createBackup, unpackBackup } from '../src/desktop/backups.js';
import { importTable, previewRows, writeFieldSheetWorkbook } from '../src/desktop/tables.js';
import { fieldSheetHtml, fieldSheetPrintRows, fieldSheetRows } from '../src/shared/fieldSheet.js';
import type { Field } from '../src/shared/model.js';
import { fixture } from './helpers.js';

test('imported sample identifiers and custom parameters survive field sheets, snapshots and backups', async (t) => {
  const { store, directory } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'CUSTOM-01',
    name: '旧表样品编号',
  }).experimentId!;
  const preview = previewRows([
    ['样品状态', '样品编号', '数量'],
    ['固溶', 'TA-017', '2'],
  ]);
  importTable(store, {
    experimentId,
    table: preview,
    mapping: preview.mapping,
    keepOtherColumns: true,
  });
  let snapshot = store.snapshot();
  assert.equal(snapshot.runs.length, 0, 'import must not fabricate runs');
  const importedId = snapshot.experiments[0].fields.find((field) => field.label === '样品编号')!;
  const group = snapshot.groups[0];
  assert.equal(group.values[importedId.id], 'TA-017');

  const temperature: Field = {
    id: 'in_situ_temperature',
    label: '原位温度',
    type: 'number',
    unit: '°C',
    options: [],
  };
  const zero: Field = { id: 'offset', label: '偏移', type: 'number', unit: 'mm', options: [] };
  const empty: Field = { id: 'empty', label: '可选说明', type: 'text', unit: '', options: [] };
  const blank: Field = { id: 'blank', label: '可选批次', type: 'text', unit: '', options: [] };
  store.command({
    type: 'updateExperiment',
    id: experimentId,
    fields: [importedId, temperature, zero, empty, blank],
  });
  store.command({
    type: 'updateGroups',
    ids: [group.id],
    patch: {
      values: {
        [temperature.id]: 375,
        [zero.id]: 0,
        [empty.id]: '组级说明',
        [blank.id]: '组级批次',
      },
    },
  });
  store.command({ type: 'arrange', groupId: group.id, count: 2, prefix: 'G' });
  snapshot = store.snapshot();
  const [first, second] = snapshot.items;
  const firstSample = snapshot.samples.find((sample) => sample.id === first.sampleId)!;
  store.command({
    type: 'updateSamples',
    ids: [firstSample.id],
    values: { [importedId.id]: 'TA-017-A', [empty.id]: null },
  });
  store.command({
    type: 'updateSamples',
    ids: [snapshot.samples.find((sample) => sample.id === second.sampleId)!.id],
    values: { [blank.id]: '' },
  });
  let rows = fieldSheetRows(store.snapshot(), experimentId);
  assert.match(rows[0].identity, /样品编号：TA-017-A/);
  assert.match(rows[1].identity, /样品编号：TA-017/);
  assert.match(rows[0].identity, /原位温度：375 °C/);
  assert.match(rows[0].identity, /偏移：0 mm/);
  assert.doesNotMatch(rows[0].identity, /可选说明|组级说明/);
  assert.match(rows[1].identity, /可选说明：组级说明/);
  assert.match(rows[0].identity, /可选批次：组级批次/);
  assert.doesNotMatch(rows[1].identity, /可选批次|组级批次/);

  store.command({ type: 'start', itemId: first.id });
  const started = structuredClone(store.snapshot().runs[0]);
  const laterField: Field = { id: 'later', label: '后加字段', type: 'text', unit: '', options: [] };
  store.command({
    type: 'updateExperiment',
    id: experimentId,
    fields: [
      { ...importedId, label: '后来改的编号字段' },
      { ...temperature, label: '后来改的温度字段', unit: 'K' },
      zero,
      empty,
      blank,
      laterField,
    ],
  });
  store.command({
    type: 'updateGroups',
    ids: [group.id],
    patch: {
      values: { [importedId.id]: 'TA-CHANGED', [temperature.id]: 450, [laterField.id]: '后加值' },
    },
  });
  store.command({
    type: 'saveRun',
    runId: started.id,
    actual: { [importedId.id]: 'TA-REAL', [temperature.id]: 400, [zero.id]: 0 },
  });
  snapshot = store.snapshot();
  assert.deepEqual(snapshot.runs[0].snapshot, started.snapshot);
  rows = fieldSheetRows(snapshot, experimentId);
  const historical = rows.find((row) => row.itemId === first.id)!;
  const pending = rows.find((row) => row.itemId === second.id)!;
  assert.match(historical.identity, /实际样品编号：TA-REAL · 开始时：TA-017-A/);
  assert.match(historical.identity, /实际原位温度：400 °C · 开始时：375 °C/);
  assert.match(historical.identity, /偏移：0 mm/);
  assert.doesNotMatch(historical.identity, /可选说明|组级说明/);
  assert.doesNotMatch(historical.identity, /后来改的|TA-CHANGED|450 K|后加字段|后加值/);
  assert.match(pending.identity, /后来改的编号字段：TA-CHANGED/);
  assert.match(pending.identity, /后来改的温度字段：450 K/);
  assert.match(pending.identity, /后加字段：后加值/);

  store.command({
    type: 'saveRun',
    runId: started.id,
    actual: { [temperature.id]: null, [empty.id]: '补充实际说明' },
  });
  snapshot = store.snapshot();
  assert.match(
    fieldSheetRows(snapshot, experimentId).find((row) => row.itemId === first.id)!.identity,
    /实际原位温度：未填写 · 开始时：375 °C/,
  );
  assert.match(
    fieldSheetRows(snapshot, experimentId).find((row) => row.itemId === first.id)!.identity,
    /实际可选说明：补充实际说明 · 开始时：未填写/,
  );
  store.command({
    type: 'saveRun',
    runId: started.id,
    actual: { [temperature.id]: 400, [empty.id]: null },
  });
  snapshot = store.snapshot();

  const html = fieldSheetHtml(snapshot, experimentId);
  assert.match(html, /实际样品编号：TA-REAL · 开始时：TA-017-A/);
  assert.match(html, /实际原位温度：400 °C · 开始时：375 °C/);
  const path = join(directory, '现场规划表.xlsx');
  await writeFieldSheetWorkbook(snapshot, experimentId, path);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.getWorksheet('现场规划表')!;
  const expectedSegments = fieldSheetPrintRows(fieldSheetRows(snapshot, experimentId));
  const actualSegments = Array.from(
    { length: sheet.rowCount - 1 },
    (_, index) => sheet.getRow(index + 2).getCell(4).text,
  );
  assert.deepEqual(
    actualSegments,
    expectedSegments.map((row) => row.cells[3]),
  );
  assert.match(actualSegments.join(''), /实际原位温度：400 °C · 开始时：375 °C/);

  // Older schema-v1 snapshots need not contain the optional group-name field.
  const legacyRun = structuredClone(snapshot.runs[0]);
  delete legacyRun.snapshot.sampleGroupName;
  store.put('runs', legacyRun);
  snapshot = store.snapshot();
  assert.match(
    fieldSheetRows(snapshot, experimentId).find((row) => row.itemId === first.id)!.identity,
    /实际原位温度：400 °C · 开始时：375 °C/,
  );
  const backupPath = join(directory, 'custom-fields.labrecord');
  await createBackup(store, backupPath);
  const restored = await unpackBackup(backupPath, join(directory, 'restored-custom'));
  assert.equal(restored.runs[0].snapshot.sampleGroupName, undefined);
  assert.deepEqual(restored.runs[0].snapshot.fields, started.snapshot.fields);
  assert.deepEqual(fieldSheetRows(restored, experimentId), fieldSheetRows(snapshot, experimentId));
});

test('custom fields sharing built-in labels never create false built-in changes', (t) => {
  const { store } = fixture(t);
  const fields: Field[] = [
    { id: 'custom_name', label: '样品名', type: 'text', unit: '', options: [] },
    { id: 'custom_protocol', label: '实验制度', type: 'text', unit: '', options: [] },
    { id: 'custom_mode', label: '实验方式', type: 'text', unit: '', options: [] },
    { id: 'custom_thickness', label: '厚度', type: 'number', unit: 'mm', options: [] },
    { id: 'custom_preparation', label: '制备/试剂', type: 'text', unit: '', options: [] },
  ];
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'CUSTOM-COLLISION',
    name: '字段同名测试',
    fields,
  }).experimentId!;
  const itemId = store.command({
    type: 'addSamples',
    experimentId,
    patch: {
      name: '真实样品组',
      state: '固溶',
      preparedCount: 1,
      mode: 'In situ',
      protocol: '内置制度开始值',
      thickness: '1.0',
      thicknessUnit: 'mm',
      preparation: '内置制备开始值',
      values: {
        custom_name: '自定义名称开始值',
        custom_protocol: '自定义制度开始值',
        custom_mode: '自定义方式开始值',
        custom_thickness: 3,
        custom_preparation: '自定义制备开始值',
      },
    },
    count: 1,
    prefix: 'G',
  }).itemId!;
  store.command({ type: 'start', itemId });
  const runId = store.snapshot().runs[0].id;
  store.command({
    type: 'saveRun',
    runId,
    actual: {
      custom_name: '自定义名称实际值',
      custom_protocol: '自定义制度实际值',
      custom_mode: '自定义方式实际值',
      custom_thickness: 5,
      custom_preparation: '自定义制备实际值',
    },
  });
  const unchangedBuiltins = fieldSheetRows(store.snapshot(), experimentId)[0];
  assert.equal(unchangedBuiltins.size, '开始时 厚 1.0 mm');
  assert.match(unchangedBuiltins.protocol, /制度：内置制度开始值/);
  assert.doesNotMatch(unchangedBuiltins.protocol, /实际制度|实际实验方式/);
  assert.match(
    unchangedBuiltins.identity,
    /实际样品名（自定义）：自定义名称实际值 · 开始时：自定义名称开始值/,
  );
  assert.match(unchangedBuiltins.identity, /实际厚度（自定义）：5 mm · 开始时：3 mm/);
  assert.doesNotMatch(unchangedBuiltins.identity, /实际制备 \/ 试剂：自定义制备实际值/);

  store.command({
    type: 'saveRun',
    runId,
    actual: {
      mode: 'Ex situ',
      protocol: '内置制度实际值',
      thickness: '1.2',
      thicknessUnit: 'mm',
      preparation: '内置制备实际值',
    },
    actualSample: { name: '真实样品名实际值' },
  });
  const changedBuiltins = fieldSheetRows(store.snapshot(), experimentId)[0];
  assert.match(changedBuiltins.size, /实际 厚 1.2 mm · 计划 厚 1.0 mm/);
  assert.match(changedBuiltins.protocol, /实际制度 内置制度实际值 · 开始时 内置制度开始值/);
  assert.match(changedBuiltins.protocol, /实际实验方式 非原位 · 开始时 原位/);
  assert.match(changedBuiltins.identity, /开始时样品组：真实样品组/);
  assert.match(changedBuiltins.identity, /实际样品名：真实样品名实际值 · 开始时：真实样品组/);
  assert.match(changedBuiltins.identity, /实际制备 \/ 试剂：内置制备实际值/);
  assert.match(changedBuiltins.identity, /实际样品名（自定义）：自定义名称实际值/);
});
