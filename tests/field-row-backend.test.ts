import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { Store } from '../src/desktop/store.js';
import { createBackup, inspectDatabase, unpackBackup } from '../src/desktop/backups.js';
import { fixture } from './helpers.js';

test('field row edits and repeat keep one specimen, independent notes and original snapshots', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    name: '测试',
    code: 'ROWS',
  }).experimentId!;
  const first = store.command({
    type: 'addSamples',
    experimentId,
    patch: { name: '钛合金', state: '固溶', preparedCount: 3 },
    count: 1,
    specimens: [
      {
        name: 'A-01',
        thickness: '1',
        thicknessUnit: 'mm',
        width: '3',
        dimensionUnit: 'mm',
        fieldNote: '准备说明',
      },
    ],
    measurement: { protocol: '室温' },
  }).itemId!;
  const sampleId = store.get('items', first).sampleId;
  assert.equal(store.get('items', first).fieldNote, '准备说明');
  store.command({ type: 'updateFieldRow', itemId: first, fieldNote: '第一次有问题' });
  assert.equal(store.snapshot().runs.length, 0, 'writing a note must not create a run');

  const retryRequest = 'repeat-unique-request';
  const retry = store.command({ type: 'repeat', itemId: first }, retryRequest).itemId!;
  assert.equal(store.command({ type: 'repeat', itemId: first }, retryRequest).itemId, retry);
  assert.equal(
    store.command({ type: 'repeat', itemId: first }).itemId,
    retry,
    'repeated clicks reuse the pending retry',
  );
  assert.equal(store.get('items', retry).fieldNote, '');
  assert.equal(store.get('items', retry).sampleId, sampleId);
  assert.equal(store.get('items', retry).repeatOf, first);
  assert.equal(store.get('items', first).status, 'pending');
  assert.deepEqual(
    store.snapshot().items.map((item) => item.plannedName),
    ['G-1', 'G-1-2'],
  );
  assert.equal(store.snapshot().samples.length, 1);
  assert.equal(store.snapshot().groups[0].preparedCount, 3);
  assert.throws(() => store.command({ type: 'deleteItems', ids: [first] }), /后续测量引用/);

  store.command({ type: 'start', itemId: first });
  const beforeFirst = structuredClone(store.snapshot().runs[0]);
  store.command({ type: 'finish', itemId: first });
  store.command({ type: 'start', itemId: retry });
  const beforeRetry = structuredClone(store.snapshot().runs.find((run) => run.itemId === retry)!);
  store.command({
    type: 'updateFieldRow',
    itemId: first,
    sample: { state: '时效', thickness: '1.2', width: '2.8' },
    protocol: '400 °C',
    fieldNote: '',
  });
  const snapshot = store.snapshot();
  const firstRun = snapshot.runs.find((run) => run.itemId === first)!;
  const retryRun = snapshot.runs.find((run) => run.itemId === retry)!;
  assert.deepEqual(firstRun.snapshot, beforeFirst.snapshot);
  assert.deepEqual(retryRun, beforeRetry, 'other started measurements must not change');
  assert.equal(firstRun.actual.thickness, '1.2');
  assert.equal(firstRun.actual.thicknessUnit, 'mm');
  assert.equal(firstRun.actualSample?.width, '2.8');
  assert.equal(firstRun.actualSample?.state, '时效');
  assert.equal(firstRun.actual.protocol, '400 °C');
  assert.equal(snapshot.samples[0].parameters.thickness, '1.2');
  assert.equal(snapshot.samples[0].parameters.state, '时效');
  assert.equal(snapshot.items.find((item) => item.id === first)?.fieldNote, '');
  assert.equal(firstRun.originalStartedAt, beforeFirst.originalStartedAt);
  assert.equal(firstRun.filename, 'G-1');
  assert.equal(firstRun.notes, '', 'the legacy run note must never be overwritten');
  const eventCount = snapshot.events.length;
  store.command({
    type: 'updateFieldRow',
    itemId: first,
    sample: { state: '时效', thickness: '1.2', width: '2.8' },
    protocol: '400 °C',
    fieldNote: '',
  });
  assert.equal(
    store.snapshot().events.length,
    eventCount,
    'retry with a fresh request id must not duplicate actual events',
  );
});

