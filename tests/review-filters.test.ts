import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/desktop/reports.js';
import { operationRows } from '../src/desktop/tables.js';
import { issueEarlierText } from '../src/shared/history.js';
import { reportInsights } from '../src/shared/summary.js';
import {
  actualFileReferences,
  actualFilenameLabel,
  followUpLabels,
  matchesReviewFilters,
  reviewFilterItemIds,
} from '../src/ui/reviewFilters.js';
import { actualScanLabel } from '../src/shared/copyText.js';
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
  assert.deepEqual(followUpLabels(itemIds[0], filterIds), ['未处理问题']);
  assert.deepEqual(followUpLabels(itemIds[1], filterIds), ['时间不完整', '未处理问题']);
  assert.deepEqual(followUpLabels(itemIds[2], filterIds), ['文件未关联']);
  assert.deepEqual(followUpLabels(itemIds[3], filterIds), []);
});

test('editing an issue keeps its time, status and the earlier wording', async (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'ISSUE-1',
    name: '改正问题',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '原状态', preparedCount: 2 },
    count: 1,
  });
  const item = store.snapshot().items[0];
  store.command({ type: 'start', itemId: item.id });
  const run = store.snapshot().runs[0];
  store.command({
    type: 'addEvent',
    experimentId,
    itemId: item.id,
    runId: run.id,
    eventType: 'note',
    text: '这是备注',
  });
  store.command({
    type: 'addEvent',
    experimentId,
    itemId: item.id,
    runId: run.id,
    eventType: 'issue',
    text: '样品定位偏离',
    category: '装样问题',
  });
  const issue = store.snapshot().events.find((event) => event.type === 'issue')!;
  const note = store.snapshot().events.find((event) => event.text === '这是备注')!;
  assert.throws(() => store.command({ type: 'editIssue', eventId: note.id, text: '改备注' }), /不是问题/);
  store.command({ type: 'editIssue', eventId: issue.id, text: '样品定位偏离' });
  assert.equal(store.snapshot().events.find((event) => event.id === issue.id)?.text, '样品定位偏离');
  store.command({ type: 'resolveIssue', eventId: issue.id });
  const resolvedAt = store.snapshot().events.find((event) => event.id === issue.id)?.data.resolvedAt;
  store.command({ type: 'editIssue', eventId: issue.id, text: '样品已重新装正' });
  const edited = store.snapshot().events.find((event) => event.id === issue.id)!;
  assert.equal(edited.text, '样品已重新装正');
  assert.equal(edited.createdAt, issue.createdAt);
  assert.equal(edited.data.resolvedAt, resolvedAt);
  assert.equal(edited.data.category, '装样问题');
  assert.deepEqual(edited.data.previousText, ['样品定位偏离']);
  assert.equal(issueEarlierText(edited), '曾写 样品定位偏离');
  assert.equal(issueEarlierText(note), '');
  const report = await renderReport(store.snapshot(), experimentId, store.root);
  assert.equal(report.html.includes('曾写 样品定位偏离'), true);
  assert.equal(report.html.includes('样品已重新装正'), true);
  const rows = operationRows(store.snapshot(), experimentId);
  const header = rows[0].map(String);
  const problemColumn = header.indexOf('问题记录');
  const problem = String(rows[1][problemColumn]);
  assert.equal(problem.includes('样品已重新装正'), true);
  assert.equal(problem.includes('曾写 样品定位偏离'), true);
  assert.equal(problem.includes('这是备注'), false);
  assert.equal(store.snapshot().events.find((event) => event.id === note.id)?.text, '这是备注');
  assert.equal(store.snapshot().runs[0].originalStartedAt, run.originalStartedAt);
  assert.deepEqual(store.snapshot().runs[0].snapshot, run.snapshot);
  assert.equal(store.snapshot().runs[0].endedAt, null);
  assert.equal(store.snapshot().groups[0].preparedCount, 2);
});

test('actual filename label keeps only the saved file name', () => {
  assert.equal(actualFilenameLabel(undefined), '');
  assert.equal(actualFilenameLabel({ actual: { filename: '   ' } } as never), '');
  const label = actualFilenameLabel({
    actual: { filename: ' frame-001.cbf ', files: 'E:\\raw\\hidden.cbf' },
  } as never);
  assert.equal(label, '文件 frame-001.cbf');
  assert.equal(label.includes('hidden.cbf'), false);
  assert.equal(actualScanLabel(undefined), '');
  assert.equal(actualScanLabel({ actual: { scanId: '  ' } } as never), '');
  assert.equal(actualScanLabel({ actual: { scanId: ' SCAN-RUN-1 ' } } as never), '扫描 SCAN-RUN-1');
});
