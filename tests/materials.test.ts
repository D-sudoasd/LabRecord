import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { fixture } from './helpers.js';
import { DEFAULT_PATTERN, DETAILED_PATTERN, groupCounts } from '../src/shared/model.js';
import { MATERIAL_FIELDS } from '../src/shared/materials.js';
import { archiveSchema } from '../src/desktop/archive-validation.js';
import { createBackup, unpackBackup } from '../src/desktop/backups.js';
import {
  importTable,
  previewRows,
  previewFile,
  parseDelimited,
  exportFile,
  operationRows,
} from '../src/desktop/tables.js';
import { renderReport } from '../src/desktop/reports.js';

const profile = {
  composition: 'Ti-24Nb-4Zr-8Sn（wt.%）',
  processing: '热轧 → 冷轧 60%',
  heatTreatment: '800 °C × 30 min，水淬 → 400 °C × 2 h 时效',
  otherTreatment: '无',
};
function setup(t: Parameters<typeof fixture>[0], namingPattern?: string) {
  const data = fixture(t);
  const experimentId = data.store.command({
    type: 'createExperiment',
    code: 'METAL',
    name: '金属材料实验',
    ...(namingPattern ? { namingPattern } : {}),
  }).experimentId!;
  return { ...data, experimentId };
}

test('default sample numbers continue across groups, arranged spares and temporary specimens without a redundant run suffix', (t) => {
  const { store, experimentId } = setup(t);
  assert.equal(store.get('experiments', experimentId).namingPattern, DEFAULT_PATTERN);
  store.command({
    type: 'addSamples',
    experimentId,
    count: 2,
    patch: { name: 'Ti2448', state: 'NOHR_aged', preparedCount: 4, ...profile },
  });
  store.command({
    type: 'addSamples',
    experimentId,
    count: 1,
    patch: { name: 'Ti15Nb', state: '对照', preparedCount: 1 },
  });
  const group = store.snapshot().groups[0];
  store.command({ type: 'arrange', groupId: group.id, count: 1 });
  store.command({
    type: 'temporary',
    experimentId,
    patch: { name: '临时试样', state: '未指定', preparedCount: 1 },
  });
  const snapshot = store.snapshot();
  assert.deepEqual(
    snapshot.samples.map((sample) => sample.code),
    ['S01', 'S02', 'S03', 'S04', 'S05'],
  );
  assert.deepEqual(
    snapshot.items.map((item) => item.plannedName),
    ['METAL_S01', 'METAL_S02', 'METAL_S03', 'METAL_S04', 'METAL_S05'],
  );
  assert.equal(groupCounts(snapshot, group).spare, 1);
});

test('same-sample measurements only add M02 when needed; queue changes and out-of-order starts keep reserved names and identities', (t) => {
  const { store, experimentId } = setup(t);
  const first = store.command({
    type: 'addSamples',
    experimentId,
    count: 2,
    patch: { state: '原态', preparedCount: 3 },
  }).itemId!;
  store.command({ type: 'scheduleMeasurements', itemIds: [first], repetitions: 2 });
  let snapshot = store.snapshot();
  assert.deepEqual(
    snapshot.items.map((item) => item.plannedName),
    ['METAL_S01', 'METAL_S02', 'METAL_S01_M02', 'METAL_S01_M03'],
  );
  const identities = snapshot.samples;
  const names = snapshot.items.map((item) => item.plannedName);
  const second = snapshot.items[1].id;
  store.command({
    type: 'reorder',
    experimentId,
    ids: snapshot.items.map((item) => item.id).reverse(),
  });
  const reserved = new Map(snapshot.items.map((item) => [item.id, item.plannedName]));
  store.command({
    type: 'updateGroups',
    ids: [snapshot.groups[0].id],
    patch: { notes: '只改备注' },
  });
  for (const item of store.snapshot().items) {
    if (reserved.has(item.id)) assert.equal(item.plannedName, reserved.get(item.id));
  }
  store.command({ type: 'start', itemId: second });
  store.command({ type: 'finish', itemId: second });
  const original = structuredClone(store.snapshot().runs[0]);
  store.command({ type: 'repeat', itemId: second });
  snapshot = store.snapshot();
  assert.equal(snapshot.runs[0].number, 1);
  assert.equal(snapshot.runs[0].filename, 'METAL_S02');
  assert.deepEqual(snapshot.samples, identities);
  assert.deepEqual(
    snapshot.items.slice(0, 4).map((item) => item.plannedName),
    names,
  );
  assert.equal(snapshot.items.at(-1)!.plannedName, 'METAL_S02_M02');
  assert.equal(snapshot.items.at(-1)!.sampleId, original.sampleId);
  assert.equal(snapshot.items.at(-1)!.repeatOf, second);
  assert.deepEqual(snapshot.runs[0], original);
  assert.equal(groupCounts(snapshot, snapshot.groups[0]).spare, 1);
});

