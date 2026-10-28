import test from 'node:test';
import assert from 'node:assert/strict';
import { previewSampleCodeChange, validateFieldSampleCodes } from '../src/shared/measurement.js';
import { fixture } from './helpers.js';

function compactExperiment(store: ReturnType<typeof fixture>['store'], code: string) {
  return store.command({ type: 'createExperiment', code, name: code }).experimentId!;
}

function addSample(store: ReturnType<typeof fixture>['store'], experimentId: string, code: string) {
  return store.command({
    type: 'addSamples',
    experimentId,
    patch: { name: code },
    count: 1,
    specimens: [{ code }],
  }).itemId!;
}

test('compact sample codes cannot overlap another physical sample or a batch sibling', (t) => {
  const { store } = fixture(t);
  const experimentId = compactExperiment(store, 'E1');
  const first = addSample(store, experimentId, 'G-1');
  const before = store.snapshot();

  assert.throws(
    () => validateFieldSampleCodes(before, experimentId, ['g-1-2']),
    /其他样品.*不同测量/,
  );
  assert.throws(
    () =>
      store.command({
        type: 'addSamples',
        experimentId,
        patch: { name: 'B' },
        count: 2,
        prefix: 'G-1',
      }),
    /其他样品.*不同测量/,
  );
  assert.deepEqual(store.snapshot(), before, 'the new group and samples roll back together');
  assert.throws(() => addSample(store, experimentId, 'G'), /其他样品.*不同测量/);
  assert.throws(() => addSample(store, experimentId, 'g-1-2-3'), /其他样品.*不同测量/);
  assert.throws(
    () =>
      store.command({
        type: 'addSamples',
        experimentId,
        patch: { name: 'C' },
        count: 2,
        specimens: [{ code: 'T-1' }, { code: 'T-1-2' }],
      }),
    /其他样品.*不同测量/,
  );
  assert.deepEqual(store.snapshot(), before);

  const second = addSample(store, experimentId, 'G-2');
  const next = store.command({ type: 'scheduleMeasurements', itemIds: [first] }).itemId!;
  const after = store.snapshot();
  assert.equal(store.get('items', next).plannedName, 'G-1-2');
  assert.equal(store.get('items', next).sampleId, store.get('items', first).sampleId);
  assert.notEqual(store.get('items', second).sampleId, store.get('items', first).sampleId);
  assert.equal(after.samples.length, 2);

  const anotherExperiment = compactExperiment(store, 'E2');
  assert.equal(store.get('items', addSample(store, anotherExperiment, 'G-1')).plannedName, 'G-1');
});

test('arrange and rename preview both reject a name that belongs to another sample', (t) => {
  const { store } = fixture(t);
  const experimentId = compactExperiment(store, 'EDIT');
  addSample(store, experimentId, 'G-1');
  const itemId = addSample(store, experimentId, 'G-2');
  const sampleId = store.get('items', itemId).sampleId;
  const before = store.snapshot();
  assert.throws(() => previewSampleCodeChange(before, sampleId, 'G-1-2'), /其他样品.*不同测量/);
  assert.throws(
    () => store.command({ type: 'updateSamples', ids: [sampleId], code: 'G-1-2' }),
    /其他样品.*不同测量/,
  );
  assert.deepEqual(store.snapshot(), before);

  store.command({ type: 'createGroup', experimentId, patch: { name: '待安排', preparedCount: 2 } });
  const groupId = store.snapshot().groups.find((group) => group.name === '待安排')!.id;
  const beforeArrange = store.snapshot();
  assert.throws(
    () => store.command({ type: 'arrange', groupId, count: 1, specimens: [{ code: 'G-1-2' }] }),
    /其他样品.*不同测量/,
  );
  assert.deepEqual(store.snapshot(), beforeArrange);
});

test('custom measurement names cannot masquerade as another sample or reserve its namespace', (t) => {
  const { store } = fixture(t);
  const experimentId = compactExperiment(store, 'CUSTOM');
  const first = addSample(store, experimentId, 'G-1');
  const other = addSample(store, experimentId, 'G-2');
  const before = store.snapshot();
  assert.throws(
    () =>
      store.command({
        type: 'configureMeasurements',
        ids: [other],
        measurement: { customName: 'g-1-2' },
      }),
    /其他样品.*不同测量/,
  );
  assert.deepEqual(store.snapshot(), before);
  assert.throws(
    () =>
      store.command({
        type: 'scheduleMeasurements',
        itemIds: [other],
        measurement: { customName: 'G-1-3' },
      }),
    /其他样品.*不同测量/,
  );
  assert.deepEqual(store.snapshot(), before);

  store.command({
    type: 'configureMeasurements',
    ids: [other],
    measurement: { customName: 'F-1-3' },
  });
  const saved = store.snapshot();
  assert.throws(() => addSample(store, experimentId, 'F-1'), /其他样品.*不同测量/);
  const firstSampleId = store.get('items', first).sampleId;
  assert.throws(() => previewSampleCodeChange(saved, firstSampleId, 'f-1'), /其他样品.*不同测量/);
  assert.throws(
    () => store.command({ type: 'updateSamples', ids: [firstSampleId], code: 'f-1' }),
    /其他样品.*不同测量/,
  );
  assert.deepEqual(store.snapshot(), saved);
  const next = store.command({ type: 'scheduleMeasurements', itemIds: [first] }).itemId!;
  assert.equal(store.get('items', next).plannedName, 'G-1-2');
});

test('legacy overlapping codes remain unchanged while new ambiguous operations are refused', (t) => {
  const { store, reopen } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'OLD',
    name: '旧实验',
    namingPattern: '{experiment}_{sample}',
    sampleCodePattern: '',
  }).experimentId!;
  const first = addSample(store, experimentId, 'G-1');
  const other = addSample(store, experimentId, 'G-1-2');
  const oldNames = [store.get('items', first).plannedName, store.get('items', other).plannedName];
  store.command({ type: 'updateExperiment', id: experimentId, namingPattern: '{sample}' });
  const groupId = store.get('samples', store.get('items', first).sampleId).groupId;
  store.command({ type: 'updateGroups', ids: [groupId], patch: { notes: '补充' } });
  assert.deepEqual(
    [store.get('items', first).plannedName, store.get('items', other).plannedName],
    oldNames,
  );
  const before = store.snapshot();
  assert.throws(
    () => store.command({ type: 'scheduleMeasurements', itemIds: [first] }),
    /其他样品.*不同测量/,
  );
  assert.deepEqual(store.snapshot(), before);
  const restored = reopen();
  assert.deepEqual(
    [restored.get('items', first).plannedName, restored.get('items', other).plannedName],
    oldNames,
  );
});

test('a 200-character base is never silently shortened for a second measurement', (t) => {
  const { store } = fixture(t);
  const experimentId = compactExperiment(store, 'LONG');
  const itemId = addSample(store, experimentId, 'X'.repeat(200));
  const before = store.snapshot();
  assert.throws(
    () => store.command({ type: 'scheduleMeasurements', itemIds: [itemId] }),
    /编号太长/,
  );
  assert.deepEqual(store.snapshot(), before);
});
