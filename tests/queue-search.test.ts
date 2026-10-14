import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/desktop/reports.js';
import { groupOperationText, queueSearchText } from '../src/ui/queueSearch.js';
import { searchWorkspace } from '../src/ui/workspaceSearch.js';
import { textIncludes } from '../src/shared/operationQuery.js';
import { fixture } from './helpers.js';

test('live queue search finds scan ids and file references without notes', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'Q-1',
    name: '队列搜索',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '原状态', material: 'Ti2448', preparedCount: 2, notes: '样品组备注ZZZ' },
    count: 2,
  });
  const [first, second] = store.snapshot().items;
  store.command({ type: 'start', itemId: first.id });
  const run = store.snapshot().runs[0];
  store.command({
    type: 'saveRun',
    runId: run.id,
    notes: '现场备注ZZZ',
    actual: {
      scanId: 'SCAN-QUEUE-02',
      filename: 'frame_queue.cbf',
      files: 'D:\\beam\\frame.cbf',
    },
  });
  const snapshot = store.snapshot();
  const started = queueSearchText(snapshot, snapshot.items.find((item) => item.id === first.id)!);
  const pending = queueSearchText(snapshot, second);
  assert.equal(textIncludes(started, 'SCAN-QUEUE-02'), true);
  assert.equal(textIncludes(started, 'frame_queue.cbf'), true);
  assert.equal(textIncludes(started, 'D:\\beam\\frame.cbf'), true);
  assert.equal(textIncludes(started, 'Ti2448'), true);
  assert.equal(textIncludes(started, '现场备注ZZZ'), false);
  assert.equal(textIncludes(started, '样品组备注ZZZ'), false);
  const groupId = snapshot.samples.find((sample) => sample.id === first.sampleId)!.groupId;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '另一组', preparedCount: 1 },
    count: 1,
  });
  const after = store.snapshot();
  const otherGroup = after.groups.find((group) => group.id !== groupId)!.id;
  assert.equal(textIncludes(groupOperationText(after, groupId), 'SCAN-QUEUE-02'), true);
  assert.equal(textIncludes(groupOperationText(after, otherGroup), 'SCAN-QUEUE-02'), false);
  assert.equal(textIncludes(groupOperationText(after, groupId), '样品组备注ZZZ'), false);
  assert.equal(textIncludes(pending, 'SCAN-QUEUE-02'), false);
  assert.equal(textIncludes(pending, second.plannedName || ''), true);
  assert.equal(snapshot.runs[0].originalStartedAt, run.originalStartedAt);
  assert.equal(snapshot.runs[0].endedAt, null);
});

test('queue search keeps the start protocol after the plan protocol changes', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'Q-P',
    name: '制度搜索',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: {
      state: '原状态',
      preparedCount: 2,
      protocol: '10 °C/min 升至 375 °C',
      notes: '样品组备注ZZZ',
    },
    count: 2,
  });
  const [first, second] = store.snapshot().items;
  const groupId = store.snapshot().groups[0].id;
  store.command({ type: 'start', itemId: first.id });
  store.command({
    type: 'updateGroups',
    ids: [groupId],
    patch: { protocol: '后来改成 450 °C' },
  });
  const current = store.snapshot();
  const started = queueSearchText(current, current.items.find((item) => item.id === first.id)!);
  const pending = queueSearchText(current, second);
  assert.equal(textIncludes(started, '375'), true);
  assert.equal(textIncludes(started, '450'), true);
  assert.equal(textIncludes(started, '样品组备注ZZZ'), false);
  assert.equal(textIncludes(pending, '450'), true);
  assert.equal(textIncludes(pending, '375'), false);
  assert.equal(current.runs[0].snapshot.group.protocol, '10 °C/min 升至 375 °C');
  assert.equal(current.groups[0].protocol, '后来改成 450 °C');
  assert.equal(current.runs[0].originalStartedAt, current.runs[0].startedAt);
});

test('queue search finds actual and start thickness, not a later plan edit or notes', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'Q-2',
    name: '尺寸搜索',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: {
      state: '原状态',
      preparedCount: 2,
      thickness: '0.8',
      thicknessUnit: 'mm',
      width: '3',
      dimensionUnit: 'mm',
      notes: '样品组备注ZZZ',
    },
    count: 2,
  });
  const [first, second] = store.snapshot().items;
  store.command({ type: 'start', itemId: first.id });
  const run = store.snapshot().runs[0];
  store.command({
    type: 'saveRun',
    runId: run.id,
    notes: '现场备注ZZZ',
    actual: { thickness: '1.1' },
  });
  store.command({
    type: 'updateGroups',
    ids: [store.snapshot().groups[0].id],
    patch: { thickness: '9.9' },
  });
  const snapshot = store.snapshot();
  const started = queueSearchText(snapshot, snapshot.items.find((item) => item.id === first.id)!);
  const pending = queueSearchText(snapshot, snapshot.items.find((item) => item.id === second.id)!);
  assert.equal(textIncludes(started, '1.1'), true);
  assert.equal(textIncludes(started, '0.8'), true);
  assert.equal(textIncludes(started, '9.9'), true);
  assert.equal(textIncludes(started, '当前计划已不同'), true);
  assert.equal(textIncludes(started, '现场备注ZZZ'), false);
  assert.equal(textIncludes(started, '样品组备注ZZZ'), false);
  assert.equal(textIncludes(pending, '9.9'), true);
  assert.equal(textIncludes(pending, '1.1'), false);
  assert.equal(snapshot.runs[0].snapshot.group.thickness, '0.8');
  assert.equal(snapshot.runs[0].originalStartedAt, run.originalStartedAt);
});

