import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fixture, PNG } from './helpers.js';
import { groupCounts } from '../src/shared/model.js';
import {
  importTable,
  previewRows,
  parseDelimited,
  exportFile,
  previewFile,
} from '../src/desktop/tables.js';
import { addAttachment, createBackup, unpackBackup } from '../src/desktop/backups.js';
import { renderReport, writeReportBundle } from '../src/desktop/reports.js';

test('quick addition atomically creates named samples and queue; dimensions retain planning and actual history', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'X001',
    name: '新实验',
  }).experimentId!;
  const input = {
    type: 'addSamples',
    experimentId,
    patch: {
      name: 'Ti2448 拉伸试样',
      state: '400C-aged',
      preparedCount: 6,
      thickness: '0.8',
      width: '3',
      dimensionUnit: 'mm',
      thicknessUnit: 'mm',
    },
    count: 4,
    prefix: 'S',
  } as const;
  const added = store.command(input, 'quick-001');
  store.command(input, 'quick-001');
  let snapshot = store.snapshot();
  assert.equal(snapshot.groups.length, 1);
  assert.equal(snapshot.samples.length, 4);
  assert.deepEqual(
    snapshot.samples.map((s) => s.code),
    ['S01', 'S02', 'S03', 'S04'],
  );
  assert.equal(groupCounts(snapshot, snapshot.groups[0]).spare, 2);
  assert.throws(() => store.command({ ...input, count: 7 }), /准备/);
  assert.equal(store.snapshot().groups.length, 1, 'failed arrange must not leave a new group');
  store.command({ type: 'start', itemId: added.itemId! });
  const run = store.snapshot().runs[0];
  store.command({
    type: 'updateGroups',
    ids: [snapshot.groups[0].id],
    patch: { name: '新计划名称', width: '4' },
  });
  store.command({
    type: 'saveRun',
    runId: run.id,
    actualSample: { name: 'Ti2448 实际试样', width: '2.95' },
  });
  snapshot = store.snapshot();
  assert.equal(snapshot.runs[0].snapshot.group.name, 'Ti2448 拉伸试样');
  assert.equal(snapshot.runs[0].snapshot.group.width, '3');
  assert.equal(snapshot.runs[0].actualSample!.width, '2.95');
  assert.equal(snapshot.runs[0].actualSample!.height, '');
  assert.equal(snapshot.events.at(-1)!.data.previous !== null, true);
});

test('name-only input and XLSX preserve separate name, original state, width, optional height and units', async (t) => {
  const { store, directory } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'X002',
    name: '表格',
  }).experimentId!;
  const table = previewRows(
    parseDelimited('样品名称\t准备数量\t宽度/mm\t高度\n001试样\t6\t3.25\t'),
    '名称表',
  );
  importTable(store, { experimentId, table, mapping: table.mapping, keepOtherColumns: true });
  const group = store.snapshot().groups[0];
  assert.equal(group.name, '001试样');
  assert.equal(group.state, '未指定');
  assert.equal(group.width, '3.25');
  assert.equal(group.height, '');
  assert.equal(group.dimensionUnit, 'mm');
  const path = join(directory, '新字段.xlsx');
  await exportFile(store.snapshot(), experimentId, 'xlsx', path);
  const exported = await previewFile(path);
  const second = store.command({
    type: 'createExperiment',
    code: 'X003',
    name: '回读',
  }).experimentId!;
  importTable(store, {
    experimentId: second,
    table: exported,
    mapping: exported.mapping,
    keepOtherColumns: true,
  });
  const copied = store.snapshot().groups.find((g) => g.experimentId === second)!;
  assert.equal(copied.name, group.name);
  assert.equal(copied.width, group.width);
  assert.equal(copied.height, group.height);
  assert.equal(copied.dimensionUnit, group.dimensionUnit);
});

