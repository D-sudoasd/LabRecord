import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import {
  parseDelimited,
  previewRows,
  previewFile,
  importTable,
  exportFile,
} from '../src/desktop/tables.js';
import { fixture } from './helpers.js';

const oldTable =
  '已完成\t样品状态\t数量\tIn situ/Ex situ\t实验时间\t优先级\t厚度\t备注\t批次\r\n1\tTi-demo-base\t2\t\t\tP0\t\t\t000007\r\n0\tTi-demo-reference\t1\t\t\tP0\t\t待安排\t000008';
test('legacy paste retains history, leading zero text and blanks without synthesizing runs', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: '00001',
    name: '旧表导入',
  }).experimentId!;
  const table = previewRows(parseDelimited(oldTable));
  const result = importTable(store, {
    experimentId,
    table,
    mapping: table.mapping,
    keepOtherColumns: true,
  });
  assert.equal(result.groups[0].preparedCount, 2);
  assert.equal(result.groups[0].state, 'Ti-demo-base');
  assert.equal(result.groups[0].legacyCompleted, true);
  assert.equal(result.groups[1].legacyCompleted, false);
  assert.equal(result.groups[0].legacyTime, '');
  assert.equal(result.groups[0].protocol, '');
  assert.equal(result.groups[0].thicknessUnit, '');
  assert.equal(result.items.length, 0);
  assert.equal(result.runs.length, 0);
  const field = result.experiments[0].fields[0];
  assert.equal(result.groups[0].values[field.id], '000007');
});

test('in-situ protocol imports from its own column and stays blank when the column is absent', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'P01',
    name: '制度导入',
  }).experimentId!;
  const table = previewRows(
    parseDelimited(
      '样品状态\tIn situ/Ex situ\t实验制度\nTi-heat\t原位\t10 °C/min 至 375 °C，保温 30 min\nTi-ref\t非原位\t',
    ),
  );
  assert.equal(table.mapping.protocol, 2);
  importTable(store, { experimentId, table, mapping: table.mapping, keepOtherColumns: true });
  const groups = store.snapshot().groups;
  assert.equal(groups[0].mode, 'In situ');
  assert.equal(groups[0].protocol, '10 °C/min 至 375 °C，保温 30 min');
  assert.equal(groups[1].mode, 'Ex situ');
  assert.equal(groups[1].protocol, '');
  assert.equal(groups[0].notes, '');
});

test('CSV quoting handles Chinese, comma, quotation and multiline remarks; invalid rows roll back', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'E1',
    name: 'CSV',
  }).experimentId!;
  const table = previewRows(
    parseDelimited('样品状态,数量,备注\r\n"demo-L",6,"中文, \"\"引用\"\"\n第二行"'),
  );
  importTable(store, { experimentId, table, mapping: table.mapping, keepOtherColumns: true });
  assert.equal(store.snapshot().groups[0].notes, '中文, "引用"\n第二行');
  const invalid = previewRows(parseDelimited('样品状态,数量,其他\nA,2,x\nB,-1,y'));
  const before = store.snapshot();
  assert.throws(
    () =>
      importTable(store, {
        experimentId,
        table: invalid,
        mapping: invalid.mapping,
        keepOtherColumns: true,
      }),
    /第 3 行/,
  );
  assert.deepEqual(store.snapshot(), before);
  assert.throws(() => parseDelimited('a,b\n"unterminated'));
});

test('XLSX numeric cells with zero-padding are preserved; explicit units remain explicit', async (t) => {
  const { store, directory } = fixture(t);
  const path = join(directory, '输入.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('规划');
  sheet.addRows([
    ['样品状态', '数量', '厚度', '厚度单位', '批次'],
    ['001', 6, 0.8, 'mm', 7],
  ]);
  sheet.getCell('E2').numFmt = '000000';
  await workbook.xlsx.writeFile(path);
  const table = await previewFile(path);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'E2',
    name: 'Excel',
  }).experimentId!;
  importTable(store, { experimentId, table, mapping: table.mapping, keepOtherColumns: true });
  const result = store.snapshot();
  assert.equal(result.groups[0].thicknessUnit, 'mm');
  assert.equal(result.groups[0].state, '001');
  assert.equal(result.groups[0].values[result.experiments[0].fields[0].id], '000007');
});