test('pending search uses a sample override and keeps the start snapshot after it changes', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'Q-3',
    name: '样品覆盖',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: {
      state: '原状态',
      preparedCount: 2,
      thickness: '0.8',
      thicknessUnit: 'mm',
      notes: '样品组备注ZZZ',
    },
    count: 2,
  });
  const [first, second] = store.snapshot().items;
  store.command({
    type: 'updateSamples',
    ids: [first.sampleId],
    parameters: { thickness: '1.5', heatTreatment: '样品自己的热处理' },
  });
  let snapshot = store.snapshot();
  const pendingFirst = queueSearchText(
    snapshot,
    snapshot.items.find((item) => item.id === first.id)!,
  );
  const pendingSecond = queueSearchText(
    snapshot,
    snapshot.items.find((item) => item.id === second.id)!,
  );
  assert.equal(textIncludes(pendingFirst, '1.5'), true);
  assert.equal(textIncludes(pendingFirst, '样品自己的热处理'), true);
  assert.equal(textIncludes(pendingFirst, '样品组备注ZZZ'), false);
  assert.equal(textIncludes(pendingSecond, '1.5'), false);
  assert.equal(textIncludes(pendingSecond, '0.8'), true);
  store.command({ type: 'start', itemId: first.id });
  const run = store.snapshot().runs[0];
  store.command({
    type: 'updateSamples',
    ids: [first.sampleId],
    parameters: { thickness: '2.2' },
  });
  snapshot = store.snapshot();
  const started = queueSearchText(
    snapshot,
    snapshot.items.find((item) => item.id === first.id)!,
  );
  assert.equal(textIncludes(started, '1.5'), true);
  assert.equal(textIncludes(started, '2.2'), true);
  assert.equal(textIncludes(started, '当前计划已不同'), true);
  assert.equal(textIncludes(started, '样品组备注ZZZ'), false);
  const pendingAfter = queueSearchText(
    snapshot,
    snapshot.items.find((item) => item.id === second.id)!,
  );
  assert.equal(textIncludes(pendingAfter, '2.2'), false);
  assert.equal(snapshot.runs[0].snapshot.group.thickness, '1.5');
  assert.equal(snapshot.runs[0].originalStartedAt, run.originalStartedAt);
  assert.deepEqual(
    searchWorkspace(snapshot, '1.5').map((hit) => hit.itemId),
    [first.id],
  );
  const drifted = searchWorkspace(snapshot, '2.2');
  assert.deepEqual(
    drifted.map((hit) => hit.itemId),
    [first.id],
  );
  assert.match(drifted[0].title, /当前计划已不同/);
  assert.equal(searchWorkspace(snapshot, '样品组备注ZZZ').length, 0);
});