test('old v1 backups without name or dimensions restore without inventing values or changing original run snapshots', async (t) => {
  const { store, directory } = fixture(t);
  store.command({ type: 'demo' });
  for (const group of store.snapshot().groups) {
    delete group.name;
    delete group.width;
    delete group.height;
    delete group.dimensionUnit;
    store.put('groups', group);
  }
  store.command({ type: 'start', itemId: store.snapshot().items[0].id });
  const run = store.snapshot().runs[0];
  delete run.actualSample;
  store.put('runs', run);
  const file = join(directory, '旧版.labrecord');
  await createBackup(store, file);
  const restored = await unpackBackup(file, join(directory, 'restored'));
  assert.equal(restored.groups[0].name, undefined);
  assert.equal(restored.groups[0].width, undefined);
  assert.equal(restored.runs[0].actualSample, undefined);
  assert.equal(restored.runs[0].endedAt, null);
  assert.deepEqual(restored.runs[0].snapshot, run.snapshot);
});

test('report bundle includes escaped HTML, full JSON, optional dimensions, original times, image bytes and verifiable manifest', async (t) => {
  const { store, directory } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'X004',
    name: '合金实验 <script>',
  }).experimentId!;
  const itemId = store.command({
    type: 'addSamples',
    experimentId,
    patch: {
      name: '试样 A',
      state: '<img onerror=alert(1)>',
      preparedCount: 1,
      width: '3',
      dimensionUnit: 'mm',
      notes: '原始计划 <script>不能执行</script>',
    },
    count: 1,
  }).itemId!;
  store.command({ type: 'start', itemId });
  const run = store.snapshot().runs[0];
  store.command({
    type: 'updateSamples',
    ids: [run.sampleId],
    code: '后续编号',
    parameters: { name: '后续计划名称' },
  });
  store.command({
    type: 'saveRun',
    runId: run.id,
    actualSample: { width: '2.9' },
    notes: '现场情况',
  });
  store.command({
    type: 'addEvent',
    experimentId,
    itemId,
    runId: run.id,
    eventType: 'issue',
    text: '需要重新对中',
  });
  const image = join(directory, '照片.png');
  await writeFile(image, PNG);
  await addAttachment(store, run.id, image);
  const rendered = await renderReport(store.snapshot(), experimentId, store.root);
  assert.ok(rendered.html.includes('&lt;script&gt;'));
  assert.ok(!rendered.html.includes('<script>'));
  assert.ok(rendered.html.includes('data:image/png;base64,'));
  assert.ok(rendered.html.includes('2.9 mm'));
  assert.equal(rendered.insights.missingTimes, 1);
  assert.equal(rendered.insights.unresolvedIssues, 1);
  assert.ok(rendered.markdown.includes('### S01 · 试样 A'));
  assert.ok(!rendered.markdown.includes('### 后续编号'));
  const path = await writeReportBundle(
    store.snapshot(),
    experimentId,
    store.root,
    directory,
    async () => Buffer.from('%PDF-1.7\nunit-test-placeholder'),
  );
  const json = JSON.parse(await readFile(join(path, 'records.json'), 'utf8'));
  assert.equal(json.runs[0].actualSample.width, '2.9');
  assert.equal(json.runs[0].originalEndedAt, null);
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'LabRecordReport');
  assert.equal(manifest.files.length, 5);
  const picture = manifest.files.find((f: any) => f.path.startsWith('images/'));
  assert.deepEqual(await readFile(join(path, picture.path)), PNG);
  for (const file of manifest.files) {
    const bytes = await readFile(join(path, file.path));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
  assert.ok((await readFile(join(path, 'README-agent.md'), 'utf8')).includes('records.json'));
  await assert.rejects(
    writeReportBundle(store.snapshot(), experimentId, store.root, directory, async () =>
      Buffer.from('invalid'),
    ),
    /PDF/,
  );
  await assert.rejects(
    writeReportBundle(store.snapshot(), experimentId, store.root, directory, async () => {
      await writeFile(
        join(store.root, store.snapshot().attachments[0].relativePath),
        Buffer.from('changed'),
      );
      return Buffer.from('%PDF-1.7\nunit-test-placeholder');
    }),
    /图片|附件|校验/,
  );
});