test('all exports include plan, actual changes, problems, originals, units, blank values and stable IDs', async (t) => {
  const { store, directory } = fixture(t);
  const { experimentId, itemId } = store.command({ type: 'demo' });
  const sampleId = store.get('items', itemId!).sampleId;
  store.command({ type: 'updateSamples', ids: [sampleId], code: '000012' });
  store.command({ type: 'start', itemId });
  const run = store.snapshot().runs[0];
  store.command({
    type: 'saveRun',
    runId: run.id,
    notes: '中文, "引用"\n第二行',
    actual: { filename: '000012_仪器', scanId: '000007', temperature: null },
  });
  store.command({
    type: 'addEvent',
    experimentId,
    itemId,
    runId: run.id,
    eventType: 'issue',
    text: '装样调整',
    category: '装样问题',
  });
  store.command({ type: 'finish', itemId });
  store.command({ type: 'updateExperiment', id: experimentId, fields: [] }); // Historical field/units remain exportable.
  for (const format of ['xlsx', 'csv', 'json'] as const)
    await exportFile(store.snapshot(), experimentId!, format, join(directory, '导出.' + format));
  const data = JSON.parse(await readFile(join(directory, '导出.json'), 'utf8'));
  assert.equal(data.format, 'LabRecord');
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.runs[0].snapshot.sample.code, '000012');
  assert.equal(data.runs[0].actual.temperature, null);
  assert.equal(data.runs[0].snapshot.fields[0].unit, '°C');
  const csv = parseDelimited(await readFile(join(directory, '导出.csv'), 'utf8'));
  assert.ok(csv[0].includes('计划 温度 / °C'));
  assert.equal(csv.filter((row) => row[0] === '样品组').length, 2);
  assert.equal(csv.filter((row) => row[0] === '操作').length, 4);
  assert.ok(csv.some((row) => row.includes('装样调整')));
  const record = csv.find(
    (row) => row[0] === '操作' && row[csv[0].indexOf('样品编号')] === '000012',
  )!;
  assert.equal(record[csv[0].indexOf('扫描编号')], '000007');
  assert.equal(record[csv[0].indexOf('现场备注')], '中文, "引用"\n第二行');
  assert.equal(record[csv[0].indexOf('实际 温度 / °C')], '');
  const excel = new ExcelJS.Workbook();
  await excel.xlsx.readFile(join(directory, '导出.xlsx'));
  assert.deepEqual(
    excel.worksheets.map((s) => s.name),
    ['实验规划', '操作记录', '时间线与修改历史', '附件清单', '参数定义'],
  );
  const operations = excel.getWorksheet('操作记录')!;
  const headers = operations.getRow(1).values as string[];
  assert.equal(operations.getCell(2, headers.indexOf('样品编号')).value, '000012');
  assert.equal(operations.getCell(2, headers.indexOf('扫描编号')).value, '000007');
  assert.equal(operations.getCell(2, headers.indexOf('实际 温度 / °C')).value, null);
});

test('historical field units are exported into separate columns without converting old measurements', async (t) => {
  const { store, directory } = fixture(t);
  const { itemId, experimentId } = store.command({ type: 'demo' });
  store.command({ type: 'start', itemId });
  const oldFields = store.snapshot().experiments[0].fields;
  store.command({
    type: 'updateExperiment',
    id: experimentId,
    fields: oldFields.map((f) => (f.id === 'temperature' ? { ...f, unit: 'K' } : f)),
  });
  await exportFile(store.snapshot(), experimentId!, 'csv', join(directory, 'units.csv'));
  const rows = parseDelimited(await readFile(join(directory, 'units.csv'), 'utf8'));
  const record = rows.find((r) => r[0] === '操作')!;
  assert.equal(record[rows[0].indexOf('计划 温度 / °C')], '25');
  assert.equal(record[rows[0].indexOf('实际 温度 / °C')], '25');
  assert.equal(record[rows[0].indexOf('计划 温度 / K')], '');
});

test('LabRecord XLSX planning round trip preserves custom number/select definitions, units and nulls', async (t) => {
  const { store, directory } = fixture(t);
  const experimentId = store.command({ type: 'demo' }).experimentId!;
  const fields = [
    ...store.snapshot().experiments[0].fields,
    { id: 'direction', label: '方向', type: 'select', unit: '', options: ['纵向', '横向'] },
  ];
  store.command({ type: 'updateExperiment', id: experimentId, fields });
  store.command({
    type: 'updateGroups',
    ids: [store.snapshot().groups[0].id],
    patch: { values: { direction: '横向' } },
  });
  const path = join(directory, 'roundtrip.xlsx');
  await exportFile(store.snapshot(), experimentId, 'xlsx', path);
  const table = await previewFile(path);
  const newId = store.command({
    type: 'createExperiment',
    code: 'REIMPORT',
    name: '重新导入',
  }).experimentId!;
  const result = importTable(store, {
    experimentId: newId,
    table,
    mapping: table.mapping,
    keepOtherColumns: true,
  });
  assert.deepEqual(result.experiments.find((e) => e.id === newId)!.fields, fields);
  const groups = result.groups.filter((g) => g.experimentId === newId);
  assert.equal(groups[0].values.temperature, 25);
  assert.equal(groups[0].values.direction, '横向');
  assert.equal(groups[1].values.temperature, null);
  assert.equal(groups[0].preparedCount, 6);
  assert.equal(result.items.filter((i) => i.experimentId === newId).length, 0);
});