test('queue and library search find a recorded preparation and sample name, not notes or custom values', async (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'Q-3',
    name: '实际检索',
  }).experimentId!;
  store.command({
    type: 'updateExperiment',
    id: experimentId,
    fields: [{ id: 'composition', label: '成分', type: 'text' as const, unit: '', options: [] }],
  });
  store.command({
    type: 'addSamples',
    experimentId,
    patch: {
      state: '原状态',
      name: '计划试样',
      preparedCount: 2,
      mode: 'In situ',
      preparation: '制备批次 A',
      values: { composition: '演示材料' },
      notes: '样品组备注ZZZ',
    },
    count: 2,
  });
  const [first, second] = store.snapshot().items;
  store.command({ type: 'start', itemId: first.id });
  const run = store.snapshot().runs[0];
  store.command({
    type: 'saveRun',
    runId: run.id,
    notes: '现场备注ZZZ',
    actual: { preparation: '试剂批次 K-9', mode: 'Ex situ', composition: '秘密组分' },
    actualSample: { name: '现场试样甲' },
  });
  store.command({
    type: 'updateGroups',
    ids: [store.snapshot().groups[0].id],
    patch: { preparation: '后来改的制备' },
  });
  const snapshot = store.snapshot();
  const started = queueSearchText(snapshot, snapshot.items.find((item) => item.id === first.id)!);
  const pending = queueSearchText(snapshot, second);
  assert.equal(textIncludes(started, '试剂批次 K-9'), true);
  assert.equal(textIncludes(started, '现场试样甲'), true);
  assert.equal(textIncludes(started, '非原位'), true);
  assert.equal(textIncludes(started, '制备批次 A'), true);
  assert.equal(textIncludes(started, '秘密组分'), false);
  assert.equal(textIncludes(started, '演示材料'), false);
  assert.equal(textIncludes(started, '现场备注ZZZ'), false);
  assert.equal(textIncludes(started, '样品组备注ZZZ'), false);
  assert.equal(textIncludes(pending, '试剂批次 K-9'), false);
  assert.equal(textIncludes(pending, '现场试样甲'), false);
  assert.equal(textIncludes(groupOperationText(snapshot, snapshot.groups[0].id), '试剂批次 K-9'), true);
  const found = searchWorkspace(snapshot, '试剂批次 K-9');
  assert.deepEqual(found.map((hit) => hit.itemId), [first.id]);
  assert.match(found[0].title, /制备/);
  assert.deepEqual(searchWorkspace(snapshot, '现场试样甲').map((hit) => hit.itemId), [first.id]);
  assert.equal(searchWorkspace(snapshot, '秘密组分').length, 0);
  assert.equal(searchWorkspace(snapshot, '演示材料').length, 0);
  assert.equal(searchWorkspace(snapshot, '现场备注ZZZ').length, 0);
  assert.equal(snapshot.runs[0].snapshot.group.preparation, '制备批次 A');
  assert.equal(snapshot.runs[0].originalStartedAt, run.originalStartedAt);
  assert.equal(snapshot.runs[0].endedAt, null);
  assert.equal(snapshot.groups[0].preparation, '后来改的制备');
  assert.equal(snapshot.items.find((item) => item.id === second.id)?.status, 'pending');
  const report = await renderReport(snapshot, experimentId, store.root);
  const sentence = '制备/试剂：制备批次 A → 试剂批次 K-9';
  assert.equal(report.html.includes(sentence), true);
  assert.equal(report.markdown.includes(sentence), true);
  assert.equal(report.html.includes('样品名：计划试样 → 现场试样甲'), true);
  assert.equal(report.markdown.includes('实验方式：原位 → 非原位'), true);
  assert.equal(report.html.includes('秘密组分：'), false);
  assert.equal(report.markdown.includes('现场备注ZZZ'), false);
  const pendingCode = snapshot.samples.find((sample) => sample.id === second.sampleId)!.code;
  const pendingSection = report.markdown.split('\n### ').find((section) => section.startsWith(pendingCode));
  assert.equal(pendingSection?.includes('试剂批次 K-9'), false);
  assert.equal(pendingSection?.includes('现场试样甲'), false);
});

test('queue and library search find a picture name and drop it after removal', async (t) => {
  const { store, directory } = fixture(t);
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { addAttachment, removeAttachment } = await import('../src/desktop/backups.js');
  const { PNG } = await import('./helpers.js');
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'PIC-1',
    name: '图片搜索',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '原状态', preparedCount: 2, notes: '样品组备注ZZZ' },
    count: 2,
  });
  const [first, second] = store.snapshot().items;
  store.command({ type: 'start', itemId: first.id });
  const run = store.snapshot().runs[0];
  store.command({ type: 'saveRun', runId: run.id, notes: '现场备注ZZZ' });
  const picture = join(directory, '装样照片.png');
  await writeFile(picture, PNG);
  const attachment = await addAttachment(store, run.id, picture);
  const attached = store.snapshot();
  const started = queueSearchText(attached, attached.items.find((item) => item.id === first.id)!);
  const pending = queueSearchText(attached, second);
  assert.equal(textIncludes(started, '装样照片.png'), true);
  assert.equal(textIncludes(started, '图片'), true);
  assert.equal(textIncludes(started, '现场备注ZZZ'), false);
  assert.equal(textIncludes(started, '样品组备注ZZZ'), false);
  assert.equal(textIncludes(started, '移除图片'), false);
  assert.equal(textIncludes(pending, '装样照片.png'), false);
  assert.equal(textIncludes(groupOperationText(attached, attached.groups[0].id), '装样照片.png'), true);
  const found = searchWorkspace(attached, '装样照片.png');
  assert.deepEqual(found.map((hit) => hit.itemId), [first.id]);
  assert.match(found[0].title, /图片/);
  await removeAttachment(store, attachment.id);
  const removed = store.snapshot();
  assert.equal(
    textIncludes(queueSearchText(removed, removed.items.find((item) => item.id === first.id)!), '装样照片.png'),
    false,
  );
  assert.equal(searchWorkspace(removed, '装样照片.png').length, 0);
  assert.deepEqual(removed.runs[0].snapshot, attached.runs[0].snapshot);
  assert.equal(removed.runs[0].originalStartedAt, run.originalStartedAt);
  assert.equal(removed.runs[0].endedAt, null);
  assert.equal(removed.attachments.length, 0);
  assert.equal(removed.runs[0].notes, '现场备注ZZZ');
});
