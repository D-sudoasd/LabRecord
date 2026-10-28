import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createBackup, unpackBackup } from '../src/desktop/backups.js';
import { previewSampleCodeChange } from '../src/shared/measurement.js';
import {
  CODE_PATTERN_HYPHEN,
  CODE_PATTERN_PAD,
  planSpecimens,
  prefixFromCodes,
} from '../src/shared/model.js';
import { fixture } from './helpers.js';

test('empty compact prefix has the same default in the preview and in the store', (t) => {
  assert.equal(planSpecimens([], 1, '', { state: '' }, CODE_PATTERN_HYPHEN)[0].code, 'G-1');
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'DEFAULT',
    name: '默认编号',
  }).experimentId!;
  const itemId = store.command({
    type: 'addSamples',
    experimentId,
    patch: { name: 'A' },
    count: 1,
    prefix: '',
  }).itemId!;
  assert.equal(store.get('items', itemId).plannedName, 'G-1');
});

test('prefix lookup permits padded serials to grow past their minimum width', () => {
  assert.equal(prefixFromCodes(['G99', 'G100'], CODE_PATTERN_PAD), 'G');
});

test('each experiment reserves compact measurement names without changing the physical sample count', (t) => {
  const { store } = fixture(t);
  const first = store.command({
    type: 'createExperiment',
    code: 'BT-1',
    name: '第一轮',
  }).experimentId!;
  const added = store.command({
    type: 'addSamples',
    experimentId: first,
    patch: { name: '样品 A', preparedCount: 3 },
    count: 2,
  });
  let data = store.snapshot();
  assert.deepEqual(
    data.samples.map((sample) => sample.code),
    ['G-1', 'G-2'],
  );
  assert.deepEqual(
    data.items.map((item) => item.plannedName),
    ['G-1', 'G-2'],
  );
  const firstItem = added.itemId!;
  const appended = store.command({ type: 'scheduleMeasurements', itemIds: [firstItem] }).itemId!;
  data = store.snapshot();
  assert.equal(data.items.find((item) => item.id === appended)?.plannedName, 'G-1-2');
  assert.equal(data.samples.length, 2);
  assert.equal(
    data.items.find((item) => item.id === appended)?.sampleId,
    data.items.find((item) => item.id === firstItem)?.sampleId,
  );
  const names = new Map(data.items.map((item) => [item.id, item.plannedName]));
  store.command({
    type: 'reorder',
    experimentId: first,
    ids: data.items.map((item) => item.id).reverse(),
  });
  store.command({
    type: 'configureMeasurements',
    ids: [appended],
    measurement: { protocol: '原位条件' },
  });
  assert.deepEqual(
    new Map(store.snapshot().items.map((item) => [item.id, item.plannedName])),
    names,
  );
  store.command({ type: 'start', itemId: firstItem });
  store.command({ type: 'finish', itemId: firstItem });
  const run = structuredClone(store.snapshot().runs[0]);
  const repeat = store.command({ type: 'repeat', itemId: firstItem }).itemId!;
  assert.equal(store.get('items', repeat).plannedName, 'G-1-3');
  assert.equal(store.get('items', repeat).repeatOf, firstItem);
  assert.deepEqual(store.snapshot().runs[0], run);
  const second = store.command({
    type: 'createExperiment',
    code: 'BT-2',
    name: '第二轮',
  }).experimentId!;
  const another = store.command({
    type: 'addSamples',
    experimentId: second,
    patch: { name: '样品 B' },
    count: 1,
  }).itemId!;
  assert.equal(store.get('items', another).plannedName, 'G-1');
});

test('an explicit base-code edit previews exactly the pending changes and cannot change a started sample', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'EDIT',
    name: '修改编号',
  }).experimentId!;
  const itemId = store.command({
    type: 'addSamples',
    experimentId,
    patch: { name: '原始标签' },
    count: 1,
  }).itemId!;
  const nextId = store.command({ type: 'scheduleMeasurements', itemIds: [itemId] }).itemId!;
  const before = store.snapshot();
  const sampleId = before.items.find((item) => item.id === itemId)!.sampleId;
  const preview = previewSampleCodeChange(before, sampleId, 'H-5');
  assert.deepEqual(
    preview.map(({ oldName, newName }) => [oldName, newName]),
    [
      ['G-1', 'H-5'],
      ['G-1-2', 'H-5-2'],
    ],
  );
  assert.deepEqual(store.snapshot(), before);
  store.command({ type: 'updateSamples', ids: [sampleId], code: 'H-5' });
  assert.deepEqual(
    preview.map(({ itemId: id, newName }) => [id, newName]),
    [itemId, nextId].map((id) => [id, store.get('items', id).plannedName]),
  );
  store.command({ type: 'start', itemId });
  const started = store.snapshot();
  assert.throws(
    () => store.command({ type: 'updateSamples', ids: [sampleId], code: 'H-6' }),
    /已开始|已有.*记录/,
  );
  assert.deepEqual(store.snapshot(), started);
  store.command({ type: 'updateSamples', ids: [sampleId], parameters: { name: '补充原始标签' } });
  assert.equal(store.get('items', nextId).plannedName, 'H-5-2');
});

test('cross-experiment duplicate names round trip a backup while same-experiment conflicts fail', async (t) => {
  const { store, directory } = fixture(t);
  const one = store.command({ type: 'createExperiment', code: 'A', name: 'A' }).experimentId!;
  const two = store.command({ type: 'createExperiment', code: 'B', name: 'B' }).experimentId!;
  const a = store.command({
    type: 'addSamples',
    experimentId: one,
    patch: { name: 'A' },
    count: 1,
  }).itemId!;
  const b = store.command({
    type: 'addSamples',
    experimentId: two,
    patch: { name: 'B' },
    count: 1,
  }).itemId!;
  assert.equal(store.get('items', a).plannedName, 'G-1');
  assert.equal(store.get('items', b).plannedName, 'G-1');
  const extra = store.command({ type: 'scheduleMeasurements', itemIds: [a] }).itemId!;
  assert.throws(
    () =>
      store.command({
        type: 'configureMeasurements',
        ids: [extra],
        measurement: { customName: 'g-1' },
      }),
    /已被/,
  );
  const path = join(directory, 'per-experiment.labrecord');
  await createBackup(store, path);
  const restored = await unpackBackup(path, join(directory, 'restore'));
  assert.deepEqual(restored, store.snapshot());
});

test('preexisting names and explicit legacy naming rules remain unchanged', (t) => {
  const { store, reopen } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'OLD',
    name: '旧记录',
    namingPattern: '{experiment}_{sample}',
    sampleCodePattern: '',
  }).experimentId!;
  const itemId = store.command({
    type: 'addSamples',
    experimentId,
    patch: { name: '旧样品' },
    count: 1,
    prefix: 'S',
  }).itemId!;
  assert.equal(store.get('items', itemId).plannedName, 'OLD_S01');
  store.command({ type: 'updateExperiment', id: experimentId, namingPattern: '{sample}' });
  assert.equal(store.get('items', itemId).plannedName, 'OLD_S01');
  assert.equal(reopen().get('items', itemId).plannedName, 'OLD_S01');
});
