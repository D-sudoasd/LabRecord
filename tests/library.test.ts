import test from 'node:test';
import assert from 'node:assert/strict';
import { CODE_PATTERN_PAD, filledSize, sampleOverrideLabel, type Snapshot } from '../src/shared/model.js';
import {
  boardActions,
  knownQuantity,
  latestEndedMark,
  latestEndedSummary,
  latestRecorded,
  libraryBoard,
  nextOperationBrief,
  nextPending,
  runningOperationSummary,
} from '../src/shared/library.js';
import { csvRows, importTable, previewRows } from '../src/desktop/tables.js';
import { renderReport } from '../src/desktop/reports.js';
import { recordedClock } from '../src/shared/recordedTime.js';
import { fixture } from './helpers.js';

function itemByCode(snapshot: Snapshot, code: string) {
  const sample = snapshot.samples.find((entry) => entry.code === code);
  const item = snapshot.items.find((entry) => entry.sampleId === sample?.id && !entry.repeatOf);
  if (!sample || !item) throw new Error(`缺少 ${code}`);
  return { sample, item };
}

function keepHistoricalSampleCodes(store: ReturnType<typeof fixture>['store'], experimentId: string) {
  store.command({
    type: 'updateExperiment',
    id: experimentId,
    namingPattern: '{experiment}_{sample}',
    sampleCodePattern: CODE_PATTERN_PAD,
  });
}

test('known preparation stays numeric until every group in view is unknown', () => {
  assert.equal(knownQuantity(6, 0, 1), '6');
  assert.equal(knownQuantity(6, 1, 2), '6');
  assert.equal(knownQuantity(0, 1, 1), '未知');
  assert.equal(knownQuantity(0, 0, 0), '0');
});

test('library keeps preparation, samples, operations and spare separate', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'LIB-01',
    name: '工作台实验',
    description: '说明里的隐藏词ZZZ',
  }).experimentId!;
  keepHistoricalSampleCodes(store, experimentId);
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { name: '原样品', state: '原状态', preparedCount: 6 },
    count: 4,
  });
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { name: '数量未填', state: '原状态' },
    count: 0,
  });
  let snapshot = store.snapshot();
  let card = libraryBoard(snapshot).find((entry) => entry.experimentId === experimentId)!;
  assert.equal(card.preparedKnown, 6);
  assert.equal(card.unknownPreparation, 1);
  assert.equal(card.plannedSamples, 4);
  assert.equal(card.plannedOperations, 4);
  assert.equal(card.spareKnown, 2);
  assert.equal(knownQuantity(card.preparedKnown, card.unknownPreparation, card.groupCount), '6');
  assert.equal(nextPending(snapshot, experimentId)?.sampleCode, 'S01');

  const third = itemByCode(snapshot, 'S03');
  const nameBefore = third.item.plannedName;
  store.command({
    type: 'reorder',
    experimentId,
    ids: ['S03', 'S01', 'S02', 'S04'].map((code) => itemByCode(snapshot, code).item.id),
  });
  snapshot = store.snapshot();
  const moved = nextPending(snapshot, experimentId)!;
  assert.equal(moved.itemId, third.item.id);
  assert.equal(moved.sampleCode, 'S03');
  assert.equal(moved.plannedName, nameBefore);
  assert.equal(snapshot.items.find((item) => item.id === third.item.id)?.plannedName, nameBefore);

  store.command({
    type: 'reorder',
    experimentId,
    ids: ['S01', 'S02', 'S03', 'S04'].map((code) => itemByCode(snapshot, code).item.id),
  });
  store.command({ type: 'start', itemId: itemByCode(store.snapshot(), 'S01').item.id });
  const started = store.snapshot();
  const before = structuredClone(started);
  card = libraryBoard(started)[0];
  assert.deepEqual(started, before);
  assert.equal(card.runningItem?.sampleCode, 'S01');
  assert.equal(card.recordedLabel, '');
  assert.equal(card.incompleteCount, 1);
  assert.equal(card.next?.sampleCode, 'S02');
  assert.equal(card.missingTimes, 1);
  assert.equal(card.missingFiles, 1);
  assert.deepEqual(
    boardActions(started).map((action) => action.kind),
    ['open', 'running', 'next'],
  );
  const startedId = itemByCode(started, 'S01').item.id;
  store.command({ type: 'finish', itemId: startedId });
  const finished = store.snapshot();
  const check = boardActions(finished).find((action) => action.kind === 'check');
  assert.equal(check?.itemId, startedId);
  assert.equal(check?.title, 'S01');
  const recentAction = boardActions(finished).find((action) => action.kind === 'recent');
  assert.equal(recentAction?.itemId, startedId);
  assert.equal(recentAction?.title, 'S01');
  assert.equal(libraryBoard(finished)[0].recent?.sampleCode, 'S01');
  assert.equal(libraryBoard(finished)[0].recent?.openIssue, '');
  assert.equal(finished.runs[0].originalEndedAt, finished.runs[0].endedAt);
  assert.equal(finished.runs[0].endedAt === null, false);

  const frozen = structuredClone(started);
  frozen.runs[0].snapshot.sample.code = 'FROZEN-01';
  frozen.samples.find((sample) => sample.code === 'S01')!.code = 'LIVE-01';
  assert.equal(libraryBoard(frozen)[0].runningItem?.sampleCode, 'FROZEN-01');
  assert.equal(libraryBoard(frozen)[0].next?.sampleCode, 'S02');
  assert.equal(store.snapshot().runs[0].snapshot.sample.code, 'S01');
  assert.equal(started.runs.length, 1);

  store.command({
    type: 'addEvent',
    experimentId,
    itemId: startedId,
    eventType: 'issue',
    text: '开始时的问题',
  });
  store.command({ type: 'repeat', itemId: startedId });
  snapshot = store.snapshot();
  card = libraryBoard(snapshot)[0];
  const repeat = snapshot.items.find((item) => item.repeatOf === startedId)!;
  assert.equal(repeat.sampleId, itemByCode(snapshot, 'S01').sample.id);
  assert.deepEqual(
    [
      card.plannedSamples,
      card.plannedOperations,
      card.spareKnown,
      card.repeats,
      card.unresolvedIssues,
    ],
    [4, 5, 2, 1, 1],
  );
  assert.equal(card.next?.sampleCode, 'S02');
  assert.notEqual(card.next?.itemId, repeat.id);
  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.runs[0].originalStartedAt, snapshot.runs[0].startedAt);
});

