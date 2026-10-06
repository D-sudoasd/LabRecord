import test from 'node:test';
import assert from 'node:assert/strict';
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
