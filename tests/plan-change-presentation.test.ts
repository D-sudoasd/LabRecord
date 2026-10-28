import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/desktop/reports.js';
import { csvRows } from '../src/desktop/tables.js';
import { planChangeLabel, startedPlanChanges } from '../src/shared/planChanges.js';
import { fixture } from './helpers.js';

test('same-named custom and built-in changes remain distinguishable in reports', async (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'DIFF-LABEL',
    name: '同名差异',
    fields: [
      { id: 'custom_thickness', label: '厚度', type: 'number', unit: 'mm', options: [] },
      { id: 'custom_protocol', label: '实验制度', type: 'text', unit: '', options: [] },
      { id: 'pressure', label: '压力', type: 'number', unit: 'MPa', options: [] },
    ],
  }).experimentId!;
  const itemId = store.command({
    type: 'addSamples',
    experimentId,
    patch: {
      name: '样品组',
      state: '固溶',
      preparedCount: 1,
      thickness: '1',
      thicknessUnit: 'mm',
      protocol: '内置开始值',
      values: { custom_thickness: 3, custom_protocol: '自定义开始值', pressure: 0 },
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
      thickness: '2',
      thicknessUnit: 'mm',
      protocol: '内置实际值',
      custom_thickness: 5,
      custom_protocol: '自定义实际值',
      pressure: 1,
    },
  });
  const snapshot = store.snapshot();
  const changes = startedPlanChanges(snapshot.runs[0]);
  assert.equal(
    new Set(changes.map((change) => `${change.source}:${change.key}`)).size,
    changes.length,
  );
  assert.deepEqual(changes.map(planChangeLabel), [
    '厚度',
    '实验制度',
    '厚度（自定义）',
    '实验制度（自定义）',
    '压力',
  ]);
  const report = await renderReport(snapshot, experimentId, store.root);
  assert.match(report.html, /<th>厚度<\/th><td>1 mm → 2 mm<\/td>/);
  assert.match(report.html, /<th>厚度（自定义）<\/th><td>3 → 5<\/td>/);
  assert.match(report.html, /<th>实验制度（自定义）<\/th><td>自定义开始值 → 自定义实际值<\/td>/);
  assert.match(report.markdown, /厚度（自定义）：3 → 5/);
  assert.match(report.markdown, /实验制度（自定义）：自定义开始值 → 自定义实际值/);
  const rows = csvRows(snapshot, experimentId);
  const header = rows[0].map(String);
  const operation = rows.find((row) => row[header.indexOf('plan_item_id')] === itemId)!;
  assert.match(String(operation[header.indexOf('实际与开始时不同')]), /厚度（自定义）：3 → 5/);
});