test('next operation brief follows the full order and leaves the running record unchanged', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'NX-1',
    name: '下一件',
  }).experimentId!;
  keepHistoricalSampleCodes(store, experimentId);
  store.command({
    type: 'addSamples',
    experimentId,
    patch: {
      state: '400C-aged',
      material: 'Ti2448',
      preparedCount: 3,
      mode: 'In situ',
      thickness: '0.8',
      thicknessUnit: 'mm',
      protocol: '10 °C/min 升至 375 °C',
      notes: '隐藏词ZZZ',
    },
    count: 3,
  });
  const initial = store.snapshot();
  const [first, second, third] = initial.items;
  store.command({
    type: 'configureMeasurements',
    ids: [second.id],
    measurement: { regime: 'cyclic', technique: 'SXRD', batch: 'B02' },
  });
  store.command({ type: 'skip', itemId: first.id });
  store.command({ type: 'start', itemId: third.id });
  const before = store.snapshot();
  const brief = nextOperationBrief(before, experimentId);
  assert.equal(brief?.itemId, second.id);
  assert.equal(brief?.sampleCode, before.samples.find((sample) => sample.id === second.sampleId)?.code);
  assert.match(brief?.measurement || '', /原位/);
  assert.match(brief?.measurement || '', /SXRD/);
  assert.match(brief?.measurement || '', /循环加载/);
  assert.match(brief?.measurement || '', /批次 B02/);
  assert.match(brief?.preparation || '', /Ti2448/);
  assert.match(brief?.preparation || '', /400C-aged/);
  assert.match(brief?.preparation || '', /0\.8 mm/);
  assert.match(brief?.protocol || '', /375/);
  assert.equal(brief?.folder, before.items.find((item) => item.id === second.id)?.plannedName);
  assert.equal(brief?.repeat, '');
  assert.equal(brief?.sourceIssue, '');
  assert.equal(JSON.stringify(brief).includes('隐藏词ZZZ'), false);
  assert.equal(nextOperationBrief(before, 'missing'), null);
  const after = store.snapshot();
  assert.equal(after.runs.length, 1);
  assert.equal(after.runs[0].itemId, third.id);
  assert.equal(after.runs[0].endedAt, null);
  assert.equal(after.runs[0].originalStartedAt, before.runs[0].originalStartedAt);
});

