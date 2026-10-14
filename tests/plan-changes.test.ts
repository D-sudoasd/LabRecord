import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/desktop/reports.js';
import { csvRows, importTable, previewRows } from '../src/desktop/tables.js';
import { laterPlanDrift, operationSizeLine, startedPlanChanges } from '../src/shared/planChanges.js';
import { fixture } from './helpers.js';

test('started plan changes compare the start snapshot, ignore file references, and reach the report', async (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'DIFF-01',
    name: '计划对照',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: {
      name: '试样',
      state: '原状态',
      preparedCount: 2,
      thickness: '0.8',
      thicknessUnit: 'mm',
      width: '3',
      dimensionUnit: 'mm',
      protocol: '10 °C/min',
    },
    count: 2,
  });
  const items = store.snapshot().items;
  store.command({ type: 'start', itemId: items[0].id });
  const started = store.snapshot();
  assert.deepEqual(startedPlanChanges(started.runs[0]), []);
  assert.equal(operationSizeLine(started.runs[0].snapshot.group, started.runs[0]), '厚 0.8 mm · 宽 3 mm');
  const unchanged = await renderReport(started, experimentId, store.root);
  assert.doesNotMatch(unchanged.html, /与开始时计划不同/);
  assert.doesNotMatch(unchanged.markdown, /与开始时计划不同/);

  store.command({
    type: 'saveRun',
    runId: started.runs[0].id,
    actual: { thickness: '1.2', scanId: 'SCAN-88421', files: 'frame.cbf' },
  });
  store.command({
    type: 'updateGroups',
    ids: [store.snapshot().groups[0].id],
    patch: { thickness: '9.9', thicknessUnit: 'μm' },
  });
  const edited = store.snapshot();
  assert.equal(edited.runs[0].snapshot.group.thickness, '0.8');
  assert.equal(edited.runs[0].originalStartedAt, edited.runs[0].startedAt);
  assert.equal(edited.runs.length, 1);
  const changes = startedPlanChanges(edited.runs[0]);
  assert.deepEqual(
    changes.map((change) => change.label),
    ['厚度'],
  );
  assert.equal(changes[0].planned, '0.8 mm');
  assert.equal(changes[0].actual, '1.2 mm');
  assert.equal(
    operationSizeLine(edited.runs[0].snapshot.group, edited.runs[0]),
    '实际 厚 1.2 mm · 宽 3 mm · 计划 厚 0.8 mm · 宽 3 mm',
  );
  const withoutThickness = structuredClone(edited.runs[0]);
  delete withoutThickness.actual.thickness;
  delete withoutThickness.actual.thicknessUnit;
  assert.deepEqual(startedPlanChanges(withoutThickness), []);

  const report = await renderReport(edited, experimentId, store.root);
  assert.match(report.html, /与开始时计划不同/);
  assert.match(report.html, /0\.8 mm → 1\.2 mm/);
  assert.doesNotMatch(report.html, /9\.9 μm →/);
  assert.match(report.markdown, /厚度：0\.8 mm → 1\.2 mm/);
  assert.match(report.html, /当前计划已不同：尺寸 厚 9\.9 μm · 宽 3 mm/);
  assert.match(report.markdown, /当前计划已不同：尺寸 厚 9\.9 μm · 宽 3 mm/);
  const rows = csvRows(edited, experimentId);
  const header = rows[0].map(String);
  const driftColumn = header.indexOf('当前计划差异');
  const startedRow = rows.find(
    (row) => row[header.indexOf('记录类型')] === '操作' && row[header.indexOf('plan_item_id')] === items[0].id,
  );
  const pendingRow = rows.find(
    (row) => row[header.indexOf('记录类型')] === '操作' && row[header.indexOf('plan_item_id')] === items[1].id,
  );
  assert.equal(startedRow?.[driftColumn], '尺寸 厚 9.9 μm · 宽 3 mm');
  assert.equal(pendingRow?.[driftColumn], '');
  const actualColumn = header.indexOf('实际与开始时不同');
  assert.equal(startedRow?.[actualColumn], '厚度：0.8 mm → 1.2 mm');
  assert.equal(String(startedRow?.[actualColumn]).includes('SCAN-88421'), false);
  assert.equal(String(startedRow?.[actualColumn]).includes('frame.cbf'), false);
  assert.equal(String(startedRow?.[actualColumn]).includes('9.9'), false);
  assert.equal(pendingRow?.[actualColumn], '');
  const table = previewRows(rows.map((row) => row.map((cell) => (cell == null ? '' : String(cell)))));
  assert.ok(table.warnings.some((warning) => warning.includes('当前计划差异')));
  assert.ok(table.warnings.some((warning) => warning.includes('实际与开始时不同')));
  const importedId = store.command({
    type: 'createExperiment',
    code: 'DIFF-02',
    name: '再导入差异',
  }).experimentId!;
  importTable(store, {
    experimentId: importedId,
    table,
    mapping: table.mapping,
    keepOtherColumns: true,
  });
  assert.equal(store.snapshot().runs.length, 1);
  assert.equal(
    store.snapshot().experiments.find((entry) => entry.id === importedId)?.fields.some((field) => field.label === '当前计划差异'),
    false,
  );
  assert.equal(
    store.snapshot().experiments.find((entry) => entry.id === importedId)?.fields.some((field) => field.label === '实际与开始时不同'),
    false,
  );
  assert.equal(store.snapshot().runs[0].snapshot.group.thickness, '0.8');
  assert.equal(store.snapshot().runs[0].originalStartedAt, started.runs[0].originalStartedAt);
  assert.equal(store.snapshot().items[1].status, 'pending');
  const frozen = edited.runs[0].snapshot.group;
  assert.equal(laterPlanDrift(frozen, frozen), '');
  assert.equal(laterPlanDrift(frozen, { ...frozen, notes: '只改备注' }), '');
  assert.equal(
    laterPlanDrift(frozen, { ...frozen, protocol: '后来改成 450 °C' }),
    '实验制度 后来改成 450 °C',
  );
  assert.equal(
    laterPlanDrift(
      { ...frozen, protocol: '同样的制度' },
      { ...frozen, protocol: '同样的制度', notes: '只改备注' },
    ),
    '',
  );
  assert.equal(
    laterPlanDrift(frozen, { ...frozen, thickness: '2.2' }),
    '尺寸 厚 2.2 mm · 宽 3 mm',
  );
});