test('changing an existing template is explicit and only renames unstarted automatic plans', (t) => {
  const { store, experimentId } = setup(t, '{experiment}_{sample}_{run:03}');
  const first = store.command({
    type: 'addSamples',
    experimentId,
    count: 2,
    patch: { state: '原态', preparedCount: 2 },
  }).itemId!;
  store.command({ type: 'start', itemId: first });
  store.command({ type: 'finish', itemId: first });
  const run = structuredClone(store.snapshot().runs[0]);
  assert.equal(run.filename, 'METAL_S01_001');
  store.command({ type: 'updateExperiment', id: experimentId, namingPattern: DEFAULT_PATTERN });
  assert.deepEqual(store.snapshot().runs[0], run);
  assert.deepEqual(
    store.snapshot().items.map((item) => item.plannedName),
    ['METAL_S01_001', 'METAL_S02'],
  );
  store.command({ type: 'updateExperiment', id: experimentId, namingPattern: DETAILED_PATTERN });
  assert.equal(store.snapshot().items[1].plannedName, 'METAL_原态_S02');
});

test('preparation metadata is validated, blank and none differ, sample overrides and original run history survive a v1 backup', async (t) => {
  const { store, directory, experimentId } = setup(t);
  const itemId = store.command({
    type: 'addSamples',
    experimentId,
    count: 1,
    patch: { name: 'Ti2448', state: 'NOHR_aged', preparedCount: 2, ...profile },
  }).itemId!;
  const sampleId = store.get('items', itemId).sampleId;
  store.command({
    type: 'updateSamples',
    ids: [sampleId],
    parameters: { processing: '高压扭转 5 圈', heatTreatment: '无' },
  });
  store.command({ type: 'start', itemId });
  store.command({ type: 'finish', itemId });
  const original = structuredClone(store.snapshot().runs[0]);
  assert.equal(original.snapshot.group.processing, '高压扭转 5 圈');
  assert.equal(original.snapshot.group.heatTreatment, '无');
  store.command({
    type: 'updateGroups',
    ids: [store.snapshot().groups[0].id],
    patch: { ...profile, heatTreatment: '', otherTreatment: '激光冲击' },
  });
  assert.deepEqual(store.snapshot().runs[0], original);
  assert.equal(store.snapshot().groups[0].state, 'NOHR_aged');
  assert.equal(store.snapshot().groups[0].heatTreatment, '');
  assert.equal(store.snapshot().groups[0].otherTreatment, '激光冲击');
  assert.equal(original.snapshot.group.heatTreatment, '无');
  const before = store.snapshot();
  for (const { key } of MATERIAL_FIELDS) {
    assert.throws(
      () =>
        store.command({ type: 'updateGroups', ids: [before.groups[0].id], patch: { [key]: 7 } }),
      /输入格式/,
    );
    assert.throws(
      () =>
        store.command({
          type: 'updateGroups',
          ids: [before.groups[0].id],
          patch: { [key]: 'x'.repeat(3001) },
        }),
      /输入格式/,
    );
    const invalid = structuredClone(before);
    (invalid.runs[0].snapshot.group as any)[key] = 7;
    assert.equal(archiveSchema.safeParse(invalid).success, false);
  }
  assert.deepEqual(store.snapshot(), before);
  const path = join(directory, 'materials.labrecord');
  await createBackup(store, path);
  assert.deepEqual(await unpackBackup(path, join(directory, 'restored')), before);
});

test('old v1 records and snapshots without material fields restore without inferred processing or none values', async (t) => {
  const { store, directory, experimentId } = setup(t, '{experiment}_{sample}_{run:03}');
  const itemId = store.command({
    type: 'addSamples',
    experimentId,
    count: 1,
    patch: { state: 'NOHR_aged', preparedCount: 1 },
  }).itemId!;
  store.command({ type: 'start', itemId });
  const before = store.snapshot();
  const path = join(directory, 'old.labrecord');
  await createBackup(store, path);
  const restored = await unpackBackup(path, join(directory, 'old-restored'));
  assert.deepEqual(restored, before);
  for (const { key } of MATERIAL_FIELDS) {
    assert.equal(Object.hasOwn(restored.groups[0], key), false);
    assert.equal(Object.hasOwn(restored.runs[0].snapshot.group, key), false);
  }
  assert.equal(restored.runs[0].endedAt, null);
});

