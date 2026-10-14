import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/desktop/reports.js';
import { csvRows, importTable, previewRows } from '../src/desktop/tables.js';
import { eventTimeLabel, operationHistory } from '../src/shared/history.js';
import { recordedClock } from '../src/shared/recordedTime.js';
import { fixture } from './helpers.js';

test('operation history keeps run-only issues and leaves experiment-level issues out', async (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'HIST-01',
    name: '历史',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '原状态', preparedCount: 2 },
    count: 2,
  });
  const [first, second] = store.snapshot().items;
  store.command({ type: 'start', itemId: first.id });
  store.command({ type: 'finish', itemId: first.id });
  const run = store.snapshot().runs[0];
  store.command({
    type: 'addEvent',
    experimentId,
    itemId: first.id,
    eventType: 'issue',
    text: '按操作关联',
  });
  store.command({
    type: 'addEvent',
    experimentId,
    runId: run.id,
    eventType: 'issue',
    text: '只记在实际记录上',
  });
  store.command({
    type: 'addEvent',
    experimentId,
    itemId: first.id,
    runId: run.id,
    eventType: 'note',
    text: '操作和记录都写了',
  });
  store.command({ type: 'addEvent', experimentId, eventType: 'issue', text: '实验级问题' });
  store.command({
    type: 'addEvent',
    experimentId,
    itemId: second.id,
    eventType: 'issue',
    text: '另一件样品',
  });
  const snapshot = store.snapshot();
  const history = operationHistory(snapshot, first.id);
  assert.deepEqual(
    history.map((event) => event.text),
    ['开始操作', '完成操作', '按操作关联', '只记在实际记录上', '操作和记录都写了'],
  );
  assert.equal(new Set(history.map((event) => event.id)).size, history.length);
  assert.equal(operationHistory(snapshot, second.id).map((event) => event.text).join(), '另一件样品');
  assert.equal(snapshot.runs[0].originalStartedAt, snapshot.runs[0].startedAt);
  assert.equal(snapshot.runs.length, 1);
  const linked = snapshot.events.find((event) => event.text === '只记在实际记录上')!;
  const clock = recordedClock(linked.createdAt, snapshot.runs[0].offsetMinutes, snapshot.runs[0].timezone)!;
  assert.equal(eventTimeLabel(snapshot, linked), `${clock.clock} ${clock.zone}`);
  const loose = snapshot.events.find((event) => event.text === '实验级问题')!;
  assert.equal(eventTimeLabel(snapshot, loose), '');
  assert.equal(eventTimeLabel(snapshot, snapshot.events.find((event) => event.text === '另一件样品')!), '');
  const report = await renderReport(snapshot, experimentId, store.root);
  assert.ok(report.html.includes(`${clock.clock} ${clock.zone} · UTC ${linked.createdAt}`));
  assert.ok(report.html.includes(`<li>${loose.createdAt} · ${loose.text}`));
  assert.equal(
    report.html.includes(`${clock.clock} ${clock.zone} · UTC ${loose.createdAt} · ${loose.text}`),
    false,
  );
  const rows = csvRows(snapshot, experimentId);
  const header = rows[0].map(String);
  const textColumn = header.indexOf('内容');
  const typeColumn = header.indexOf('记录类型');
  const utcColumn = header.indexOf('时间UTC');
  const localColumn = header.indexOf('记录时区时间');
  const eventRow = (text: string) =>
    rows.find((row) => row[typeColumn] === '事件' && row[textColumn] === text);
  assert.equal(eventRow('只记在实际记录上')?.[localColumn], `${clock.clock} ${clock.zone}`);
  assert.equal(eventRow('只记在实际记录上')?.[utcColumn], linked.createdAt);
  assert.equal(eventRow('实验级问题')?.[localColumn], '');
  assert.equal(eventRow('实验级问题')?.[utcColumn], loose.createdAt);
  const problemColumn = header.indexOf('问题记录');
  const linkedIssue = snapshot.events.find((event) => event.text === '按操作关联')!;
  const issueClock = recordedClock(
    linkedIssue.createdAt,
    snapshot.runs[0].offsetMinutes,
    snapshot.runs[0].timezone,
  )!;
  const operationRow = rows.find(
    (row) => row[typeColumn] === '操作' && String(row[problemColumn] || '').includes('按操作关联'),
  );
  assert.ok(String(operationRow?.[problemColumn]).includes(`${issueClock.clock} ${issueClock.zone}`));
  assert.equal(snapshot.runs[0].originalStartedAt, run.originalStartedAt);
});

test('skip and interrupt reasons export with the operation and stay out of imported fields', async (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'WHY-01',
    name: '原因',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '原状态', preparedCount: 3, thickness: '0.8', thicknessUnit: 'mm' },
    count: 3,
  });
  const [skipped, plain, stopped] = store.snapshot().items.slice().sort((a, b) => a.order - b.order);
  store.command({ type: 'skip', itemId: skipped.id, reason: '样品未送达' });
  store.command({ type: 'skip', itemId: plain.id });
  store.command({ type: 'start', itemId: stopped.id });
  const started = store.snapshot().runs[0];
  const interrupted = store.command({ type: 'interrupt', itemId: stopped.id, reason: '光束中断' });
  assert.equal(interrupted.itemId, stopped.id);
  const snapshot = store.snapshot();
  const report = await renderReport(snapshot, experimentId, store.root);
  assert.match(report.html, /已跳过 · 原因：样品未送达/);
  assert.match(report.html, /已跳过<\/span>/);
  assert.match(report.html, /已中断 · 最近中断 · 原因：光束中断/);
  assert.match(report.markdown, /状态：已跳过；原因：样品未送达/);
  assert.match(report.markdown, /状态：已跳过；样品 ID：/);
  assert.match(report.markdown, /状态：已中断；最近中断；原因：光束中断/);
  const rows = csvRows(snapshot, experimentId);
  const header = rows[0].map(String);
  const reasonColumn = header.indexOf('状态原因');
  const idColumn = header.indexOf('plan_item_id');
  const cell = (itemId: string) =>
    rows.find((row) => row[0] === '操作' && row[idColumn] === itemId)?.[reasonColumn];
  assert.equal(cell(skipped.id), '样品未送达');
  assert.equal(cell(plain.id), '');
  assert.equal(cell(stopped.id), '光束中断');
  const table = previewRows(rows.map((row) => row.map((value) => (value == null ? '' : String(value)))));
  assert.ok(table.warnings.some((warning) => warning.includes('状态原因')));
  const importedId = store.command({
    type: 'createExperiment',
    code: 'WHY-02',
    name: '再导入原因',
  }).experimentId!;
  importTable(store, {
    experimentId: importedId,
    table,
    mapping: table.mapping,
    keepOtherColumns: true,
  });
  const after = store.snapshot();
  assert.equal(after.runs.filter((run) => run.experimentId === importedId).length, 0);
  assert.equal(
    after.experiments.find((entry) => entry.id === importedId)?.fields.some((field) => field.label === '状态原因'),
    false,
  );
  const kept = after.runs.find((run) => run.id === started.id)!;
  assert.equal(kept.originalStartedAt, started.originalStartedAt);
  assert.equal(kept.snapshot.group.thickness, '0.8');
  assert.equal(after.items.find((item) => item.id === plain.id)?.status, 'skipped');
  assert.equal(after.items.filter((item) => item.experimentId === experimentId && item.status === 'pending').length, 0);
});