test('latest recorded run is the most recently ended record', (t) => {
  let now = Date.parse('2026-10-13T01:00:00.000Z');
  const { store } = fixture(t, () => new Date(now));
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'LAST-1',
    name: '最近记录',
  }).experimentId!;
  keepHistoricalSampleCodes(store, experimentId);
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '原状态', preparedCount: 2, notes: '隐藏词ZZZ' },
    count: 2,
  });
  const [first, second] = store.snapshot().items;
  store.command({ type: 'start', itemId: first.id });
  now += 60_000;
  store.command({ type: 'finish', itemId: first.id });
  const finished = store.snapshot().runs[0];
  store.command({
    type: 'saveRun',
    runId: finished.id,
    notes: '现场备注ZZZ',
    actual: { scanId: 'SCAN-LAST-1', filename: 'frame-001.cbf', files: 'E:\\raw\\hidden.cbf' },
  });
  store.command({ type: 'start', itemId: second.id });
  const open = latestRecorded(store.snapshot(), experimentId);
  assert.equal(open?.itemId, first.id);
  assert.equal(open?.status, 'completed');
  assert.equal(open?.scanId, 'SCAN-LAST-1');
  assert.equal(open?.fileLabel, '文件 frame-001.cbf');
  assert.equal(open?.filename, 'frame-001.cbf');
  assert.equal(open?.fileLabel.includes('hidden.cbf'), false);
  assert.equal(open?.fileLabel.includes('现场备注ZZZ'), false);
  assert.equal(latestEndedSummary(store.snapshot(), experimentId).includes('文件 frame-001.cbf'), true);
  assert.equal(latestEndedSummary(store.snapshot(), experimentId).includes('hidden.cbf'), false);
  assert.equal(open?.duration, '1 分 00 秒');
  const clock = recordedClock(finished.endedAt, finished.offsetMinutes, finished.timezone);
  assert.ok(clock);
  assert.equal(open?.endedClock, `结束 ${clock!.clock} ${clock!.zone}`);
  assert.equal(open?.endedClock.includes('隐藏词ZZZ'), false);
  assert.equal(open?.endedClock.includes('现场备注ZZZ'), false);
  assert.equal(open?.folder, finished.filename);
  assert.equal(JSON.stringify(open).includes('隐藏词ZZZ'), false);
  assert.equal(JSON.stringify(open).includes('现场备注ZZZ'), false);
  assert.equal(open?.openIssue, '');
  store.command({
    type: 'addEvent',
    experimentId,
    itemId: first.id,
    runId: finished.id,
    eventType: 'issue',
    text: '样品定位偏离',
  });
  assert.equal(
    latestRecorded(store.snapshot(), experimentId)?.openIssue,
    '未处理问题：样品定位偏离',
  );
  const listed = boardActions(store.snapshot()).find((action) => action.kind === 'recent');
  assert.equal(listed?.title, 'S01');
  assert.equal(listed?.detail.includes('样品定位偏离'), false);
  assert.equal(listed?.detail.includes('现场备注ZZZ'), false);
  assert.equal(listed?.detail.includes('隐藏词ZZZ'), false);
  assert.equal(
    latestRecorded(store.snapshot(), experimentId)?.openIssue.includes('现场备注ZZZ'),
    false,
  );
  const issue = store.snapshot().events.find((event) => event.text === '样品定位偏离')!;
  store.command({ type: 'resolveIssue', eventId: issue.id });
  assert.equal(latestRecorded(store.snapshot(), experimentId)?.openIssue, '');
  assert.equal(store.snapshot().runs[0].originalEndedAt, finished.originalEndedAt);
  now += 60_000;
  store.command({ type: 'interrupt', itemId: second.id });
  const interrupted = latestRecorded(store.snapshot(), experimentId);
  assert.equal(interrupted?.itemId, second.id);
  assert.equal(interrupted?.status, 'interrupted');
  assert.equal(interrupted?.scanId, '');
  const after = store.snapshot();
  assert.equal(after.runs.find((run) => run.id === finished.id)?.originalEndedAt, finished.originalEndedAt);
  assert.equal(after.runs.find((run) => run.id === finished.id)?.endedAt, finished.endedAt);
});

