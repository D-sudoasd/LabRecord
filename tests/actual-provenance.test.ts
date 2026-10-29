import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { fixture } from './helpers.js';
import { fieldSheetRows } from '../src/shared/fieldSheet.js';
import {
  actualFieldSource,
  actualSpecimenName,
  actualSpecimenNameField,
  operationSizeLine,
  planChangeLabel,
  recordedPlanSearchText,
  startedPlanChanges,
} from '../src/shared/planChanges.js';
import {
  csvRows,
  exportFile,
  importTable,
  operationRows,
  previewFile,
  previewRows,
} from '../src/desktop/tables.js';
import { renderReport } from '../src/desktop/reports.js';

test('partial old actuals remain unknown while actual state and same-named custom changes stay distinct', async (t) => {
  const { store } = fixture(t);
  const field = {
    id: 'custom-state',
    label: '样品状态',
    type: 'text' as const,
    unit: '',
    options: [],
  };
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'PROVENANCE',
    name: '来源',
    fields: [field],
  }).experimentId!;
  const itemId = store.command({
    type: 'addSamples',
    experimentId,
    count: 1,
    patch: {
      name: '样品 A',
      state: '固溶',
      preparedCount: 1,
      thickness: '1',
      thicknessUnit: 'mm',
      width: '2',
      dimensionUnit: 'mm',
      values: { 'custom-state': '计划自定义' },
    },
  }).itemId!;
  store.command({ type: 'start', itemId });
  const snapshot = store.snapshot();
  const run = snapshot.runs[0];
  run.actualSample = { state: '时效' };
  run.actualSources = { 'actualSample.state': 'edited' };
  delete run.actual.thickness;
  delete run.actual.thicknessUnit;
  run.actual['custom-state'] = '实际自定义';

  const changes = startedPlanChanges(run);
  assert.deepEqual(
    changes.map((change) => [change.source, change.key]),
    [
      ['builtin', 'state'],
      ['custom', 'custom-state'],
    ],
  );
  assert.equal(planChangeLabel(changes[1]), '样品状态（自定义）');
  assert.match(recordedPlanSearchText(run), /样品状态：固溶 → 时效/);
  assert.doesNotMatch(recordedPlanSearchText(run), /实际自定义/);
  assert.match(operationSizeLine(run.snapshot.group, run), /^开始时 /);
  const row = fieldSheetRows(snapshot, experimentId)[0];
  assert.match(row.identity, /开始时状态：固溶/);
  assert.match(row.identity, /实际样品状态：时效 · 开始时：固溶/);

  const [headers, values] = operationRows(snapshot, experimentId);
  const column = (label: string) => values[headers.indexOf(label)];
  assert.equal(column('样品状态'), '固溶');
  assert.equal(column('实际样品状态'), '时效');
  assert.equal(column('实际样品状态来源'), '用户更正');
  assert.equal(column('实际宽度'), null);
  assert.equal(column('实际宽度来源'), '未记录');
  assert.equal(column('实际厚度'), null);
  assert.equal(column('实际厚度来源'), '未记录');
  const csv = csvRows(snapshot, experimentId);
  const csvHeader = csv[0].map(String);
  const operation = csv.find((entry) => entry[0] === '操作')!;
  assert.equal(operation[csvHeader.indexOf('实际样品状态')], '时效');
  assert.equal(operation[csvHeader.indexOf('实际宽度来源')], '未记录');

  const report = await renderReport(snapshot, experimentId, store.root);
  assert.match(report.html, /实际样品状态<\/th><td>时效/);
  assert.match(report.html, /实际宽度来源<\/th><td>未记录/);
  assert.match(report.markdown, /开始时样品状态：固溶/);
  assert.match(report.markdown, /实际样品状态：时效/);
  assert.match(report.markdown, /实际样品状态来源：用户更正/);
});

test('legacy blank, explicit clearing and absent values have distinguishable sources', (t) => {
  const { store } = fixture(t);
  store.command({ type: 'demo' });
  store.command({ type: 'start', itemId: store.snapshot().items[0].id });
  const run = store.snapshot().runs[0];
  run.actualSample = { state: '' };
  run.actualSources = { 'actualSample.state': 'legacy' };
  assert.equal(actualFieldSource(run, 'actualSample.state'), '旧版空值（含义不明）');
  assert.equal(
    startedPlanChanges(run).some((change) => change.key === 'state'),
    false,
  );
  run.actualSources['actualSample.state'] = 'edited';
  assert.equal(actualFieldSource(run, 'actualSample.state'), '用户更正（已清空）');
  delete run.actualSample.state;
  delete run.actualSources['actualSample.state'];
  assert.equal(actualFieldSource(run, 'actualSample.state'), '未记录');
  assert.equal(
    startedPlanChanges(run).some((change) => change.key === 'state'),
    false,
  );
});

