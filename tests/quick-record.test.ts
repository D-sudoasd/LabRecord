import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/desktop/reports.js';
import { csvRows, importTable, previewRows } from '../src/desktop/tables.js';
import { fixture } from './helpers.js';

test('quick note events use request ID for idempotent retry', (t) => {
  const { store } = fixture(t);
  const created = store.command({ type: 'demo' });
  const itemId = created.itemId!;
  const experimentId = created.experimentId!;

  // Start the operation
  const started = store.command({ type: 'start', itemId });
  const runId = store.snapshot().runs.find((r) => r.itemId === itemId)!.id;

  // Add quick note with fixed request ID (simulating retry)
  const firstAdd = store.command(
    {
      type: 'addEvent',
      experimentId,
      itemId,
      runId,
      eventType: 'note',
      text: '已装样',
    },
    'quick-note-intent-1',
  );

  assert.equal(
    store.snapshot().events.filter((e) => e.itemId === itemId && e.text === '已装样').length,
    1,
    'First add creates one event',
  );

  // Retry with same request ID
  const retry = store.command(
    {
      type: 'addEvent',
      experimentId,
      itemId,
      runId,
      eventType: 'note',
      text: '已装样',
    },
    'quick-note-intent-1',
  );

  assert.equal(
    store.snapshot().events.filter((e) => e.itemId === itemId && e.text === '已装样').length,
    1,
    'Retry with same request ID does not create duplicate',
  );
});

test('issue events with categories and separate resolution tracking', (t) => {
  const { store } = fixture(t);
  const created = store.command({ type: 'demo' });
  const itemId = created.itemId!;
  const experimentId = created.experimentId!;

  // Start the operation
  store.command({ type: 'start', itemId });
  const runId = store.snapshot().runs.find((r) => r.itemId === itemId)!.id;

  // Add issue with category
  const issueAdd = store.command({
    type: 'addEvent',
    experimentId,
    itemId,
    runId,
    eventType: 'issue',
    text: '装样方向需要重新确认。已调整夹具。',
    category: '装样问题',
  });

  const issue = store.snapshot().events.find((e) => e.type === 'issue' && e.itemId === itemId);
  assert.ok(issue, 'Issue event created');
  assert.equal(issue!.data.category, '装样问题', 'Category preserved');
  assert.equal(issue!.data.resolvedAt, null, 'Not resolved initially');

  // Resolve the issue
  store.command({ type: 'resolveIssue', eventId: issue!.id });
  const resolved = store.snapshot().events.find((e) => e.id === issue!.id);
  assert.ok(resolved!.data.resolvedAt, 'Issue marked as resolved');
});

test('experiment-level issues without item reference', (t) => {
  const { store } = fixture(t);
  const created = store.command({ type: 'demo' });
  const experimentId = created.experimentId!;

  // Add experiment-level issue
  const expIssue = store.command({
    type: 'addEvent',
    experimentId,
    eventType: 'issue',
    text: '设备校准需要检查',
    category: '设备异常',
  });

  const issue = store.snapshot().events.find((e) => e.type === 'issue' && !e.itemId);
  assert.ok(issue, 'Experiment-level issue created');
  assert.equal(issue!.itemId, null, 'itemId is null');
  assert.equal(issue!.runId, null, 'runId is null');
});

test('free notes and quick notes remain separate in timeline', (t) => {
  const { store } = fixture(t);
  const created = store.command({ type: 'demo' });
  const itemId = created.itemId!;
  const experimentId = created.experimentId!;

  // Start and add free note
  const started = store.command({ type: 'start', itemId });
  const runId = store.snapshot().runs.find((r) => r.itemId === itemId)!.id;

  store.command({
    type: 'saveRun',
    runId,
    notes: 'This is a freeform note in the record.',
  });

  // Add quick note event
  store.command(
    {
      type: 'addEvent',
      experimentId,
      itemId,
      runId,
      eventType: 'note',
      text: '已装样',
    },
    'quick-intent',
  );

  const run = store.snapshot().runs.find((r) => r.id === runId);
  assert.equal(
    run!.notes,
    'This is a freeform note in the record.',
    'Free notes preserved in run.notes',
  );

  const quickEvent = store.snapshot().events.find((e) => e.runId === runId && e.text === '已装样');
  assert.ok(quickEvent, 'Quick note preserved as separate event');
});