test('filledSize keeps only the sides that were written', () => {
  assert.equal(
    filledSize({
      thickness: '0.8',
      thicknessUnit: 'mm',
      width: '3',
      height: '',
      dimensionUnit: 'mm',
    }),
    '厚 0.8 mm · 宽 3 mm',
  );
  assert.equal(
    filledSize({ thickness: '  ', thicknessUnit: 'mm', width: '', height: '', dimensionUnit: '' }),
    '',
  );
  assert.equal(
    filledSize({ thickness: '1', thicknessUnit: '', width: '', height: '2', dimensionUnit: 'mm' }),
    '厚 1 · 高 2 mm',
  );
});

test('sampleOverrideLabel lists only the sample fields that differ from the group', () => {
  const group = {
    thickness: '0.8',
    thicknessUnit: 'mm',
    width: '3',
    height: '',
    dimensionUnit: 'mm',
    composition: 'Ti-24Nb',
    processing: '',
    heatTreatment: '400 °C',
    otherTreatment: '',
  };
  assert.equal(sampleOverrideLabel(group, {}), '');
  assert.equal(sampleOverrideLabel(group, { thickness: '0.8', notes: '隐藏备注' }), '');
  assert.equal(
    sampleOverrideLabel(group, { thickness: '1.5', heatTreatment: '800 °C × 1 h' }),
    '厚 1.5 mm · 热处理制度：800 °C × 1 h',
  );
  assert.equal(sampleOverrideLabel(group, { composition: 'Ti-24Nb' }).includes('成分'), false);
});

test('group export names sample overrides and does not import them as fields', async (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'OV-1',
    name: '样品差异',
  }).experimentId!;
  keepHistoricalSampleCodes(store, experimentId);
  store.command({
    type: 'addSamples',
    experimentId,
    patch: {
      state: '原状态',
      name: '拉伸组',
      preparedCount: 2,
      thickness: '0.8',
      thicknessUnit: 'mm',
      notes: '隐藏备注',
    },
    count: 2,
  });
  const first = store.snapshot().items[0];
  store.command({
    type: 'updateSamples',
    ids: [first.sampleId],
    parameters: { thickness: '1.5', heatTreatment: '800 °C × 1 h' },
  });
  store.command({ type: 'start', itemId: first.id });
  const run = store.snapshot().runs[0];
  store.command({
    type: 'updateSamples',
    ids: [first.sampleId],
    parameters: { thickness: '2.2' },
  });
  const snapshot = store.snapshot();
  const rows = csvRows(snapshot, experimentId);
  const header = rows[0].map(String);
  const groupRow = rows.find((row) => row[header.indexOf('记录类型')] === '样品组')!;
  const difference = String(groupRow[header.indexOf('样品差异')]);
  assert.match(difference, /S01：厚 2\.2 mm · 热处理制度：800 °C × 1 h/);
  assert.equal(difference.includes('S02'), false);
  assert.equal(difference.includes('隐藏备注'), false);
  const operation = rows.find(
    (row) => row[header.indexOf('记录类型')] === '操作' && row[header.indexOf('plan_item_id')] === first.id,
  );
  assert.equal(operation?.[header.indexOf('计划厚度')], '1.5');
  assert.equal(groupRow[header.indexOf('厚度')], '0.8');
  const report = await renderReport(snapshot, experimentId, store.root);
  const groupHtml = report.html.match(/<h2>样品准备与尺寸<\/h2>[\s\S]*?<\/table>/)?.[0] || '';
  assert.match(groupHtml, /S01：厚 2\.2 mm/);
  assert.match(groupHtml, /800 °C × 1 h/);
  assert.equal(groupHtml.includes('隐藏备注'), false);
  assert.match(report.markdown, /样品差异：S01：厚 2\.2 mm · 热处理制度：800 °C × 1 h/);
  const table = previewRows(rows.map((row) => row.map((cell) => (cell == null ? '' : String(cell)))));
  assert.ok(table.warnings.some((warning) => warning.includes('样品差异')));
  const importedId = store.command({
    type: 'createExperiment',
    code: 'OV-2',
    name: '再导入差异',
  }).experimentId!;
  importTable(store, {
    experimentId: importedId,
    table,
    mapping: table.mapping,
    keepOtherColumns: true,
  });
  const after = store.snapshot();
  assert.equal(after.runs.length, 1);
  assert.equal(after.items.filter((item) => item.experimentId === importedId).length, 0);
  assert.equal(
    after.experiments.find((entry) => entry.id === importedId)?.fields.some((field) => field.label === '样品差异'),
    false,
  );
  assert.equal(after.runs[0].snapshot.group.thickness, '1.5');
  assert.equal(after.runs[0].originalStartedAt, run.originalStartedAt);
  assert.equal(after.groups.find((group) => group.experimentId === experimentId)?.thickness, '0.8');
});

