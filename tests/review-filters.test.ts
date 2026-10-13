import test from 'node:test';
import assert from 'node:assert/strict';
import { reportInsights } from '../src/shared/summary.js';
import {
  actualFileReferences,
  matchesReviewFilters,
  reviewFilterItemIds,
} from '../src/ui/reviewFilters.js';
import { fixture } from './helpers.js';

test('review filters match report gap counts and resolve open issues by item or run', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'RV-01',
    name: '回看筛选',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '原始状态', preparedCount: 4 },
    count: 4,
  });
  const itemIds = store.snapshot().items.map((item) => item.id);

  store.command({ type: 'start', itemId: itemIds[0] });
  store.command({ type: 'finish', itemId: itemIds[0] });
  const firstRun = store.snapshot().runs.find((run) => run.itemId === itemIds[0])!;
  store.command({ type: 'saveRun', runId: firstRun.id, actual: { filename: 'sample-01.tif' } });

  store.command({ type: 'start', itemId: itemIds[2] });
  store.command({ type: 'finish', itemId: itemIds[2] });

  store.command({ type: 'start', itemId: itemIds[1] });
  const secondRun = store.snapshot().runs.find((run) => run.itemId === itemIds[1])!;
  store.command({ type: 'saveRun', runId: secondRun.id, actual: { scanId: 'scan-02' } });

  store.command({
    type: 'addEvent',
    experimentId,
    itemId: itemIds[0],
    eventType: 'issue',
    text: '按操作关联',
  });
  store.command({
    type: 'addEvent',
    experimentId,
    runId: secondRun.id,
    eventType: 'issue',
    text: '按 run 关联',
  });
  store.command({ type: 'addEvent', experimentId, eventType: 'issue', text: '未关联问题' });
  store.command({
    type: 'addEvent',
    experimentId,
    itemId: itemIds[2],
    eventType: 'issue',
    text: '已处理问题',
  });
  const resolved = store.snapshot().events.find((event) => event.text === '已处理问题')!;
  store.command({ type: 'resolveIssue', eventId: resolved.id });

  const snapshot = store.snapshot();
  const filterIds = reviewFilterItemIds(snapshot, experimentId);
  const insight = reportInsights(snapshot, experimentId);
  assert.equal(filterIds.missingTimes.size, insight.missingTimes);
  assert.equal(filterIds.missingFiles.size, insight.missingFiles);
  assert.equal(insight.missingTimes, 1, 'an unstarted plan has no run and is not counted');
  assert.equal(insight.missingFiles, 1, 'actual scan IDs count as file references');
  assert.equal(insight.unresolvedIssues, 3, 'unlinked issues remain part of the issue count');
  assert.deepEqual([...filterIds.missingTimes], [itemIds[1]]);
  assert.deepEqual([...filterIds.missingFiles], [itemIds[2]]);
  assert.deepEqual(new Set(filterIds.unresolvedIssues), new Set([itemIds[0], itemIds[1]]));
  assert.equal(
    matchesReviewFilters(itemIds[1], ['missingTimes', 'unresolvedIssues'], filterIds),
    true,
  );
  assert.equal(
    matchesReviewFilters(itemIds[2], ['missingFiles', 'unresolvedIssues'], filterIds),
    false,
  );
  assert.deepEqual(actualFileReferences(snapshot.runs.find((run) => run.id === firstRun.id)), [
    { label: '文件名', value: 'sample-01.tif' },
  ]);
  assert.deepEqual(actualFileReferences(undefined), []);
});