test('unknown units are not treated as changed actual dimensions', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'UNIT-SOURCE',
    name: '单位',
  }).experimentId!;
  const itemId = store.command({
    type: 'addSamples',
    experimentId,
    count: 1,
    patch: {
      name: '样品',
      preparedCount: 1,
      thickness: '1',
      thicknessUnit: 'mm',
      width: '2',
      dimensionUnit: 'mm',
    },
  }).itemId!;
  store.command({ type: 'start', itemId });
  const run = store.snapshot().runs[0];
  delete run.actual.thicknessUnit;
  delete run.actualSources!['actual.thicknessUnit'];
  delete run.actualSample!.dimensionUnit;
  delete run.actualSources!['actualSample.dimensionUnit'];
  assert.equal(
    startedPlanChanges(run).some((change) => ['thickness', 'width'].includes(change.key)),
    false,
  );
  assert.match(
    operationSizeLine(run.snapshot.group, run),
    /实际 厚 1（单位未记录） · 宽 2（单位未记录） · 开始时/,
  );
  run.actual.thickness = '7';
  run.actualSample!.width = '9';
  assert.equal(
    startedPlanChanges(run).some((change) => ['thickness', 'width'].includes(change.key)),
    false,
  );
  assert.match(
    operationSizeLine(run.snapshot.group, run),
    /厚 7（单位未记录） · 宽 9（单位未记录）/,
  );

  run.actual.thicknessUnit = 'cm';
  run.actualSample!.dimensionUnit = 'cm';
  run.actualSources!['actual.thicknessUnit'] = 'edited';
  run.actualSources!['actualSample.dimensionUnit'] = 'edited';
  assert.deepEqual(
    startedPlanChanges(run)
      .filter((change) => ['thickness', 'width'].includes(change.key))
      .map((change) => change.key),
    ['width', 'thickness'],
  );
  run.actual.thickness = '';
  run.actualSources!['actual.thickness'] = 'edited';
  assert.equal(
    startedPlanChanges(run).find((change) => change.key === 'thickness')?.actual,
    '未填写',
  );
  assert.match(operationSizeLine(run.snapshot.group, run), /厚 已清空/);
  delete run.actual.thickness;
  delete run.actualSources!['actual.thickness'];
  assert.equal(
    startedPlanChanges(run).some((change) => change.key === 'thickness'),
    false,
  );
});

test('legacy null, edited null, explicit blank, zero and absent actual values stay distinct', async (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'NULL-SOURCE',
    name: '空值',
  }).experimentId!;
  const itemId = store.command({
    type: 'addSamples',
    experimentId,
    count: 1,
    patch: { name: '样品', preparedCount: 1, thickness: '1', thicknessUnit: 'mm' },
  }).itemId!;
  store.command({ type: 'start', itemId });
  const snapshot = store.snapshot();
  const run = snapshot.runs[0];
  run.actual.thickness = null;
  run.actualSources!['actual.thickness'] = 'legacy';
  assert.equal(actualFieldSource(run, 'actual.thickness'), '旧版空值（含义不明）');
  assert.equal(
    startedPlanChanges(run).some((change) => change.key === 'thickness'),
    false,
  );
  let rows = operationRows(snapshot, experimentId);
  assert.equal(rows[1][rows[0].indexOf('实际厚度')], null);
  assert.equal(rows[1][rows[0].indexOf('实际厚度来源')], '旧版空值（含义不明）');
  const report = await renderReport(snapshot, experimentId, store.root);
  assert.match(report.html, /实际厚度<\/th><td>旧版空值（含义不明）/);

  run.actualSources!['actual.thickness'] = 'edited';
  assert.equal(actualFieldSource(run, 'actual.thickness'), '用户更正（明确空值）');
  run.actual.thickness = '';
  assert.equal(actualFieldSource(run, 'actual.thickness'), '用户更正（已清空）');
  run.actual.thickness = 0;
  assert.equal(actualFieldSource(run, 'actual.thickness'), '用户更正');
  rows = operationRows(snapshot, experimentId);
  assert.equal(rows[1][rows[0].indexOf('实际厚度')], 0);
  delete run.actual.thickness;
  delete run.actualSources!['actual.thickness'];
  assert.equal(actualFieldSource(run, 'actual.thickness'), '未记录');
  rows = operationRows(snapshot, experimentId);
  assert.equal(rows[1][rows[0].indexOf('实际厚度')], null);
  assert.equal(rows[1][rows[0].indexOf('实际厚度来源')], '未记录');
});

test('actual-export columns cannot silently become sample fields when importing', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'IMPORT-SOURCES',
    name: '导入',
  }).experimentId!;
  const table = previewRows([
    ['样品状态', '实际样品状态', '实际样品状态来源', '实际宽度来源'],
    ['固溶', '时效', '用户更正', '未记录'],
  ]);
  assert.match(
    table.warnings.join('\n'),
    /实际样品状态.*实际样品状态来源.*实际宽度来源.*不会写入样品/,
  );
  importTable(store, { experimentId, table, mapping: table.mapping, keepOtherColumns: true });
  const experiment = store.get('experiments', experimentId);
  assert.equal(
    experiment.fields.some((field) => /实际样品状态|实际宽度来源/.test(field.label)),
    false,
  );
  assert.equal(
    store.snapshot().groups.find((group) => group.experimentId === experimentId)?.state,
    '固溶',
  );
  assert.throws(
    () =>
      importTable(store, {
        experimentId,
        table,
        mapping: { state: 1 },
        keepOtherColumns: true,
      }),
    /不能导入为样品字段/,
  );
});