test('only the latest ended operation is marked in review data and exports', async (t) => {
  let now = Date.parse('2026-10-13T03:00:00.000Z');
  const { store } = fixture(t, () => new Date(now));
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'END-1',
    name: '最近结束',
  }).experimentId!;
  keepHistoricalSampleCodes(store, experimentId);
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '原状态', preparedCount: 2, notes: '隐藏词ZZZ' },
    count: 2,
  });
  const [first, second] = store.snapshot().items;
  store.command({ type: 'start', itemId: first.id });
  assert.equal(latestEndedMark(store.snapshot(), first.id), '');
  const run = store.snapshot().runs[0];
  store.command({
    type: 'saveRun',
    runId: run.id,
    notes: '现场备注ZZZ',
    actual: { scanId: 'SCAN-END-1' },
  });
  store.command({
    type: 'addEvent',
    experimentId,
    itemId: first.id,
    runId: run.id,
    eventType: 'issue',
    text: '样品定位偏离',
  });
  store.command({ type: 'finish', itemId: first.id });
  const finished = store.snapshot();
  assert.equal(latestEndedMark(finished, first.id), '最近完成');
  assert.equal(latestEndedMark(finished, second.id), '');
  const summary = latestEndedSummary(finished, experimentId);
  assert.match(summary, /^最近完成 · S01 · /);
  assert.match(summary, /扫描 SCAN-END-1/);
  assert.equal(summary.includes('隐藏词ZZZ'), false);
  assert.equal(summary.includes('现场备注ZZZ'), false);
  assert.equal(summary.includes('样品定位偏离'), false);
  const report = await renderReport(finished, experimentId, store.root);
  assert.match(report.html, /最近结束：最近完成 · S01/);
  assert.match(report.markdown, /最近结束：最近完成 · S01/);
  const pendingHtml = report.html.split('<h2>S02')[1] || '';
  assert.equal(pendingHtml.includes('最近完成'), false);
  assert.equal(pendingHtml.includes('最近中断'), false);
  const rows = csvRows(finished, experimentId);
  const header = rows[0].map(String);
  const column = header.indexOf('最近结束');
  const cell = (id: string) =>
    rows.find((row) => row[header.indexOf('记录类型')] === '操作' && row[header.indexOf('plan_item_id')] === id)?.[
      column
    ];
  assert.equal(cell(first.id), '最近完成');
  assert.equal(cell(second.id), '');
  assert.equal(String(cell(first.id)).includes('现场备注ZZZ'), false);
  assert.equal(String(cell(first.id)).includes('样品定位偏离'), false);
  const table = previewRows(rows.map((row) => row.map((entry) => (entry == null ? '' : String(entry)))));
  assert.ok(table.warnings.some((warning) => warning.includes('最近结束')));
  const importedId = store.command({
    type: 'createExperiment',
    code: 'END-2',
    name: '再导入最近结束',
  }).experimentId!;
  importTable(store, { experimentId: importedId, table, mapping: table.mapping, keepOtherColumns: true });
  assert.equal(store.snapshot().runs.length, 1);
  assert.equal(
    store.snapshot().experiments.find((entry) => entry.id === importedId)?.fields.some((field) => field.label === '最近结束'),
    false,
  );
  assert.equal(store.snapshot().runs[0].originalEndedAt, finished.runs[0].originalEndedAt);
  assert.equal(store.snapshot().runs[0].snapshot.group.thickness, finished.runs[0].snapshot.group.thickness);
  store.command({ type: 'start', itemId: second.id });
  assert.equal(latestEndedMark(store.snapshot(), first.id), '最近完成');
  assert.equal(latestEndedMark(store.snapshot(), second.id), '');
  now += 60_000;
  store.command({ type: 'finish', itemId: second.id });
  const moved = store.snapshot();
  assert.equal(latestEndedMark(moved, first.id), '');
  assert.equal(latestEndedMark(moved, second.id), '最近完成');
  assert.equal(moved.runs.find((entry) => entry.id === run.id)?.originalEndedAt, finished.runs[0].originalEndedAt);
  const movedReport = await renderReport(moved, experimentId, store.root);
  assert.match(movedReport.html, /最近结束：最近完成 · S02/);
  const firstHtml = movedReport.html.split('<h2>S01')[1]?.split('<h2>S02')[0] || '';
  assert.equal(firstHtml.includes('最近完成'), false);
  const otherId = store.command({
    type: 'createExperiment',
    code: 'END-3',
    name: '中断标记',
  }).experimentId!;
  keepHistoricalSampleCodes(store, otherId);
  store.command({
    type: 'addSamples',
    experimentId: otherId,
    patch: { state: '原状态', preparedCount: 1, notes: '另一备注ZZZ' },
    count: 1,
  });
  const interruptedItem = store.snapshot().items.find((item) => item.experimentId === otherId)!;
  store.command({ type: 'start', itemId: interruptedItem.id });
  store.command({
    type: 'saveRun',
    runId: store.snapshot().runs.find((entry) => entry.itemId === interruptedItem.id)!.id,
    notes: '中断备注ZZZ',
  });
  store.command({ type: 'interrupt', itemId: interruptedItem.id });
  const interrupted = store.snapshot();
  assert.equal(latestEndedMark(interrupted, interruptedItem.id), '最近中断');
  const interruptedSummary = latestEndedSummary(interrupted, otherId);
  assert.match(interruptedSummary, /^最近中断 · S01 · /);
  assert.equal(interruptedSummary.includes('中断备注ZZZ'), false);
  assert.equal(interruptedSummary.includes('另一备注ZZZ'), false);
  assert.equal(latestEndedMark(interrupted, first.id), '');
  assert.equal(interrupted.runs.find((entry) => entry.id === run.id)?.originalEndedAt, finished.runs[0].originalEndedAt);
});

