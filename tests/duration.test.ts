import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/desktop/reports.js';
import { csvRows, importTable, operationRows, previewRows } from '../src/desktop/tables.js';
import { formatRecordedDuration, recordedDuration, runDurationLabel } from '../src/shared/duration.js';
import { recordedClock } from '../src/shared/recordedTime.js';
import { fixture } from './helpers.js';

test('recorded duration sums complete intervals, including across midnight, and skips open runs', async (t) => {
  let now = Date.parse('2026-10-13T15:59:00.000Z');
  const { store } = fixture(t, () => new Date(now));
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'TIME-01',
    name: '用时',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '原状态', preparedCount: 3 },
    count: 3,
  });
  const [first, second] = store.snapshot().items;
  store.command({ type: 'start', itemId: first.id });
  now += 4 * 60 * 1000;
  store.command({ type: 'finish', itemId: first.id });
  store.command({ type: 'start', itemId: second.id });
  const open = recordedDuration(store.snapshot().runs);
  assert.deepEqual(
    [open.completeCount, open.incompleteCount, open.milliseconds],
    [1, 1, 4 * 60 * 1000],
  );
  assert.equal(formatRecordedDuration(open.milliseconds), '4 分 00 秒');
  assert.equal(
    runDurationLabel({
      startedAt: '2026-10-13T15:59:00.000Z',
      endedAt: '2026-10-13T16:03:00.000Z',
    }),
    '4 分 00 秒',
  );
  assert.equal(
    runDurationLabel({ startedAt: '2026-10-13T15:59:00.000Z', endedAt: null }),
    '未计入',
  );
  assert.equal(runDurationLabel(undefined), '');
  const finished = store.snapshot().runs.find((run) => run.itemId === first.id)!;
  assert.equal(finished.originalEndedAt, finished.endedAt);
  store.command({
    type: 'times',
    itemId: first.id,
    startedAt: finished.startedAt,
    endedAt: new Date(Date.parse(finished.startedAt!) + 5 * 60 * 1000).toISOString(),
    reason: '按现场日志延长 1 分钟',
  });
  const corrected = store.snapshot();
  const duration = recordedDuration(corrected.runs.filter((run) => run.experimentId === experimentId));
  assert.equal(duration.milliseconds, 5 * 60 * 1000);
  const rows = operationRows(corrected, experimentId);
  const durationColumn = rows[0].indexOf('用时');
  const durationCell = (itemId: string) => rows.find((row) => row.includes(itemId))?.[durationColumn];
  const third = corrected.items.find((item) => item.id !== first.id && item.id !== second.id)!;
  assert.equal(durationCell(first.id), '5 分 00 秒');
  assert.equal(durationCell(second.id), '未计入');
  assert.equal(durationCell(third.id), '');
  assert.equal(corrected.runs.find((run) => run.itemId === first.id)?.originalEndedAt, finished.originalEndedAt);
  assert.equal(recordedDuration([{ startedAt: '2026-10-14T00:02:00.000Z', endedAt: '2026-10-13T23:59:00.000Z' }]).incompleteCount, 1);
  const report = await renderReport(corrected, experimentId, store.root);
  const completed = corrected.runs.find((run) => run.itemId === first.id)!;
  const localStart = recordedClock(completed.startedAt, completed.offsetMinutes, completed.timezone)!;
  const localEnd = recordedClock(completed.endedAt, completed.offsetMinutes, completed.timezone)!;
  const originalEnd = recordedClock(
    completed.originalEndedAt,
    completed.offsetMinutes,
    completed.timezone,
  )!;
  assert.notEqual(localEnd.clock, originalEnd.clock);
  assert.ok(report.html.includes(`开始时间（记录时区）</th><td>${localStart.clock} ${localStart.zone}`));
  assert.ok(report.html.includes(`结束时间（记录时区）</th><td>${localEnd.clock} ${localEnd.zone}`));
  assert.ok(report.html.includes(`原始结束（记录时区）</th><td>${originalEnd.clock} ${originalEnd.zone}`));
  assert.ok(report.html.includes('结束时间（记录时区）</th><td>未记录'));
  assert.ok(report.html.includes(`开始时间 UTC</th><td>${completed.startedAt}`));
  assert.ok(report.markdown.includes(`开始（记录时区）：${localStart.clock} ${localStart.zone}`));
  assert.match(report.html, /5 分 00 秒已记录用时/);
  assert.match(report.html, /起止间隔（秒）<\/th><td>300</);
  assert.match(report.html, /<th>用时<\/th><td>未计入</);
  assert.match(report.markdown, /用时：5 分 00 秒/);
  assert.match(report.markdown, /用时：未计入/);
  assert.doesNotMatch(report.html, /起止间隔（秒）<\/th><td>-/);
  assert.match(report.markdown, /1 次起止不完整，未计入/);
  assert.match(report.html, /<th>已记录用时<\/th><th>未计入次数<\/th>/);
  assert.match(report.html, /5 分 00 秒<\/td><td>1<\/td>/);
  assert.match(report.markdown, /## 样品组已记录用时/);
  assert.match(report.markdown, /已记录 5 分 00 秒；未计入 1 次/);
  assert.equal(corrected.runs.length, 2);
  const csv = csvRows(corrected, experimentId);
  const header = csv[0].map(String);
  const groupRow = csv.find((row) => row[header.indexOf('记录类型')] === '样品组');
  assert.equal(groupRow?.[header.indexOf('已记录用时')], '5 分 00 秒');
  assert.equal(groupRow?.[header.indexOf('未计入次数')], 1);
  const table = previewRows(csv.map((row) => row.map((cell) => (cell == null ? '' : String(cell)))));
  assert.ok(table.warnings.some((warning) => warning.includes('已记录用时')));
  const importedId = store.command({
    type: 'createExperiment',
    code: 'TIME-02',
    name: '再导入用时',
  }).experimentId!;
  importTable(store, {
    experimentId: importedId,
    table,
    mapping: table.mapping,
    keepOtherColumns: true,
  });
  const after = store.snapshot();
  assert.equal(after.runs.length, 2);
  assert.equal(after.items.filter((item) => item.experimentId === importedId).length, 0);
  const fields = after.experiments.find((entry) => entry.id === importedId)?.fields ?? [];
  assert.equal(
    fields.some((field) => field.label === '已记录用时' || field.label === '未计入次数'),
    false,
  );
  assert.equal(
    after.runs.find((run) => run.itemId === first.id)?.originalEndedAt,
    finished.originalEndedAt,
  );
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '空组', name: '没有记录的组', preparedCount: 2 },
    count: 0,
  });
  const emptyReport = await renderReport(store.snapshot(), experimentId, store.root);
  assert.match(emptyReport.markdown, /没有记录的组（空组）：尚无实际记录/);
  assert.match(emptyReport.markdown, /已记录 5 分 00 秒；未计入 1 次/);
  assert.match(
    emptyReport.html,
    /没有记录的组<small>空组<\/small><small><\/small><\/td><td>2<\/td><td>0<\/td><td>2<\/td><td>未记录<\/td><td>未记录<\/td>/,
  );
  assert.equal(store.snapshot().runs.length, 2);
  assert.equal(
    store.snapshot().runs.find((run) => run.itemId === first.id)?.originalEndedAt,
    finished.originalEndedAt,
  );
});