test('blank sample labels stay blank when a started row changes only size', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    name: '测试',
    code: 'EMPTY',
  }).experimentId!;
  const itemId = store.command({
    type: 'addSamples',
    experimentId,
    patch: { name: 'Ti2448', state: '固溶' },
    count: 1,
  }).itemId!;
  store.command({ type: 'start', itemId });
  const original = store.snapshot().runs[0];
  assert.equal(original.snapshot.sample.parameters.name, undefined);
  store.command({ type: 'updateFieldRow', itemId, sample: { width: '3', state: '' } });
  const saved = store.snapshot().runs[0];
  assert.equal(saved.actualSample?.specimenName, undefined);
  assert.equal(saved.actualSample?.state, '');
  assert.equal(saved.snapshot.group.name, 'Ti2448');
  store.command({ type: 'updateFieldRow', itemId, sample: { name: 'Ti2448' } });
  const edited = store.snapshot().runs[0];
  assert.equal(edited.actualSample?.specimenName, 'Ti2448');
  assert.equal(edited.actualSample?.name, saved.actualSample?.name);
  assert.equal(edited.actualSources?.['actualSample.name'], saved.actualSources?.['actualSample.name']);
  assert.equal(edited.actualSources?.['actualSample.specimenName'], 'edited');
  store.command({ type: 'saveRun', runId: saved.id, actualSample: { name: '后续修正' } });
  const groupEdited = store.snapshot().runs[0];
  assert.equal(groupEdited.actualSample?.name, '后续修正');
  assert.equal(groupEdited.actualSample?.specimenName, 'Ti2448');
  store.command({ type: 'saveRun', runId: saved.id, actualSample: { specimenName: '样品新编号' } });
  const corrected = store.snapshot().runs[0];
  assert.equal(corrected.actualSample?.specimenName, '样品新编号');
  assert.equal(corrected.actualSample?.name, '后续修正');
  assert.equal(corrected.actualSources?.['actualSample.name'], 'edited');
  assert.equal(corrected.actualSources?.['actualSample.specimenName'], 'edited');
  assert.equal(inspectDatabase(join(store.root, 'records.sqlite')).schemaVersion, 3);
});

test('repeat copies the currently recorded condition including explicit blanks, without inheriting notes', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    name: '测试',
    code: 'REPEAT',
  }).experimentId!;
  const itemId = store.command({
    type: 'addSamples',
    experimentId,
    patch: { name: 'A', state: '固溶', protocol: '开始时条件' },
    count: 1,
  }).itemId!;
  store.command({ type: 'start', itemId });
  const firstSnapshot = structuredClone(store.snapshot().runs[0].snapshot);
  store.command({
    type: 'updateFieldRow',
    itemId,
    protocol: '实际修正条件',
    fieldNote: '第一回问题',
  });
  const second = store.command({ type: 'repeat', itemId }).itemId!;
  assert.equal(store.get('items', second).measurement?.protocol, '实际修正条件');
  assert.equal(store.get('items', second).fieldNote, '');
  assert.deepEqual(store.snapshot().runs[0].snapshot, firstSnapshot);
  store.command({ type: 'finish', itemId });
  store.command({ type: 'start', itemId: second });
  store.command({ type: 'updateFieldRow', itemId: second, protocol: '', fieldNote: '第二回' });
  const third = store.command({ type: 'repeat', itemId: second }).itemId!;
  assert.equal(store.get('items', third).measurement?.protocol, '');
  assert.equal(store.get('items', third).fieldNote, '');
  assert.equal(store.get('items', third).plannedName, 'G-1-3');
});

test('repeat accepts each source status without changing its source or specimen count', (t) => {
  for (const status of ['pending', 'running', 'completed', 'interrupted', 'skipped'] as const) {
    const { store } = fixture(t);
    const experimentId = store.command({
      type: 'createExperiment',
      name: '状态检查',
      code: `STATUS-${status}`,
    }).experimentId!;
    const itemId = store.command({
      type: 'addSamples',
      experimentId,
      patch: { name: '样品', preparedCount: 3 },
      count: 1,
      specimens: [{ fieldNote: '原记录' }],
      measurement: { protocol: '保持条件' },
    }).itemId!;
    if (status === 'skipped') store.command({ type: 'skip', itemId, reason: '调整计划' });
    if (status === 'running' || status === 'completed' || status === 'interrupted') {
      store.command({ type: 'start', itemId });
      if (status === 'completed') store.command({ type: 'finish', itemId });
      if (status === 'interrupted') store.command({ type: 'interrupt', itemId, reason: '暂停' });
    }
    const sourceItem = structuredClone(store.get('items', itemId));
    const sourceRun = structuredClone(store.snapshot().runs[0] ?? null);
    const repeatId = store.command({ type: 'repeat', itemId }).itemId!;
    const snapshot = store.snapshot();
    assert.equal(sourceItem.status, status);
    assert.deepEqual(store.get('items', itemId), sourceItem);
    assert.deepEqual(snapshot.runs[0] ?? null, sourceRun);
    assert.equal(snapshot.samples.length, 1);
    assert.equal(snapshot.groups[0].preparedCount, 3);
    assert.equal(snapshot.items.length, 2);
    assert.equal(store.get('items', repeatId).sampleId, sourceItem.sampleId);
    assert.equal(store.get('items', repeatId).fieldNote, '');
    assert.equal(store.get('items', repeatId).measurement?.protocol, '保持条件');
    assert.equal(store.get('items', repeatId).plannedName, 'G-1-2');
    assert.equal(store.command({ type: 'repeat', itemId }).itemId, repeatId);
  }
});

