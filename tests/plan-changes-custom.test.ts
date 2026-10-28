import test from 'node:test';
import assert from 'node:assert/strict';
import type { Field } from '../src/shared/model.js';
import {
  actualProtocolLabel,
  operationSizeLine,
  planChangeLabel,
  plannedCustomFieldValue,
  recordedPlanChangeCount,
  recordedPlanDiffers,
  recordedPlanChangeText,
  recordedPlanSearchText,
  startedPlanChanges,
} from '../src/shared/planChanges.js';
import { fixture } from './helpers.js';

const field = (id: string, label: string, type: Field['type'] = 'text'): Field => ({
  id,
  label,
  type,
  unit: '',
  options: [],
});

test('explicit empty specimen values override the group in start comparisons and saved changes', (t) => {
  const data = fixture(t);
  const store = data.store;
  const fields = [
    field('nullOverride', '空温度', 'number'),
    field('groupFallback', '继承温度', 'number'),
    field('zeroOverride', '零值', 'number'),
    field('blankOverride', '空备注'),
  ];
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'CUSTOM-NULL',
    name: '自定义空值',
    fields,
  }).experimentId!;
  const itemId = store.command({
    type: 'addSamples',
    experimentId,
    patch: {
      name: '原始试样',
      preparedCount: 1,
      values: { nullOverride: 375, groupFallback: 350, zeroOverride: 7, blankOverride: '组备注' },
    },
    count: 1,
  }).itemId!;
  const sampleId = store.get('items', itemId).sampleId;
  store.command({
    type: 'updateSamples',
    ids: [sampleId],
    values: { nullOverride: null, zeroOverride: 0, blankOverride: '' },
  });
  store.command({ type: 'start', itemId });
  const started = store.snapshot().runs[0];
  const frozenSnapshot = structuredClone(started.snapshot);
  const originalStartedAt = started.originalStartedAt;
  assert.equal(started.actual.nullOverride, null);
  assert.equal(started.actual.groupFallback, 350);
  assert.equal(started.actual.zeroOverride, 0);
  assert.equal(started.actual.blankOverride, '');
  assert.deepEqual(startedPlanChanges(started), []);
  assert.equal(recordedPlanDiffers(started), false);
  assert.equal(recordedPlanChangeCount(store.snapshot(), experimentId), 0);

  // A later group edit must not replace any value in the start snapshot.
  store.command({
    type: 'updateGroups',
    ids: [started.snapshot.group.id],
    patch: { values: { nullOverride: 999, groupFallback: 999, zeroOverride: 999 } },
  });
  store.command({
    type: 'saveRun',
    runId: started.id,
    actual: { nullOverride: 20, groupFallback: null },
  });
  let current = store.get('runs', started.id);
  assert.deepEqual(current.snapshot, frozenSnapshot);
  assert.equal(current.originalStartedAt, originalStartedAt);
  assert.deepEqual(
    startedPlanChanges(current).map(({ source, key, planned, actual }) => ({
      source,
      key,
      planned,
      actual,
    })),
    [
      { source: 'custom', key: 'nullOverride', planned: '未填写', actual: '20' },
      { source: 'custom', key: 'groupFallback', planned: '350', actual: '未填写' },
    ],
  );
  assert.equal(recordedPlanChangeCount(store.snapshot(), experimentId), 1);

  store.command({
    type: 'saveRun',
    runId: started.id,
    actual: { nullOverride: null, groupFallback: 0, zeroOverride: null, blankOverride: '实测备注' },
  });
  current = store.get('runs', started.id);
  assert.deepEqual(
    startedPlanChanges(current).map(({ key, planned, actual }) => ({ key, planned, actual })),
    [
      { key: 'groupFallback', planned: '350', actual: '0' },
      { key: 'zeroOverride', planned: '0', actual: '未填写' },
      { key: 'blankOverride', planned: '未填写', actual: '实测备注' },
    ],
  );
  const absentActual = structuredClone(current);
  delete absentActual.actual.groupFallback;
  assert.equal(
    startedPlanChanges(absentActual).some((change) => change.key === 'groupFallback'),
    false,
  );
  const reopened = data.reopen().get('runs', started.id);
  assert.deepEqual(reopened.snapshot, frozenSnapshot);
  assert.equal(reopened.originalStartedAt, originalStartedAt);
  assert.deepEqual(startedPlanChanges(reopened), startedPlanChanges(current));
});

test('same-named custom fields cannot impersonate built-in size, protocol, or searchable identity', (t) => {
  const { store } = fixture(t);
  const fields = [
    field('customProtocol', '实验制度'),
    field('customThickness', '厚度'),
    field('customName', '样品名'),
    field('customMode', '实验方式'),
    field('customPreparation', '制备/试剂'),
  ];
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'CUSTOM-LABELS',
    name: '同名字段',
    fields,
  }).experimentId!;
  const itemId = store.command({
    type: 'addSamples',
    experimentId,
    patch: {
      name: '真实样品',
      protocol: '原制度',
      thickness: '1.0',
      thicknessUnit: 'mm',
      preparedCount: 1,
      values: Object.fromEntries(fields.map((entry) => [entry.id, '开始值'])),
    },
    count: 1,
  }).itemId!;
  store.command({ type: 'start', itemId });
  const started = store.snapshot().runs[0];
  store.command({
    type: 'saveRun',
    runId: started.id,
    actual: Object.fromEntries(fields.map((entry) => [entry.id, '自定义实际值'])),
  });
  let current = store.get('runs', started.id);
  assert.deepEqual(
    startedPlanChanges(current).map((change) => [change.source, change.key]),
    fields.map((entry) => ['custom', entry.id]),
  );
  assert.equal(actualProtocolLabel(current), '');
  assert.equal(operationSizeLine(current.snapshot.group, current), '厚 1.0 mm');
  assert.equal(recordedPlanSearchText(current), '');
  assert.equal(planChangeLabel(startedPlanChanges(current)[0]), '实验制度（自定义）');
  assert.match(recordedPlanChangeText(current), /实验制度（自定义）：开始值 → 自定义实际值/);

  store.command({
    type: 'saveRun',
    runId: started.id,
    actual: { protocol: '真实实际制度', thickness: '2.0' },
    actualSample: { name: '真实实际样品' },
  });
  current = store.get('runs', started.id);
  const changes = startedPlanChanges(current);
  assert.equal(changes.filter((change) => change.label === '实验制度').length, 2);
  assert.equal(
    new Set(changes.map((change) => `${change.source}:${change.key}`)).size,
    changes.length,
  );
  assert.equal(actualProtocolLabel(current), '实际制度 真实实际制度 · 开始时 原制度');
  assert.equal(
    operationSizeLine(current.snapshot.group, current),
    '实际 厚 2.0 mm · 计划 厚 1.0 mm',
  );
  assert.equal(recordedPlanSearchText(current), '样品名：真实样品 → 真实实际样品');
});

test('planned custom values ignore inherited properties and preserve explicit null, empty string, and zero', () => {
  const group = { zero: 9, blank: 'group', empty: 'group', inherited: 4 };
  const sample = { zero: 0, blank: '', empty: null };
  assert.equal(plannedCustomFieldValue(sample, group, 'zero'), 0);
  assert.equal(plannedCustomFieldValue(sample, group, 'blank'), '');
  assert.equal(plannedCustomFieldValue(sample, group, 'empty'), null);
  assert.equal(plannedCustomFieldValue(sample, group, 'inherited'), 4);
  assert.equal(plannedCustomFieldValue(sample, group, 'missing'), undefined);
  assert.equal(plannedCustomFieldValue(sample, group, 'constructor'), undefined);
});
