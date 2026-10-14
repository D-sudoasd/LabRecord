import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/desktop/reports.js';
import { csvRows } from '../src/desktop/tables.js';
import { nextOperationBrief } from '../src/shared/library.js';
import { repeatSource, repeatSourceIssueLabel, repeatSourceLabel, repeatSourceOpenIssues } from '../src/shared/repeats.js';
import { queueSearchText } from '../src/ui/queueSearch.js';
import { fixture } from './helpers.js';

test('a retest points at the original run folder and scan without changing that run', async (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'RP-1',
    name: '重测来源',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '原状态', preparedCount: 1, notes: '隐藏词ZZZ' },
    count: 1,
  });
  const original = store.snapshot().items[0];
  store.command({ type: 'start', itemId: original.id });
  store.command({ type: 'finish', itemId: original.id });
  const finished = store.snapshot().runs[0];
  store.command({
    type: 'saveRun',
    runId: finished.id,
    notes: '现场备注ZZZ',
    actual: { scanId: 'SCAN-REPEAT-01' },
  });
  store.command({ type: 'repeat', itemId: original.id });
  const snapshot = store.snapshot();
  const repeat = snapshot.items.find((item) => item.repeatOf === original.id)!;
  const source = repeatSource(snapshot, repeat);
  assert.equal(source?.itemId, original.id);
  assert.equal(source?.sampleCode, finished.snapshot.sample.code);
  assert.equal(source?.sampleId, finished.snapshot.sample.id);
  assert.equal(source?.sampleId, repeat.sampleId);
  assert.equal(source?.folder, finished.filename);
  assert.equal(source?.scanId, 'SCAN-REPEAT-01');
  assert.equal(JSON.stringify(source).includes('隐藏词ZZZ'), false);
  assert.equal(JSON.stringify(source).includes('现场备注ZZZ'), false);
  assert.equal(repeatSource(snapshot, original), null);
  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.runs[0].originalStartedAt, finished.originalStartedAt);
  assert.equal(snapshot.runs[0].originalEndedAt, finished.originalEndedAt);
  assert.equal(snapshot.runs[0].snapshot.sample.id, finished.snapshot.sample.id);
  const label = repeatSourceLabel(snapshot, repeat);
  assert.equal(label, `${source?.sampleCode} · 扫描 SCAN-REPEAT-01 · ${finished.filename}`);
  assert.equal(repeatSourceLabel(snapshot, original), '');
  const report = await renderReport(snapshot, experimentId, store.root);
  assert.ok(report.html.includes(`重测来源: ${label}`));
  assert.ok(report.markdown.includes(`重测来源：${label}`));
  assert.ok(report.html.includes(`原操作: ${original.id}`));
  const rows = csvRows(snapshot, experimentId);
  const header = rows[0].map(String);
  const operation = rows.find((row) => row[header.indexOf('记录类型')] === '操作' && row[header.indexOf('plan_item_id')] === repeat.id);
  assert.equal(operation?.[header.indexOf('重测来源')], label);
  assert.equal(operation?.[header.indexOf('原操作ID')], original.id);
  const plain = rows.find((row) => row[header.indexOf('记录类型')] === '操作' && row[header.indexOf('plan_item_id')] === original.id);
  assert.equal(plain?.[header.indexOf('重测来源')], '');
  assert.equal(store.snapshot().runs[0].originalEndedAt, finished.originalEndedAt);
});

test('a retest names unresolved issues from the original and ignores notes', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'RP-2',
    name: '重测问题',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '原状态', preparedCount: 1, notes: '隐藏词ZZZ' },
    count: 1,
  });
  const original = store.snapshot().items[0];
  store.command({ type: 'start', itemId: original.id });
  store.command({ type: 'finish', itemId: original.id });
  const run = store.snapshot().runs[0];
  store.command({
    type: 'saveRun',
    runId: run.id,
    notes: '现场备注ZZZ',
  });
  store.command({
    type: 'addEvent',
    experimentId,
    itemId: original.id,
    runId: run.id,
    eventType: 'issue',
    text: '样品定位偏离',
  });
  store.command({
    type: 'addEvent',
    experimentId,
    itemId: original.id,
    runId: run.id,
    eventType: 'issue',
    text: '已经处理好的问题',
  });
  const resolved = store.snapshot().events.find((event) => event.text === '已经处理好的问题')!;
  store.command({ type: 'resolveIssue', eventId: resolved.id });
  store.command({ type: 'repeat', itemId: original.id });
  const snapshot = store.snapshot();
  const repeat = snapshot.items.find((item) => item.repeatOf === original.id)!;
  assert.deepEqual(repeatSourceOpenIssues(snapshot, repeat), ['样品定位偏离']);
  assert.equal(repeatSourceIssueLabel(snapshot, repeat), '原操作未处理问题：样品定位偏离');
  assert.equal(repeatSourceIssueLabel(snapshot, repeat).includes('现场备注ZZZ'), false);
  assert.equal(repeatSourceIssueLabel(snapshot, repeat).includes('隐藏词ZZZ'), false);
  assert.equal(repeatSourceIssueLabel(snapshot, repeat).includes('已经处理好的问题'), false);
  assert.equal(repeatSourceLabel(snapshot, repeat).includes('样品定位偏离'), false);
  const brief = nextOperationBrief(snapshot, experimentId);
  assert.equal(brief?.itemId, repeat.id);
  assert.equal(brief?.sourceIssue, '原操作未处理问题：样品定位偏离');
  assert.equal(brief?.repeat.includes('样品定位偏离'), false);
  assert.equal(queueSearchText(snapshot, repeat).includes('样品定位偏离'), false);
  assert.equal(repeatSourceIssueLabel(snapshot, original), '');
  store.command({
    type: 'resolveIssue',
    eventId: snapshot.events.find((event) => event.text === '样品定位偏离')!.id,
  });
  assert.equal(repeatSourceIssueLabel(store.snapshot(), repeat), '');
  assert.equal(store.snapshot().runs[0].originalStartedAt, run.originalStartedAt);
  assert.equal(store.snapshot().runs[0].originalEndedAt, run.originalEndedAt);
  assert.deepEqual(store.snapshot().runs[0].snapshot, run.snapshot);
  assert.equal(store.snapshot().runs.length, 1);
});