test('the report writes the recorded protocol only when it differs from the start snapshot', async (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'ACT-01',
    name: '实际制度',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: {
      state: '原状态',
      preparedCount: 2,
      protocol: '10 °C/min 升至 375 °C',
      notes: '隐藏备注',
      thickness: '0.8',
      thicknessUnit: 'mm',
    },
    count: 2,
  });
  const [changed, pending] = store.snapshot().items.slice().sort((a, b) => a.order - b.order);
  store.command({ type: 'start', itemId: changed.id });
  const started = store.snapshot().runs[0];
  store.command({
    type: 'saveRun',
    runId: started.id,
    actual: { protocol: '现场改为 20 min' },
  });
  const snapshot = store.snapshot();
  const report = await renderReport(snapshot, experimentId, store.root);
  const sentence = '实际制度 现场改为 20 min · 开始时 10 °C/min 升至 375 °C';
  assert.match(report.html, new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(report.markdown, new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(report.html.split('实际制度 现场改为').length - 1, 1);
  assert.equal(report.markdown.split('实际制度 现场改为').length - 1, 1);
  const pendingCode = snapshot.samples.find((sample) => sample.id === pending.sampleId)!.code;
  const pendingHtml = report.html.split(`<h2>${pendingCode}`)[1] || '';
  assert.equal(pendingHtml.includes('实际制度'), false);
  assert.equal(snapshot.runs[0].snapshot.group.protocol, '10 °C/min 升至 375 °C');
  assert.equal(snapshot.runs[0].originalStartedAt, started.originalStartedAt);
  assert.equal(snapshot.runs[0].endedAt, null);
  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.groups[0].preparedCount, 2);
  assert.equal(report.html.includes('隐藏备注 · 开始时'), false);
});
