import test from 'node:test';
import assert from 'node:assert/strict';
import { overviewIssue, overviewOperation } from '../src/ui/overview.js';
import { reportInsights } from '../src/shared/summary.js';
import { fixture } from './helpers.js';

test('overview uses physical identities through repeat/spare transitions and frozen run details after plan edits', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'OV-01',
    name: '概览实验',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { name: '原样品', state: '原状态', preparedCount: 6 },
    count: 4,
  });
  const original = store.snapshot();
  assert.deepEqual(
    [
      reportInsights(original, experimentId).preparedKnown,
      reportInsights(original, experimentId).plannedSamples,
      reportInsights(original, experimentId).plannedOperations,
      reportInsights(original, experimentId).spareKnown,
    ],
    [6, 4, 4, 2],
  );
  const item = original.items[0];
  store.command({ type: 'start', itemId: item.id });
  store.command({
    type: 'addEvent',
    experimentId,
    itemId: item.id,
    eventType: 'issue',
    text: '开始时的问题',
  });
  store.command({ type: 'finish', itemId: item.id });
  const recorded = store.snapshot().runs[0];
  store.command({ type: 'repeat', itemId: item.id });
  store.command({
    type: 'updateGroups',
    ids: [original.groups[0].id],
    patch: { name: '后续名称', state: '后续状态', thickness: '9', thicknessUnit: 'μm' },
  });
  let snapshot = store.snapshot();
  const insight = reportInsights(snapshot, experimentId);
  assert.deepEqual(
    [
      insight.plannedSamples,
      insight.plannedOperations,
      insight.spareKnown,
      insight.repeats,
      insight.unresolvedIssues,
    ],
    [4, 5, 2, 1, 1],
  );
  assert.equal(new Set(snapshot.items.map((i) => i.sampleId)).size, 4);
  assert.deepEqual(snapshot.runs[0], recorded);
  const target = overviewIssue(
    snapshot,
    snapshot.events.find((e) => e.type === 'issue')!,
  )!;
  assert.equal(target.item.id, item.id);
  assert.equal(target.sample!.id, item.sampleId);
  assert.equal(target.group!.name, '原样品');
  assert.equal(target.group!.state, '原状态');
  const repeated = snapshot.items.find((i) => i.repeatOf === item.id)!;
  assert.equal(overviewOperation(snapshot, repeated).group!.name, '后续名称');
  store.command({ type: 'arrange', groupId: original.groups[0].id, count: 1 });
  snapshot = store.snapshot();
  assert.deepEqual(
    [
      reportInsights(snapshot, experimentId).plannedSamples,
      reportInsights(snapshot, experimentId).plannedOperations,
      reportInsights(snapshot, experimentId).spareKnown,
    ],
    [5, 6, 1],
  );
  assert.deepEqual(snapshot.runs[0], recorded);
});

test('experiment-level issues have no sample target; run-only issues locate the physical sample and resolution remains independent of completion', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'OV-02',
    name: '问题实验',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '问题状态', preparedCount: 1 },
    count: 1,
  });
  const item = store.snapshot().items[0];
  store.command({ type: 'start', itemId: item.id });
  const run = store.snapshot().runs[0];
  store.command({ type: 'addEvent', experimentId, eventType: 'issue', text: '实验问题' });
  store.command({
    type: 'addEvent',
    experimentId,
    runId: run.id,
    eventType: 'issue',
    text: '实际记录问题',
  });
  store.command({ type: 'finish', itemId: item.id });
  const snapshot = store.snapshot();
  const experimentIssue = snapshot.events.find((e) => e.text === '实验问题')!;
  const runIssue = snapshot.events.find((e) => e.text === '实际记录问题')!;
  assert.equal(experimentIssue.itemId, null);
  assert.equal(experimentIssue.runId, null);
  assert.equal(overviewIssue(snapshot, experimentIssue), undefined);
  assert.equal(runIssue.itemId, null);
  assert.equal(overviewIssue(snapshot, runIssue)!.sample!.id, item.sampleId);
  assert.equal(overviewIssue(snapshot, runIssue)!.item.id, item.id);
  assert.equal(reportInsights(snapshot, experimentId).completed, 1);
  assert.equal(reportInsights(snapshot, experimentId).unresolvedIssues, 2);
  store.command({ type: 'resolveIssue', eventId: experimentIssue.id });
  const resolved = store.snapshot();
  assert.equal(reportInsights(resolved, experimentId).unresolvedIssues, 1);
  assert.deepEqual(resolved.runs, snapshot.runs);
  assert.deepEqual(resolved.items, snapshot.items);
});
