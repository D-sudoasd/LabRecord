import test from 'node:test';
import assert from 'node:assert/strict';
import { groupCounts, filenameFor } from '../src/shared/model.js';
import { fixture } from './helpers.js';

test('prepared 6 / planned 4 / spare 2; spare, repeat, skip and interrupt remain distinct', (t) => {
  const { store } = fixture(t);
  store.command({ type: 'demo' });
  const original = store.snapshot(),
    group = original.groups[0];
  assert.deepEqual(groupCounts(original, group), {
    planned: 4,
    spare: 2,
    shortage: 0,
    completed: 0,
    total: 4,
  });
  store.command({ type: 'start', itemId: original.items[0].id });
  const finished = store.command({ type: 'finish', itemId: original.items[0].id });
  assert.equal(finished.itemId, original.items[1].id);
  assert.equal(finished.snapshot.items[1].status, 'pending'); // Selection does not start the next sample.
  store.command({ type: 'skip', itemId: original.items[1].id });
  store.command({ type: 'start', itemId: original.items[2].id });
  store.command({ type: 'interrupt', itemId: original.items[2].id });
  store.command({ type: 'arrange', groupId: group.id, count: 1, prefix: 'TA-' });
  const repeat = store.command({ type: 'repeat', itemId: original.items[0].id });
  assert.equal(
    repeat.snapshot.items.find((i) => i.id === repeat.itemId)!.sampleId,
    original.items[0].sampleId,
  );
  assert.deepEqual(groupCounts(repeat.snapshot, group), {
    planned: 5,
    spare: 1,
    shortage: 0,
    completed: 1,
    total: 6,
  });
  assert.equal(repeat.snapshot.items.filter((i) => i.status === 'skipped').length, 1);
  assert.equal(repeat.snapshot.items.filter((i) => i.status === 'interrupted').length, 1);
  assert.equal(repeat.snapshot.runs.length, 2);
  store.command({ type: 'unskip', itemId: original.items[1].id });
  assert.throws(() => store.command({ type: 'arrange', groupId: group.id, count: 2 }), /准备/);
  assert.equal(store.snapshot().samples.length, 5);
});

test('request IDs and repeated start / finish do not create duplicate records', (t) => {
  const { store } = fixture(t);
  const created = store.command({ type: 'demo' }, 'demo-request');
  store.command({ type: 'demo' }, 'demo-request');
  assert.equal(store.snapshot().experiments.length, 1);
  const itemId = created.itemId!;
  store.command({ type: 'start', itemId }, 'start-request');
  store.command({ type: 'start', itemId });
  store.command({ type: 'start', itemId }, 'start-request');
  store.command({ type: 'finish', itemId });
  store.command({ type: 'finish', itemId });
  assert.equal(store.snapshot().runs.length, 1);
  assert.equal(store.snapshot().events.filter((e) => e.type === 'start').length, 1);
  assert.equal(store.snapshot().events.filter((e) => e.type === 'finish').length, 1);
  assert.throws(() => store.command({ type: 'finish', itemId }, 'start-request'), /另一项/);
});

test('one active operation across experiments; unfinished operation survives reopening', (t) => {
  const f = fixture(t);
  const first = f.store.command({ type: 'demo' });
  const second = f.store.command({ type: 'demo' });
  f.store.command({ type: 'start', itemId: first.itemId! });
  assert.throws(() => f.store.command({ type: 'start', itemId: second.itemId! }), /进行中/);
  f.reopen();
  const snapshot = f.store.snapshot();
  assert.equal(snapshot.items.find((i) => i.id === first.itemId)!.status, 'running');
  assert.equal(snapshot.runs[0].endedAt, null);
  assert.equal(snapshot.runs[0].originalEndedAt, null);
});

test('midnight crossing and time corrections preserve automatic originals and previous revisions', (t) => {
  let now = new Date('2026-10-05T23:59:55+08:00');
  const { store } = fixture(t, () => now);
  const itemId = store.command({ type: 'demo' }).itemId!;
  store.command({ type: 'start', itemId });
  const start = store.snapshot().runs[0].startedAt;
  now = new Date('2026-10-06T00:03:10+08:00');
  store.command({ type: 'finish', itemId });
  const end = store.snapshot().runs[0].endedAt;
  assert.equal(Date.parse(end!) - Date.parse(start!), 195000);
  store.command({
    type: 'times',
    itemId,
    startedAt: '2026-10-05T23:58:00+08:00',
    endedAt: '2026-10-06T00:04:00+08:00',
    reason: '按实验日志修正',
  });
  store.command({ type: 'times', itemId, startedAt: start, endedAt: null });
  now = new Date('2026-10-06T00:05:00+08:00');
  store.command({ type: 'finish', itemId });
  const run = store.snapshot().runs[0];
  assert.equal(run.originalStartedAt, start);
  assert.equal(run.originalEndedAt, end);
  const history = store.snapshot().events.filter((e) => e.type === 'correction');
  assert.deepEqual(history[0].data.previous, { startedAt: start, endedAt: end });
  assert.equal(history.length, 2);
  assert.throws(
    () =>
      store.command({
        type: 'times',
        itemId,
        startedAt: '2026-10-06T00:10:00Z',
        endedAt: '2026-10-06T00:09:00Z',
      }),
    /早于/,
  );
});