test('a timeline note can be corrected without changing the record note or an issue', async (t) => {
  const { store } = fixture(t);
  const created = store.command({ type: 'demo' });
  const itemId = created.itemId!;
  const experimentId = created.experimentId!;
  store.command({ type: 'start', itemId });
  const run = store.snapshot().runs.find((entry) => entry.itemId === itemId)!;
  store.command({ type: 'saveRun', runId: run.id, notes: '自由备注保留' });
  store.command({
    type: 'addEvent',
    experimentId,
    itemId,
    runId: run.id,
    eventType: 'note',
    text: '已装样',
  });
  store.command({
    type: 'addEvent',
    experimentId,
    itemId,
    runId: run.id,
    eventType: 'issue',
    text: '样品定位偏离',
  });
  const note = store.snapshot().events.find((event) => event.text === '已装样')!;
  const issue = store.snapshot().events.find((event) => event.text === '样品定位偏离')!;
  assert.throws(() => store.command({ type: 'editNote', eventId: issue.id, text: '不能改问题' }), /时间线备注/);
  assert.throws(() => store.command({ type: 'editIssue', eventId: note.id, text: '不能改备注' }), /问题记录/);
  store.command({ type: 'editNote', eventId: note.id, text: '已装样' });
  assert.equal(store.snapshot().events.find((event) => event.id === note.id)?.data.previousText, undefined);
  store.command({ type: 'editNote', eventId: note.id, text: '装样方向已核对' });
  const edited = store.snapshot().events.find((event) => event.id === note.id)!;
  assert.equal(edited.text, '装样方向已核对');
  assert.equal(edited.createdAt, note.createdAt);
  assert.deepEqual(edited.data.previousText, ['已装样']);
  assert.equal(store.snapshot().runs[0].notes, '自由备注保留');
  assert.equal(store.snapshot().runs[0].originalStartedAt, run.originalStartedAt);
  assert.deepEqual(store.snapshot().runs[0].snapshot, run.snapshot);
  assert.equal(store.snapshot().events.find((event) => event.id === issue.id)?.text, '样品定位偏离');
  const report = await renderReport(store.snapshot(), experimentId, store.root);
  assert.equal(report.html.includes('曾写 已装样'), true);
  assert.equal(report.html.includes('装样方向已核对'), true);
  assert.equal(report.html.includes('previousText'), false);
  const rows = csvRows(store.snapshot(), experimentId);
  const header = rows[0].map(String);
  const earlierColumn = header.indexOf('改前文字');
  const textColumn = header.indexOf('内容');
  const typeColumn = header.indexOf('记录类型');
  const noteRow = rows.find(
    (row) => row[typeColumn] === '事件' && row[textColumn] === '装样方向已核对',
  );
  const issueRow = rows.find(
    (row) => row[typeColumn] === '事件' && row[textColumn] === '样品定位偏离',
  );
  assert.equal(noteRow?.[earlierColumn], '曾写 已装样');
  assert.equal(issueRow?.[earlierColumn], '');
  assert.equal(String(noteRow?.[header.indexOf('详细信息')]).includes('previousText'), true);
  const table = previewRows(rows.map((row) => row.map((cell) => (cell == null ? '' : String(cell)))));
  assert.ok(table.warnings.some((warning) => warning.includes('改前文字')));
  const importedId = store.command({
    type: 'createExperiment',
    code: 'CHG-NOTE',
    name: '再导入改前文字',
  }).experimentId!;
  importTable(store, {
    experimentId: importedId,
    table,
    mapping: table.mapping,
    keepOtherColumns: true,
  });
  assert.equal(
    store.snapshot().experiments.find((entry) => entry.id === importedId)?.fields.some((field) => field.label === '改前文字'),
    false,
  );
  assert.equal(store.snapshot().runs.length, 1);
  assert.equal(
    store.snapshot().events.find((event) => event.id === note.id)?.text,
    '装样方向已核对',
  );
});
