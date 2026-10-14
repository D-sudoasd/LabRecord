import test from 'node:test';
import assert from 'node:assert/strict';
import type { Snapshot } from '../src/shared/model.js';
import {
  matchesGroupIdentity,
  matchesOperationIdentity,
  recordIdentifiers,
  textIncludes,
} from '../src/shared/operationQuery.js';
import { nextPending } from '../src/shared/library.js';
import { fixture } from './helpers.js';

test('operation filters match stable ids without treating short text as an id', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'ID-1',
    name: '标识筛选',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '状态A', preparedCount: 2, notes: '隐藏词ZZZ' },
    count: 1,
  });
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '状态B', preparedCount: 2 },
    count: 1,
  });
  const initial = store.snapshot();
  const first = initial.items.find((item) => item.order === 0)!;
  const second = initial.items.find((item) => item.order === 1)!;
  store.command({ type: 'start', itemId: first.id });
  store.command({
    type: 'addEvent',
    experimentId,
    itemId: first.id,
    eventType: 'issue',
    text: '事件正文ABC',
  });
  store.command({
    type: 'saveRun',
    runId: store.snapshot().runs[0].id,
    notes: '现场备注不进标识',
  });
  const snapshot = store.snapshot();
  const run = snapshot.runs[0];
  const frozenId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const frozen: Snapshot = {
    ...snapshot,
    runs: snapshot.runs.map((entry) =>
      entry.id === run.id
        ? {
            ...entry,
            snapshot: {
              ...entry.snapshot,
              sample: { ...entry.snapshot.sample, id: frozenId },
            },
          }
        : entry,
    ),
  };
  const before = nextPending(snapshot, experimentId)?.itemId;

  assert.equal(matchesOperationIdentity(frozen, first, frozenId), true);
  assert.equal(matchesOperationIdentity(frozen, first, run.sampleId), true);
  assert.equal(matchesOperationIdentity(frozen, first, first.id), true);
  assert.equal(matchesOperationIdentity(frozen, first, run.id), true);
  assert.equal(matchesOperationIdentity(frozen, first, frozenId.slice(0, 8)), true);
  assert.equal(matchesOperationIdentity(frozen, first, frozenId.slice(0, 7)), false);
  assert.equal(matchesOperationIdentity(frozen, first, 'a'), false);
  assert.equal(matchesOperationIdentity(frozen, first, '--------'), false);
  assert.equal(matchesOperationIdentity(frozen, first, '隐藏词ZZZ'), false);
  assert.equal(matchesOperationIdentity(frozen, first, '事件正文ABC'), false);
  assert.equal(matchesOperationIdentity(frozen, first, '现场备注不进标识'), false);
  assert.equal(matchesOperationIdentity(frozen, second, frozenId), false);
  assert.equal(matchesOperationIdentity(frozen, second, run.id), false);
  assert.equal(matchesOperationIdentity(snapshot, second, second.id), true);
  assert.equal(textIncludes('现场备注不进标识', '现场备注'), true);

  const groupA = snapshot.samples.find((sample) => sample.id === first.sampleId)!.groupId;
  const groupB = snapshot.samples.find((sample) => sample.id === second.sampleId)!.groupId;
  assert.equal(matchesGroupIdentity(frozen, groupA, frozenId), true);
  assert.equal(matchesGroupIdentity(frozen, groupA, run.id), true);
  assert.equal(matchesGroupIdentity(frozen, groupB, frozenId), false);
  assert.equal(matchesGroupIdentity(frozen, groupA, '隐藏词ZZZ'), false);
  assert.equal(matchesGroupIdentity(snapshot, groupA, groupA), true);
  const renamed: Snapshot = {
    ...frozen,
    items: frozen.items.map((item) =>
      item.id === first.id ? { ...item, plannedName: '后来的计划名' } : item,
    ),
  };
  assert.equal(recordIdentifiers(renamed, first.id)?.sampleId, frozenId);
  assert.equal(recordIdentifiers(renamed, first.id)?.folder, run.filename);
  assert.notEqual(recordIdentifiers(renamed, first.id)?.folder, '后来的计划名');
  assert.equal(recordIdentifiers(snapshot, second.id)?.sampleId, second.sampleId);
  assert.equal(recordIdentifiers(snapshot, second.id)?.folder, second.plannedName);
  assert.equal(recordIdentifiers(snapshot, 'missing'), null);
  assert.equal(nextPending(snapshot, experimentId)?.itemId, before);
  assert.equal(snapshot.runs[0].originalStartedAt, run.originalStartedAt);
  assert.equal(snapshot.runs[0].snapshot.sample.id, run.snapshot.sample.id);
});
