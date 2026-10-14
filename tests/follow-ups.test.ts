import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/desktop/reports.js';
import { exportFile, importTable, operationRows, parseDelimited, previewRows } from '../src/desktop/tables.js';
import { experimentOptionLabel, followUpRoster, followUpSets } from '../src/shared/followUps.js';
import { libraryBoard } from '../src/shared/library.js';
import { searchWorkspace } from '../src/ui/workspaceSearch.js';
import { fixture } from './helpers.js';

test('experiment option label adds a follow-up count only when some record needs checking', () => {
  assert.equal(experimentOptionLabel('拉伸实验', 'EXP-1', 0), '拉伸实验 · EXP-1');
  assert.equal(experimentOptionLabel('拉伸实验', 'EXP-1', 2), '拉伸实验 · EXP-1 · 待核对 2');
  assert.equal(experimentOptionLabel('拉伸实验', 'EXP-1', 2, 1), '拉伸实验 · EXP-1 · 待核对 2 · 实际已改 1');
  assert.equal(experimentOptionLabel('拉伸实验', 'EXP-1', 0, 3), '拉伸实验 · EXP-1 · 实际已改 3');
});

test('actual plan differences are counted without notes, file references, or later plan edits', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'CHG-01',
    name: '实际已改计数',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '原状态', preparedCount: 2, thickness: '0.8', thicknessUnit: 'mm', preparation: '批次 A' },
    count: 2,
  });
  const [first, second] = store.snapshot().items;
  store.command({ type: 'start', itemId: first.id });
  const run = store.snapshot().runs[0];
  store.command({
    type: 'saveRun',
    runId: run.id,
    notes: '只写备注',
    actual: { filename: 'beam.tif' },
  });
  store.command({
    type: 'updateGroups',
    ids: [store.snapshot().groups[0].id],
    patch: { thickness: '9.9' },
  });
  const unchanged = store.snapshot();
  assert.equal(libraryBoard(unchanged)[0].actualChanged, 0);
  assert.equal(searchWorkspace(unchanged, 'CHG-01')[0].detail.includes('实际已改'), false);
  store.command({
    type: 'saveRun',
    runId: run.id,
    actual: { preparation: '试剂批次 K-9' },
  });
  const changed = store.snapshot();
  assert.equal(libraryBoard(changed)[0].actualChanged, 1);
  assert.equal(searchWorkspace(changed, 'CHG-01')[0].detail, 'CHG-01 · 待核对 1 · 实际已改 1');
  assert.equal(changed.runs[0].snapshot.group.preparation, '批次 A');
  assert.equal(changed.runs[0].snapshot.group.thickness, '0.8');
  assert.equal(changed.runs[0].originalStartedAt, run.originalStartedAt);
  assert.equal(changed.items.find((item) => item.id === second.id)?.status, 'pending');
  assert.equal(changed.groups[0].preparedCount, 2);
});

test('follow-up roster names recorded gaps and leaves unstarted plans off the list', async (t) => {
  const { store, directory } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'GAP-01',
    name: '待核对清单',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '原状态', preparedCount: 4 },
    count: 4,
  });
  const items = store.snapshot().items;
  const code = (itemId: string) =>
    store.snapshot().samples.find((sample) => sample.id === items.find((item) => item.id === itemId)?.sampleId)?.code;
  store.command({ type: 'start', itemId: items[0].id });
  store.command({ type: 'finish', itemId: items[0].id });
  const finished = store.snapshot().runs[0];
  store.command({ type: 'saveRun', runId: finished.id, actual: { filename: 'sample-01.tif' } });
  store.command({ type: 'start', itemId: items[2].id });
  store.command({ type: 'finish', itemId: items[2].id });
  store.command({ type: 'start', itemId: items[1].id });
  const open = store.snapshot().runs.find((run) => run.itemId === items[1].id)!;
  store.command({ type: 'saveRun', runId: open.id, actual: { scanId: 'SCAN-2' } });
  store.command({
    type: 'addEvent',
    experimentId,
    itemId: items[0].id,
    eventType: 'issue',
    text: '按操作关联',
  });
  store.command({
    type: 'addEvent',
    experimentId,
    runId: open.id,
    eventType: 'issue',
    text: '只记在实际记录上',
  });
  store.command({ type: 'addEvent', experimentId, eventType: 'issue', text: '实验级问题' });
  const snapshot = store.snapshot();
  const roster = followUpRoster(snapshot, experimentId);
  assert.deepEqual(
    roster.map((entry) => [entry.sampleCode, entry.gaps]),
    [
      [code(items[0].id), ['未处理问题']],
      [code(items[1].id), ['时间不完整', '未处理问题']],
      [code(items[2].id), ['文件未关联']],
    ],
  );
  assert.equal(followUpSets(snapshot, experimentId).unlinkedIssues, 1);
  assert.equal(
    roster.some((entry) => entry.sampleCode === code(items[3].id)),
    false,
  );
  assert.equal(snapshot.runs.find((run) => run.itemId === items[0].id)?.originalStartedAt, finished.originalStartedAt);
  const report = await renderReport(snapshot, experimentId, store.root);
  const section = report.html.match(/<section class="follow-up-roster">[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(section, new RegExp(`${code(items[1].id)} · 时间不完整、未处理问题`));
  assert.doesNotMatch(section, new RegExp(code(items[3].id)!));
  assert.match(report.markdown, /未关联到操作的问题：1 条/);
  const rows = operationRows(snapshot, experimentId);
  const column = rows[0].indexOf('待核对');
  const cell = (itemId: string) => rows.find((row) => row.includes(itemId))?.[column];
  assert.equal(cell(items[0].id), '未处理问题');
  assert.equal(cell(items[1].id), '时间不完整、未处理问题');
  assert.equal(cell(items[2].id), '文件未关联');
  assert.equal(cell(items[3].id), '');
  await exportFile(snapshot, experimentId, 'csv', join(directory, 'gaps.csv'));
  const table = previewRows(parseDelimited(await readFile(join(directory, 'gaps.csv'), 'utf8')));
  assert.ok(table.warnings.some((warning) => warning.includes('待核对')));
  const importedId = store.command({
    type: 'createExperiment',
    code: 'GAP-02',
    name: '再导入',
  }).experimentId!;
  importTable(store, {
    experimentId: importedId,
    table,
    mapping: table.mapping,
    keepOtherColumns: true,
  });
  const after = store.snapshot();
  assert.equal(after.runs.length, 3);
  assert.equal(after.items.filter((item) => item.experimentId === importedId).length, 0);
  assert.equal(after.groups.filter((group) => group.experimentId === importedId).length, 1);
  assert.equal(
    after.experiments.find((entry) => entry.id === importedId)?.fields.some((field) => field.label === '待核对'),
    false,
  );
  assert.equal(
    after.experiments
      .find((entry) => entry.id === importedId)
      ?.fields.some((field) => field.label === '记录时区时间'),
    false,
  );
  assert.ok(table.warnings.some((warning) => warning.includes('记录时区时间')));
  assert.ok(table.warnings.some((warning) => warning.includes('重测来源')));
  assert.equal(
    after.experiments
      .find((entry) => entry.id === importedId)
      ?.fields.some((field) => field.label === '重测来源'),
    false,
  );
});
