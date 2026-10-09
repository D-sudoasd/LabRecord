import test from 'node:test';
import assert from 'node:assert/strict';
import { groupCounts } from '../src/shared/model.js';
import { fixture } from './helpers.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const { store } = fixture(t);
  const created = store.command({ type: 'createExperiment', name: '删除', code: 'DEL' });
  return { store, experimentId: created.experimentId! };
}

test('unstarted groups, samples and measurements can be removed without renaming what remains', (t) => {
  const { store, experimentId } = setup(t);
  const empty = store.command({
    type: 'addSamples',
    experimentId,
    count: 0,
    patch: { name: '空组', state: '未测', preparedCount: 3 },
  });
  const added = store.command({
    type: 'addSamples',
    experimentId,
    count: 2,
    patch: { name: '待删', state: '待安排', preparedCount: 4 },
  });
  const first = store.get('items', added.itemId!);
  store.command({ type: 'scheduleMeasurements', itemIds: [first.id] });
  store.command({
    type: 'addEvent',
    experimentId,
    itemId: first.id,
    eventType: 'note',
    text: '装样前核对',
  });
  const before = store.snapshot();
  const sampleItems = before.items.filter((item) => item.sampleId === first.sampleId);
  assert.equal(sampleItems.length, 2);
  const kept = sampleItems.find((item) => item.id !== first.id)!;
  const other = before.items.find((item) => item.sampleId !== first.sampleId)!;
  const emptyGroup = before.groups.find((group) => group.name === '空组')!;
  assert.equal(empty.experimentId, experimentId);

  store.command({ type: 'deleteItems', ids: [first.id] });
  assert.deepEqual(store.get('items', kept.id), kept);
  assert.deepEqual(store.get('items', other.id), other);
  assert.equal(
    store.snapshot().events.some((event) => event.text === '装样前核对'),
    false,
  );
  assert.equal(
    store.snapshot().events.find((event) => event.text === '删除未开始的测量')?.itemId,
    null,
  );
  assert.equal(
    store.snapshot().samples.some((sample) => sample.id === first.sampleId),
    true,
  );

  store.command({ type: 'deleteItems', ids: [kept.id] });
  const afterItem = store.snapshot();
  assert.equal(
    afterItem.samples.some((sample) => sample.id === first.sampleId),
    false,
  );
  assert.equal(afterItem.groups.find((group) => group.name === '待删')?.preparedCount, 4);
  assert.equal(
    groupCounts(
      afterItem,
      afterItem.groups.find((group) => group.name === '待删')!,
    ).spare,
    3,
  );
  assert.equal(
    groupCounts(
      afterItem,
      afterItem.groups.find((group) => group.name === '待删')!,
    ).planned,
    1,
  );
  assert.deepEqual(store.get('items', other.id), other);

  const skipped = store.command({ type: 'skip', itemId: other.id });
  assert.equal(skipped.snapshot.items.find((item) => item.id === other.id)?.status, 'skipped');
  store.command({ type: 'deleteSamples', ids: [other.sampleId] });
  const afterSample = store.snapshot();
  assert.equal(afterSample.samples.length, 0);
  assert.equal(afterSample.items.length, 0);
  assert.equal(afterSample.groups.find((group) => group.name === '待删')?.preparedCount, 4);
  assert.equal(
    groupCounts(
      afterSample,
      afterSample.groups.find((group) => group.name === '待删')!,
    ).spare,
    4,
  );

  store.command({ type: 'deleteGroups', ids: [emptyGroup.id] }, 'retry-delete');
  const removed = store.snapshot();
  store.command({ type: 'deleteGroups', ids: [emptyGroup.id] }, 'retry-delete');
  assert.deepEqual(store.snapshot(), removed);
  assert.equal(
    removed.groups.some((group) => group.id === emptyGroup.id),
    false,
  );
  assert.equal(
    removed.events.some((event) => event.text === '删除样品组' && event.itemId === null),
    true,
  );
  assert.throws(
    () => store.command({ type: 'deleteGroups', ids: [emptyGroup.id] }, 'again'),
    /记录不存在/,
  );
  assert.throws(() => store.command({ type: 'deleteGroups', ids: [] }), /输入格式/);
});

