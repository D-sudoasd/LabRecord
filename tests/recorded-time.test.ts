import test from 'node:test';
import assert from 'node:assert/strict';
import { offsetZone, recordedClock, recordedEndLabel, recordedStartLabel } from '../src/shared/recordedTime.js';

test('recorded clock uses the saved offset instead of the current computer zone', () => {
  assert.deepEqual(recordedClock('2026-10-13T01:00:00.000Z', 480, 'Asia/Shanghai'), {
    clock: '2026/10/13 09:00:00',
    zone: 'Asia/Shanghai',
  });
  assert.deepEqual(recordedClock('2026-10-13T01:00:00.000Z', -300, ''), {
    clock: '2026/10/12 20:00:00',
    zone: 'UTC-5',
  });
  assert.equal(recordedClock('2026-10-13T01:00:00.000Z', 330, '')?.clock, '2026/10/13 06:30:00');
  assert.equal(offsetZone(330), 'UTC+5:30');
  assert.equal(recordedClock(null, 480, 'Asia/Shanghai'), null);
  assert.equal(recordedClock('not-a-time', 0, 'Asia/Shanghai'), null);
  assert.equal(recordedClock('2026-10-13T01:00:00.000Z', Number.NaN, 'Asia/Shanghai'), null);
  assert.equal(recordedEndLabel(undefined), '');
  assert.equal(recordedEndLabel({ endedAt: null, offsetMinutes: 480, timezone: 'Asia/Shanghai' }), '');
  assert.equal(
    recordedEndLabel({
      endedAt: '2026-10-13T01:00:00.000Z',
      offsetMinutes: 480,
      timezone: 'Asia/Shanghai',
    }),
    '结束 2026/10/13 09:00:00 Asia/Shanghai',
  );
  assert.equal(
    recordedEndLabel({ endedAt: 'not-a-time', offsetMinutes: 0, timezone: 'Asia/Shanghai' }),
    '',
  );
  assert.equal(recordedStartLabel(undefined), '');
  assert.equal(
    recordedStartLabel({ startedAt: null, offsetMinutes: 480, timezone: 'Asia/Shanghai' }),
    '',
  );
  assert.equal(
    recordedStartLabel({
      startedAt: '2026-10-13T01:00:00.000Z',
      offsetMinutes: 480,
      timezone: 'Asia/Shanghai',
    }),
    '开始 2026/10/13 09:00:00 Asia/Shanghai',
  );
  assert.equal(
    recordedStartLabel({ startedAt: 'not-a-time', offsetMinutes: 0, timezone: 'Asia/Shanghai' }),
    '',
  );
});

test('operation export writes saved clocks and does not import them', async (t) => {
  const { fixture } = await import('./helpers.js');
  const { csvRows, importTable, previewRows } = await import('../src/desktop/tables.js');
  let now = Date.parse('2026-10-13T01:00:00.000Z');
  const { store } = fixture(t, () => new Date(now));
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'CLK-1',
    name: '钟点导出',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '原状态', preparedCount: 2, notes: '隐藏词ZZZ' },
    count: 2,
  });
  const [first, second] = store.snapshot().items;
  store.command({ type: 'start', itemId: first.id });
  const open = store.snapshot().runs[0];
  store.command({ type: 'saveRun', runId: open.id, notes: '现场备注ZZZ' });
  const cell = (rows: (string | number | null)[][], id: string, name: string) => {
    const header = rows[0].map(String);
    return rows.find(
      (row) => row[header.indexOf('记录类型')] === '操作' && row[header.indexOf('plan_item_id')] === id,
    )?.[header.indexOf(name)];
  };
  let rows = csvRows(store.snapshot(), experimentId);
  assert.equal(cell(rows, first.id, '开始钟点'), recordedStartLabel(store.snapshot().runs[0]));
  assert.equal(cell(rows, first.id, '结束钟点'), '');
  assert.equal(cell(rows, second.id, '开始钟点'), '');
  assert.equal(String(cell(rows, first.id, '开始钟点')).includes('现场备注ZZZ'), false);
  assert.equal(String(cell(rows, first.id, '开始钟点')).includes('隐藏词ZZZ'), false);
  now += 60_000;
  store.command({ type: 'finish', itemId: first.id });
  const finished = store.snapshot().runs[0];
  rows = csvRows(store.snapshot(), experimentId);
  assert.equal(cell(rows, first.id, '开始钟点'), recordedStartLabel(finished));
  assert.equal(cell(rows, first.id, '结束钟点'), recordedEndLabel(finished));
  assert.equal(String(cell(rows, first.id, '结束钟点')).includes('现场备注ZZZ'), false);
  const table = previewRows(rows.map((row) => row.map((entry) => (entry == null ? '' : String(entry)))));
  assert.ok(table.warnings.some((warning) => warning.includes('开始钟点')));
  const importedId = store.command({
    type: 'createExperiment',
    code: 'CLK-2',
    name: '再导入钟点',
  }).experimentId!;
  importTable(store, { experimentId: importedId, table, mapping: table.mapping, keepOtherColumns: true });
  const after = store.snapshot();
  assert.equal(after.runs.length, 1);
  assert.equal(after.runs[0].originalStartedAt, open.originalStartedAt);
  assert.equal(after.runs[0].originalEndedAt, finished.originalEndedAt);
  assert.equal(after.runs[0].startedAt, finished.startedAt);
  assert.equal(after.runs[0].endedAt, finished.endedAt);
  assert.equal(
    after.experiments
      .find((entry) => entry.id === importedId)
      ?.fields.some((field) => field.label === '开始钟点' || field.label === '结束钟点'),
    false,
  );
});