test('a running report names the open operation without estimating its duration', async (t) => {
  const { store } = fixture(t, () => new Date('2026-10-13T01:00:00.000Z'));
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'RUN-1',
    name: '进行中报告',
  }).experimentId!;
  keepHistoricalSampleCodes(store, experimentId);
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '原状态', preparedCount: 2, notes: '隐藏词ZZZ' },
    count: 2,
  });
  const [first, second] = store.snapshot().items;
  const groupId = store.snapshot().groups[0].id;
  store.command({
    type: 'updateGroups',
    ids: [groupId],
    patch: { mode: 'In situ', protocol: '10 °C/min 升至 375 °C' },
  });
  assert.equal(runningOperationSummary(store.snapshot(), experimentId), '');
  store.command({ type: 'start', itemId: first.id });
  const started = store.snapshot().runs[0];
  store.command({
    type: 'saveRun',
    runId: started.id,
    notes: '现场备注ZZZ',
    actual: { scanId: 'SCAN-RUN-1', filename: 'frame-001.cbf', files: 'E:\\raw\\hidden.cbf' },
  });
  const summary = runningOperationSummary(store.snapshot(), experimentId);
  assert.match(summary, /^进行中 · S01 · /);
  assert.match(summary, /扫描 SCAN-RUN-1/);
  assert.match(summary, /文件 frame-001\.cbf/);
  assert.match(summary, /原位/);
  assert.match(summary, /10 °C\/min 升至 375 °C/);
  assert.match(summary, /用时未计入$/);
  store.command({
    type: 'updateGroups',
    ids: [groupId],
    patch: { protocol: '后来改成 450 °C' },
  });
  const frozen = runningOperationSummary(store.snapshot(), experimentId);
  assert.match(frozen, /375/);
  assert.equal(frozen.includes('450'), false);
  assert.equal(store.snapshot().runs[0].snapshot.group.protocol, '10 °C/min 升至 375 °C');
  assert.equal(store.snapshot().groups[0].protocol, '后来改成 450 °C');
  assert.equal(summary.includes('结束'), false);
  assert.equal(summary.includes('hidden.cbf'), false);
  assert.equal(summary.includes('现场备注ZZZ'), false);
  assert.equal(summary.includes('隐藏词ZZZ'), false);
  const report = await renderReport(store.snapshot(), experimentId, store.root);
  const htmlLine = report.html.match(/进行中 · S01[\s\S]*?用时未计入/)?.[0] || '';
  const markdownLine = report.markdown.split('\n').find((line) => line.includes('进行中 · S01')) || '';
  assert.match(htmlLine, /扫描 SCAN-RUN-1/);
  assert.match(htmlLine, /10 °C\/min 升至 375 °C/);
  assert.equal(htmlLine.includes('450'), false);
  assert.equal(htmlLine.includes('hidden.cbf'), false);
  assert.equal(htmlLine.includes('现场备注ZZZ'), false);
  assert.equal(markdownLine.includes('hidden.cbf'), false);
  assert.equal(markdownLine.includes('现场备注ZZZ'), false);
  const rows = csvRows(store.snapshot(), experimentId);
  const header = rows[0].map(String);
  const described = (id: string) =>
    rows.find((row) => row[header.indexOf('记录类型')] === '操作' && row[header.indexOf('plan_item_id')] === id)?.[
      header.indexOf('进行中说明')
    ];
  assert.equal(described(first.id), summary);
  assert.equal(described(second.id), '');
  assert.equal(String(described(first.id)).includes('hidden.cbf'), false);
  const table = previewRows(rows.map((row) => row.map((entry) => (entry == null ? '' : String(entry)))));
  assert.ok(table.warnings.some((warning) => warning.includes('进行中说明')));
  const importedId = store.command({
    type: 'createExperiment',
    code: 'RUN-2',
    name: '再导入进行中',
  }).experimentId!;
  importTable(store, { experimentId: importedId, table, mapping: table.mapping, keepOtherColumns: true });
  assert.equal(store.snapshot().runs.length, 1);
  assert.equal(
    store.snapshot().experiments.find((entry) => entry.id === importedId)?.fields.some((field) => field.label === '进行中说明'),
    false,
  );
  const open = store.snapshot().runs[0];
  store.command({ type: 'finish', itemId: first.id });
  assert.equal(runningOperationSummary(store.snapshot(), experimentId), '');
  const finishedRows = csvRows(store.snapshot(), experimentId);
  const finishedHeader = finishedRows[0].map(String);
  const finishedCell = finishedRows.find(
    (row) =>
      row[finishedHeader.indexOf('记录类型')] === '操作' &&
      row[finishedHeader.indexOf('plan_item_id')] === first.id,
  )?.[finishedHeader.indexOf('进行中说明')];
  assert.equal(finishedCell, '');
  const finished = await renderReport(store.snapshot(), experimentId, store.root);
  assert.equal(finished.html.includes('进行中 · S01'), false);
  assert.equal(finished.markdown.includes('进行中 · S01'), false);
  assert.equal(store.snapshot().runs[0].originalStartedAt, open.originalStartedAt);
  assert.equal(store.snapshot().runs[0].originalEndedAt, store.snapshot().runs[0].endedAt);
  assert.equal(store.snapshot().items.find((item) => item.id === second.id)?.status, 'pending');
  assert.equal(store.snapshot().groups[0].preparedCount, 2);
});