test('recorded runs, snapshots and original times block deletion and stay unchanged', (t) => {
  const { store, experimentId } = setup(t);
  const added = store.command({
    type: 'addSamples',
    experimentId,
    count: 1,
    patch: { name: '已测', state: '完成', preparedCount: 1 },
  });
  const pending = store.command({
    type: 'addSamples',
    experimentId,
    count: 1,
    patch: { name: '未测', state: '待定', preparedCount: 2 },
  });
  store.command({ type: 'start', itemId: added.itemId! });
  const running = store.snapshot();
  assert.throws(
    () => store.command({ type: 'deleteItems', ids: [added.itemId!] }),
    /进行中的测量不能删除/,
  );
  assert.deepEqual(store.snapshot().runs, running.runs);
  assert.equal(store.snapshot().runs[0].originalStartedAt, running.runs[0].originalStartedAt);
  store.command({ type: 'finish', itemId: added.itemId! });
  const finished = store.snapshot();
  const recordedGroup = finished.groups.find((group) => group.name === '已测')!;
  const openGroup = finished.groups.find((group) => group.name === '未测')!;
  assert.throws(
    () => store.command({ type: 'deleteGroups', ids: [recordedGroup.id] }),
    /已有实际记录/,
  );
  assert.throws(
    () =>
      store.command({
        type: 'deleteSamples',
        ids: [finished.items.find((item) => item.id === added.itemId)!.sampleId],
      }),
    /已有实际记录/,
  );
  assert.throws(() => store.command({ type: 'deleteItems', ids: [added.itemId!] }), /保留记录/);
  assert.throws(
    () => store.command({ type: 'deleteExperiment', id: experimentId }),
    /已有实际记录/,
  );
  assert.deepEqual(store.snapshot().runs, finished.runs);
  assert.deepEqual(
    store.get('items', added.itemId!),
    finished.items.find((item) => item.id === added.itemId),
  );
  assert.deepEqual(store.snapshot().groups, finished.groups);

  const other = store.command({ type: 'createExperiment', name: '另一个', code: 'OTHER' });
  assert.throws(
    () => store.command({ type: 'deleteGroups', ids: [recordedGroup.id, openGroup.id] }),
    /已有实际记录/,
  );
  store.command({
    type: 'addSamples',
    experimentId: other.experimentId!,
    count: 0,
    patch: { name: '外组', state: '外', preparedCount: 1 },
  });
  const outsideGroup = store.snapshot().groups.find((group) => group.name === '外组')!;
  assert.throws(
    () => store.command({ type: 'deleteGroups', ids: [openGroup.id, outsideGroup.id] }),
    /同一实验/,
  );
  assert.throws(
    () => store.command({ type: 'deleteGroups', ids: [openGroup.id, openGroup.id] }),
    /重复/,
  );
  assert.equal(
    store.snapshot().groups.some((group) => group.id === outsideGroup.id),
    true,
  );
  assert.deepEqual(store.snapshot().runs, finished.runs);
  store.command({ type: 'deleteExperiment', id: other.experimentId! });
  assert.equal(
    store.snapshot().experiments.some((entry) => entry.id === other.experimentId),
    false,
  );
  assert.equal(
    store.snapshot().groups.some((group) => group.id === outsideGroup.id),
    false,
  );
  assert.deepEqual(store.snapshot().runs, finished.runs);
  assert.equal(store.get('experiments', experimentId).code, 'DEL');
  const extra = store.command({ type: 'scheduleMeasurements', itemIds: [added.itemId!] });
  const runBefore = store.snapshot().runs[0];
  const completed = store.get('items', added.itemId!);
  store.command({ type: 'deleteItems', ids: [extra.itemId!] });
  assert.equal(store.snapshot().items.some((item) => item.id === extra.itemId), false);
  assert.deepEqual(store.get('items', added.itemId!), completed);
  assert.equal(store.snapshot().samples.some((sample) => sample.id === runBefore.sampleId), true);
  assert.deepEqual(store.snapshot().runs[0], runBefore);
  assert.equal(store.snapshot().items.some((item) => item.id === pending.itemId), true);
});