test('a group name is not a specimen name unless the specimen name was actually supplied', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'SPECIMEN-NAME',
    name: '样品名',
  }).experimentId!;
  const itemId = store.command({
    type: 'addSamples',
    experimentId,
    count: 1,
    patch: { name: 'Ti2448', state: '固溶', preparedCount: 1 },
  }).itemId!;
  store.command({ type: 'start', itemId });
  const run = store.snapshot().runs[0];
  assert.equal(run.actualSample?.name, 'Ti2448');
  assert.equal(actualSpecimenNameField(run), undefined);
  assert.equal(actualSpecimenName(run), undefined);
  const noGroupName = structuredClone(run);
  delete noGroupName.snapshot.group.name;
  noGroupName.actualSample!.name = '';
  assert.equal(actualSpecimenNameField(noGroupName), undefined);
  const oldBlank = structuredClone(noGroupName);
  oldBlank.actualSources!['actualSample.name'] = 'legacy';
  assert.equal(actualSpecimenNameField(oldBlank), 'actualSample.name');
  assert.equal(actualSpecimenName(oldBlank), '');
  assert.equal(actualFieldSource(oldBlank, actualSpecimenNameField(oldBlank)), '旧版空值（含义不明）');
  const oldSnapshot = store.snapshot();
  oldSnapshot.runs[0] = oldBlank;
  const oldRows = operationRows(oldSnapshot, experimentId);
  assert.equal(oldRows[1][oldRows[0].indexOf('实际样品名称')], '');
  assert.equal(oldRows[1][oldRows[0].indexOf('实际样品名称来源')], '旧版空值（含义不明）');
  let rows = operationRows(store.snapshot(), experimentId);
  assert.equal(rows[1][rows[0].indexOf('实际样品名称')], null);
  assert.equal(rows[1][rows[0].indexOf('实际样品名称来源')], '未记录');

  store.command({ type: 'saveRun', runId: run.id, actualSample: { name: 'Ti2448' } });
  const edited = store.get('runs', run.id);
  assert.equal(edited.actualSources?.['actualSample.name'], 'edited');
  assert.equal(actualSpecimenName(edited), 'Ti2448');
  assert.doesNotMatch(recordedPlanSearchText(edited), /样品名：/);
  rows = operationRows(store.snapshot(), experimentId);
  assert.equal(rows[1][rows[0].indexOf('实际样品名称')], 'Ti2448');
  assert.equal(rows[1][rows[0].indexOf('实际样品名称来源')], '用户更正');
  assert.deepEqual(edited.snapshot, run.snapshot);
  store.command({ type: 'saveRun', runId: run.id, actualSample: { name: '现场试样甲' } });
  const renamedGroup = store.get('runs', run.id);
  assert.match(recordedPlanSearchText(renamedGroup), /样品名：Ti2448 → 现场试样甲/);
  store.command({ type: 'saveRun', runId: run.id, actualSample: { specimenName: 'Ti2448' } });
  const namedSpecimen = store.get('runs', run.id);
  assert.match(recordedPlanSearchText(namedSpecimen), /样品名：未填写 → Ti2448/);
});

test('a same-named custom planning field remains round-trippable', async (t) => {
  const { store, directory } = fixture(t);
  const field = {
    id: 'same-label',
    label: '实际样品状态',
    type: 'text' as const,
    unit: '',
    options: [],
  };
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'CUSTOM-SOURCE',
    name: '同名',
    fields: [field],
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    count: 1,
    patch: {
      name: '样品',
      state: '固溶',
      preparedCount: 1,
      values: { 'same-label': '自定义原文' },
    },
  });
  const path = join(directory, 'custom.xlsx');
  await exportFile(store.snapshot(), experimentId, 'xlsx', path);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const labels = workbook.getWorksheet('实验规划')!.getRow(1).values as string[];
  assert.ok(labels.includes('自定义 实际样品状态'));
  const table = await previewFile(path);
  const target = store.command({
    type: 'createExperiment',
    code: 'CUSTOM-RESTORE',
    name: '回读',
  }).experimentId!;
  importTable(store, {
    experimentId: target,
    table,
    mapping: table.mapping,
    keepOtherColumns: true,
  });
  const restored = store.get('experiments', target);
  assert.equal(restored.fields.find((entry) => entry.id === field.id)?.label, field.label);
  assert.equal(
    store.snapshot().groups.find((group) => group.experimentId === target)?.values[field.id],
    '自定义原文',
  );
});