test('material table mapping, XLSX/CSV/JSON and HTML preserve units, raw state, explicit none and frozen preparation', async (t) => {
  const { store, directory, experimentId } = setup(t);
  const table = previewRows(
    parseDelimited(
      '样品名称\t样品状态\t成分\t加工工艺\t热处理制度\t其他\t准备数量\nTi2448\tNOHR_aged\tTi-24Nb-4Zr-8Sn（wt.%）\t冷轧 60%\t无\t\t3',
    ),
  );
  importTable(store, { experimentId, table, mapping: table.mapping, keepOtherColumns: true });
  const group = store.snapshot().groups[0];
  assert.equal(group.composition, profile.composition);
  assert.equal(group.heatTreatment, '无');
  assert.equal(group.otherTreatment, '');
  assert.equal(store.snapshot().runs.length, 0);
  assert.equal(store.snapshot().items.length, 0);
  const itemId = store.command({ type: 'arrange', groupId: group.id, count: 1 }).itemId!;
  store.command({ type: 'start', itemId });
  store.command({ type: 'finish', itemId });
  store.command({ type: 'updateGroups', ids: [group.id], patch: { processing: '后续修改' } });
  const snapshot = store.snapshot();
  const rows = operationRows(snapshot, experimentId);
  assert.equal(rows[1][rows[0].indexOf('计划加工工艺')], '冷轧 60%');
  const report = await renderReport(snapshot, experimentId, store.root);
  assert.match(report.html, /成分/);
  assert.match(report.html, /Ti-24Nb-4Zr-8Sn（wt.%）/);
  assert.match(report.html, /热处理制度<\/th><td>无/);
  for (const format of ['xlsx', 'csv', 'json'] as const)
    await exportFile(snapshot, experimentId, format, join(directory, `profile.${format}`));
  const exported = JSON.parse(await readFile(join(directory, 'profile.json'), 'utf8'));
  assert.equal(exported.groups[0].processing, '后续修改');
  assert.equal(exported.runs[0].snapshot.group.processing, '冷轧 60%');
  assert.match(await readFile(join(directory, 'profile.csv'), 'utf8'), /Ti-24Nb-4Zr-8Sn（wt.%）/);
  const copyId = store.command({
    type: 'createExperiment',
    code: 'COPY',
    name: '往返',
  }).experimentId!;
  const preview = await previewFile(join(directory, 'profile.xlsx'));
  const restored = importTable(store, {
    experimentId: copyId,
    table: preview,
    mapping: preview.mapping,
    keepOtherColumns: true,
  }).groups.find((g) => g.experimentId === copyId)!;
  for (const { key } of MATERIAL_FIELDS) assert.equal(restored[key], snapshot.groups[0][key]);
});

test('built-in and legacy custom composition columns remain independent in new and old XLSX round trips', async (t) => {
  const { store, directory, experimentId } = setup(t);
  const field = {
    id: 'legacy-composition',
    label: '成分',
    type: 'text' as const,
    unit: '',
    options: [],
  };
  store.command({ type: 'updateExperiment', id: experimentId, fields: [field] });
  store.command({
    type: 'createGroup',
    experimentId,
    patch: { name: '合金', state: '原标记', ...profile, values: { [field.id]: '原表成分原文' } },
  });
  const path = join(directory, 'custom.xlsx');
  await exportFile(store.snapshot(), experimentId, 'xlsx', path);
  let table = await previewFile(path);
  const target = store.command({
    type: 'createExperiment',
    code: 'CUSTOM',
    name: '字段共存',
  }).experimentId!;
  let result = importTable(store, {
    experimentId: target,
    table,
    mapping: table.mapping,
    keepOtherColumns: true,
  });
  assert.deepEqual(result.experiments.find((e) => e.id === target)!.fields, [field]);
  let group = result.groups.find((g) => g.experimentId === target)!;
  assert.equal(group.composition, profile.composition);
  assert.equal(group.values[field.id], '原表成分原文');
  const csvPath = join(directory, 'custom.csv');
  await exportFile(store.snapshot(), experimentId, 'csv', csvPath);
  const csv = parseDelimited(await readFile(csvPath, 'utf8'));
  assert.equal(csv[1][csv[0].indexOf('成分')], profile.composition);
  assert.equal(csv[1][csv[0].indexOf('自定义 成分')], '原表成分原文');
  // Model an older XLSX with a custom composition field and no new built-in columns.
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('实验规划').addRows([
    ['样品名称', '样品状态', '成分'],
    ['合金', '旧状态', '旧成分原文'],
  ]);
  workbook
    .addWorksheet('参数定义')
    .addRows([['LabRecordFields-v1'], ['字段ID', '定义JSON'], [field.id, JSON.stringify(field)]]);
  await workbook.xlsx.writeFile(path);
  table = await previewFile(path);
  assert.equal(table.mapping.composition, undefined);
  const oldId = store.command({
    type: 'createExperiment',
    code: 'OLD',
    name: '旧表',
  }).experimentId!;
  result = importTable(store, {
    experimentId: oldId,
    table,
    mapping: table.mapping,
    keepOtherColumns: true,
  });
  group = result.groups.find((g) => g.experimentId === oldId)!;
  assert.equal(Object.hasOwn(group, 'composition'), false);
  assert.equal(group.values[field.id], '旧成分原文');
});