test('unknown start can be manually recorded with end only; no invented original timestamps', (t) => {
  const { store } = fixture(t);
  const itemId = store.command({ type: 'demo' }).itemId!;
  store.command({ type: 'times', itemId, startedAt: null, endedAt: '2026-10-05T20:00:00+08:00' });
  const run = store.snapshot().runs[0];
  assert.equal(run.startedAt, null);
  assert.equal(run.originalStartedAt, null);
  assert.equal(run.originalEndedAt, null);
  assert.equal(store.snapshot().items[0].status, 'completed');
});

test('plan snapshots and custom units stay unchanged after editing the plan', (t) => {
  const { store } = fixture(t);
  const { itemId, experimentId } = store.command({ type: 'demo' });
  store.command({ type: 'start', itemId });
  const before = store.snapshot().runs[0];
  store.command({
    type: 'updateGroups',
    ids: [before.snapshot.group.id],
    patch: { state: '改名状态', thickness: '1.2', values: { temperature: 100 } },
  });
  store.command({ type: 'updateSamples', ids: [before.sampleId], code: '000012' });
  store.command({ type: 'updateExperiment', id: experimentId, fields: [] });
  store.command({
    type: 'saveRun',
    runId: before.id,
    actual: { thickness: '1.0', temperature: 30 },
    notes: '现场变化',
  });
  const run = store.snapshot().runs[0];
  assert.deepEqual(run.snapshot, before.snapshot);
  assert.equal(run.snapshot.sample.code, 'TA-01');
  assert.equal(run.snapshot.fields[0].unit, '°C');
  assert.equal(run.actual.temperature, 30);
});

test('database write failure rolls back without marking an operation started', (t) => {
  const { store } = fixture(t);
  const itemId = store.command({ type: 'demo' }).itemId!;
  const before = store.snapshot();
  store.db.exec('PRAGMA query_only=ON');
  assert.throws(() => store.command({ type: 'start', itemId }), /readonly/i);
  assert.deepEqual(store.snapshot(), before);
  store.db.exec('PRAGMA query_only=OFF');
  store.command({ type: 'start', itemId });
  assert.equal(store.snapshot().runs.length, 1);
});

test('atomic batch edit, sequential numbering, reorder and temporary sample insertion', (t) => {
  const { store } = fixture(t);
  const demo = store.command({ type: 'demo' });
  const group = demo.snapshot.groups[0];
  assert.throws(
    () =>
      store.command({
        type: 'updateGroups',
        ids: [group.id, 'missing'],
        patch: { priority: 'P2' },
      }),
    /不存在/,
  );
  assert.equal(store.get('groups', group.id).priority, 'P0');
  store.command({ type: 'arrange', groupId: group.id, count: 1, prefix: 'TA-' });
  assert.equal(store.snapshot().samples[4].code, 'TA-05');
  const ids = store
    .snapshot()
    .items.map((i) => i.id)
    .reverse();
  store.command({ type: 'reorder', experimentId: demo.experimentId, ids });
  assert.equal(store.get('items', ids[0]).order, 0);
  const next = store.command({
    type: 'temporary',
    experimentId: demo.experimentId,
    patch: { state: '临时', preparedCount: 1 },
  });
  assert.equal(next.snapshot.items.at(-1)!.status, 'pending');
  assert.equal(next.snapshot.samples.length, 6);
  store.command({ type: 'copyGroup', id: group.id });
  assert.equal(groupCounts(store.snapshot(), store.snapshot().groups.at(-1)!).planned, 0);
});

test('filename rules preserve the source name and refuse duplicates and Windows reserved paths', (t) => {
  const { store } = fixture(t);
  const { itemId, experimentId } = store.command({ type: 'demo' });
  store.command({ type: 'updateExperiment', id: experimentId, namingPattern: '{sample}' });
  store.command({ type: 'start', itemId });
  store.command({ type: 'finish', itemId });
  const repeat = store.command({ type: 'repeat', itemId });
  assert.throws(() => store.command({ type: 'start', itemId: repeat.itemId }), /重复/);
  assert.equal(store.get('items', repeat.itemId!).status, 'pending');
  assert.equal(
    filenameFor('{experiment}_{sample}_{run:03}', 'E01', 'demo-L / A', 2),
    'E01_demo-L___A_002',
  );
  for (const pattern of ['CON', '../{sample}', '{unknown}', 'ends.'])
    assert.throws(() => filenameFor(pattern, 'E01', '001', 1));
});