async function packageV1(database: string, archive: string) {
  const data = await readFile(database);
  const zip = new JSZip();
  zip.file('records.sqlite', data);
  zip.file(
    'manifest.json',
    JSON.stringify({
      format: 'LabRecordBackup',
      version: 1,
      createdAt: new Date().toISOString(),
      files: [
        {
          name: 'records.sqlite',
          size: data.length,
          sha256: createHash('sha256').update(data).digest('hex'),
        },
      ],
    }),
  );
  await writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }));
}

test('v1 backup restores and migrates to v3 without changing records or inventing runs', async (t) => {
  const f = fixture(t);
  const experimentId = f.store.command({
    type: 'createExperiment',
    name: '旧版',
    code: 'OLD',
  }).experimentId!;
  const itemId = f.store.command({
    type: 'addSamples',
    experimentId,
    patch: { name: '旧样品', notes: '已有样品备注' },
    count: 1,
  }).itemId!;
  const before = f.store.snapshot();
  f.store.close();
  const oldDb = join(f.directory, 'workspace', 'records.sqlite');
  const db = new DatabaseSync(oldDb);
  db.exec('ALTER TABLE items DROP COLUMN field_note; PRAGMA user_version=1;');
  db.close();
  assert.equal(inspectDatabase(oldDb).schemaVersion, 1);
  const oldBackup = join(f.directory, 'old.labrecord');
  await packageV1(oldDb, oldBackup);
  const restored = join(f.directory, 'restored');
  assert.equal((await unpackBackup(oldBackup, restored)).schemaVersion, 1);
  const upgraded = new Store(restored);
  try {
    assert.equal(upgraded.snapshot().schemaVersion, 3);
    assert.deepEqual(upgraded.snapshot().items, before.items);
    assert.deepEqual(upgraded.snapshot().groups, before.groups);
    assert.equal(upgraded.snapshot().runs.length, 0);
    assert.equal(upgraded.get('items', itemId).fieldNote, undefined);
    upgraded.command({ type: 'updateFieldRow', itemId, fieldNote: '' });
    const nextBackup = join(f.directory, 'new.labrecord');
    await createBackup(upgraded, nextBackup);
    const next = await unpackBackup(nextBackup, join(f.directory, 'restored-v2'));
    assert.equal(next.schemaVersion, 3);
    assert.equal(next.items[0].fieldNote, '');
  } finally {
    upgraded.close();
  }
});

test('failed v1 migration rolls back both schema and version', (t) => {
  const f = fixture(t);
  const experimentId = f.store.command({
    type: 'createExperiment',
    name: '旧版',
    code: 'BROKEN',
  }).experimentId!;
  f.store.command({ type: 'addSamples', experimentId, patch: { name: '旧样品' }, count: 1 });
  f.store.close();
  const dbPath = join(f.directory, 'workspace', 'records.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(
    "ALTER TABLE items DROP COLUMN field_note; UPDATE items SET json=json_set(json, '$.fieldNote', 17); PRAGMA user_version=1;",
  );
  const before = db.prepare('SELECT json FROM items').get()?.json;
  db.close();
  assert.throws(() => new Store(join(f.directory, 'workspace')), /旧数据中的现场备注格式无效/);
  const after = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(after.prepare('PRAGMA user_version').get()?.user_version, 1);
    assert.equal(after.prepare('SELECT json FROM items').get()?.json, before);
    assert.equal(
      after
        .prepare('PRAGMA table_info(items)')
        .all()
        .some((col) => col.name === 'field_note'),
      false,
    );
  } finally {
    after.close();
  }
});

test('v2 note column preserves absent and blank separately and rejects inconsistent backups', async (t) => {
  const f = fixture(t);
  const experimentId = f.store.command({
    type: 'createExperiment',
    name: '一致性',
    code: 'V2',
  }).experimentId!;
  const itemId = f.store.command({
    type: 'addSamples',
    experimentId,
    patch: { name: 'A' },
    count: 1,
  }).itemId!;
  const column = () =>
    f.store.db.prepare('SELECT field_note FROM items WHERE id=?').get(itemId)?.field_note;
  assert.equal(column(), null);
  f.store.command({ type: 'updateFieldRow', itemId, fieldNote: '' });
  assert.equal(column(), '');
  assert.equal(inspectDatabase(join(f.store.root, 'records.sqlite')).items[0].fieldNote, '');
  f.store.db.prepare('UPDATE items SET field_note=? WHERE id=?').run('不同', itemId);
  assert.throws(
    () => inspectDatabase(join(f.store.root, 'records.sqlite')),
    /记录内容与数据库索引不一致/,
  );
  await assert.rejects(
    createBackup(f.store, join(f.directory, 'invalid.labrecord')),
    /记录内容与数据库索引不一致/,
  );
  assert.equal(f.store.get('items', itemId).fieldNote, '');
});
