import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Store } from '../src/desktop/store.js';
import { archiveSchema } from '../src/desktop/archive-validation.js';
import { createBackup, unpackBackup } from '../src/desktop/backups.js';
import { validateCommand } from '../src/desktop/validation.js';
import { fixture } from './helpers.js';

test('new actual values identify plan defaults and later edits without changing start evidence', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({ type: 'createExperiment', code: 'SRC', name: '来源' }).experimentId!;
  const itemId = store.command({
    type: 'addSamples', experimentId,
    patch: { name: '原始 A', state: '固溶', preparedCount: 1 }, count: 1,
    specimens: [{ width: '3', height: '', dimensionUnit: 'mm', thickness: '1', thicknessUnit: 'mm' }],
  }).itemId!;
  store.command({ type: 'start', itemId });
  const before = structuredClone(store.snapshot().runs[0]);
  assert.equal(before.actualSources?.['actualSample.state'], 'planned');
  assert.equal(before.actualSources?.['actualSample.width'], 'planned');
  assert.equal(before.actualSources?.['actual.thickness'], 'planned');
  assert.equal(before.actualSources?.['actualSample.specimenName'], undefined);
  store.command({ type: 'updateFieldRow', itemId, sample: { state: '', width: '2.9' } });
  const after = store.snapshot().runs[0];
  assert.equal(after.actualSample?.state, '');
  assert.equal(after.actualSources?.['actualSample.state'], 'edited');
  assert.equal(after.actualSources?.['actualSample.width'], 'edited');
  assert.equal(after.actualSources?.['actualSample.height'], 'planned');
  assert.equal(after.actualSources?.['actual.thickness'], 'planned');
  assert.deepEqual(after.snapshot, before.snapshot);
  assert.equal(after.originalStartedAt, before.originalStartedAt);
  assert.equal(after.originalEndedAt, before.originalEndedAt);
  assert.equal(archiveSchema.safeParse(store.snapshot()).success, true);
});

test('v2 unknown actual fields remain absent after single-field updates and explicit clearing', (t) => {
  const f = fixture(t);
  const experimentId = f.store.command({ type: 'createExperiment', code: 'LEG', name: '旧记录' }).experimentId!;
  const itemId = f.store.command({
    type: 'addSamples', experimentId,
    patch: { name: 'A', state: '固溶', preparedCount: 1 }, count: 1,
    specimens: [{ width: '3', height: '4', dimensionUnit: 'mm', thickness: '1', thicknessUnit: 'mm' }],
  }).itemId!;
  f.store.command({ type: 'start', itemId });
  const oldRun = structuredClone(f.store.snapshot().runs[0]);
  delete oldRun.actualSample;
  delete oldRun.actual.thickness;
  delete oldRun.actual.thicknessUnit;
  delete oldRun.actualSources;
  f.store.put('runs', oldRun);
  f.store.close();
  const database = new DatabaseSync(join(f.directory, 'workspace', 'records.sqlite'));
  database.exec('PRAGMA user_version=2');
  database.close();

  const store = new Store(join(f.directory, 'workspace'));
  try {
    const migrated = store.snapshot().runs[0];
    assert.deepEqual(migrated.snapshot, oldRun.snapshot);
    assert.equal(migrated.actualSample, undefined);
    assert.deepEqual(migrated.actualSources, {});
    assert.equal(migrated.originalStartedAt, oldRun.originalStartedAt);
    store.command({ type: 'updateFieldRow', itemId, sample: { state: '时效' } });
    let run = store.snapshot().runs[0];
    assert.deepEqual(run.actualSample, { state: '时效' });
    assert.deepEqual(run.actualSources, { 'actualSample.state': 'edited' });
    assert.equal(Object.hasOwn(run.actual, 'thickness'), false);
    assert.equal(Object.hasOwn(run.actual, 'thicknessUnit'), false);
    store.command({
      type: 'saveRun', runId: run.id,
      actual: { thicknessUnit: '' }, actualSample: { width: '' },
    });
    run = store.snapshot().runs[0];
    assert.deepEqual(run.actualSample, { state: '时效', width: '' });
    assert.equal(run.actual.thicknessUnit, '');
    assert.equal(Object.hasOwn(run.actual, 'thickness'), false);
    assert.equal(run.actualSources?.['actualSample.width'], 'edited');
    assert.equal(run.actualSources?.['actual.thicknessUnit'], 'edited');
    assert.deepEqual(run.snapshot, oldRun.snapshot);
    assert.equal(archiveSchema.safeParse(store.snapshot()).success, true);
    const eventCount = store.snapshot().events.length;
    store.command({ type: 'saveRun', runId: run.id, actual: {}, actualSample: {} });
    assert.equal(store.snapshot().events.length, eventCount, 'empty patches do not invent edits');
    assert.deepEqual(store.snapshot().runs[0], run);
  } finally {
    store.close();
  }
});

test('v2 migration retains each old value, labels legacy empty values, and rejects source collisions', (t) => {
  const f = fixture(t);
  f.store.command({ type: 'demo' });
  f.store.command({ type: 'start', itemId: f.store.snapshot().items[0].id });
  const oldRun = structuredClone(f.store.snapshot().runs[0]);
  oldRun.actualSample!.height = '';
  delete oldRun.actualSources;
  f.store.put('runs', oldRun);
  f.store.close();
  const path = join(f.directory, 'workspace', 'records.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version=2');
  db.close();
  const store = new Store(join(f.directory, 'workspace'));
  const migrated = store.snapshot().runs[0];
  assert.deepEqual(migrated.actualSample, oldRun.actualSample);
  assert.deepEqual(migrated.actual, oldRun.actual);
  assert.equal(migrated.actualSample?.height, '');
  assert.equal(migrated.actualSources?.['actualSample.height'], 'legacy');
  assert.equal(migrated.actualSources?.['actual.thickness'], 'legacy');
  store.close();

  const legacy = new DatabaseSync(path);
  const stored = legacy.prepare('SELECT json FROM runs').get()!.json as string;
  legacy.exec('PRAGMA user_version=2');
  legacy.close();
  assert.throws(() => new Store(join(f.directory, 'workspace')), /实际值来源格式无效/);
  const after = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(after.prepare('PRAGMA user_version').get()?.user_version, 2);
    assert.equal(after.prepare('SELECT json FROM runs').get()?.json, stored);
  } finally {
    after.close();
  }
});

test('archive validation rejects inconsistent provenance and unsupported legacy partial samples', (t) => {
  const { store } = fixture(t);
  store.command({ type: 'demo' });
  store.command({ type: 'start', itemId: store.snapshot().items[0].id });
  const snapshot = store.snapshot();
  assert.equal(archiveSchema.safeParse(snapshot).success, true);
  const missing = structuredClone(snapshot);
  delete missing.runs[0].actualSources!['actualSample.width'];
  assert.equal(archiveSchema.safeParse(missing).success, false);
  const extra = structuredClone(snapshot);
  delete extra.runs[0].actualSample!.width;
  assert.equal(archiveSchema.safeParse(extra).success, false);
  const old = structuredClone(snapshot);
  old.schemaVersion = 2;
  delete old.runs[0].actualSources;
  delete old.runs[0].actualSample!.width;
  assert.equal(archiveSchema.safeParse(old).success, false);
});

test('an unversioned database with existing tables is not treated as a new workspace', (t) => {
  const f = fixture(t);
  f.store.command({ type: 'demo' });
  const before = f.store.snapshot();
  f.store.close();
  const path = join(f.directory, 'workspace', 'records.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version=0');
  const original = db.prepare('SELECT json FROM experiments ORDER BY rowid').all();
  db.close();
  assert.throws(() => new Store(join(f.directory, 'workspace')), /已有记录但缺少受支持的格式版本/);
  const after = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(after.prepare('PRAGMA user_version').get()?.user_version, 0);
    assert.deepEqual(after.prepare('SELECT json FROM experiments ORDER BY rowid').all(), original);
    assert.equal(original.length, before.experiments.length);
  } finally {
    after.close();
  }
});

test('a database with a negative format version is rejected before migration', (t) => {
  const f = fixture(t);
  f.store.command({ type: 'demo' });
  f.store.command({ type: 'start', itemId: f.store.snapshot().items[0].id });
  const originalRun = f.store.snapshot().runs[0];
  f.store.close();
  const path = join(f.directory, 'workspace', 'records.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version=-1');
  const original = db.prepare('SELECT json FROM runs ORDER BY rowid').all();
  db.close();
  assert.throws(() => new Store(join(f.directory, 'workspace')), /数据格式版本无效或不受支持/);
  const after = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(after.prepare('PRAGMA user_version').get()?.user_version, -1);
    assert.deepEqual(after.prepare('SELECT json FROM runs ORDER BY rowid').all(), original);
    assert.deepEqual(JSON.parse(String(original[0].json)), originalRun);
  } finally {
    after.close();
  }
});

test('undefined IPC patch properties are absent, preserving planned and actual fields through backup', async (t) => {
  const f = fixture(t);
  const experimentId = f.store.command({ type: 'createExperiment', code: 'UNDEF', name: '空值' }).experimentId!;
  const itemId = f.store.command({
    type: 'addSamples', experimentId,
    patch: { name: 'A', state: '固溶' }, count: 1,
    specimens: [{ width: '3', dimensionUnit: 'mm' }],
  }).itemId!;
  f.store.command({ type: 'start', itemId });
  const run = f.store.snapshot().runs[0];
  delete run.actualSample!.width;
  delete run.actualSources!['actualSample.width'];
  f.store.put('runs', run);
  const sampleId = f.store.get('items', itemId).sampleId;
  assert.equal(f.store.get('samples', sampleId).parameters.width, '3');

  const missing = validateCommand({ type: 'saveRun', runId: run.id, actualSample: { state: '' } });
  const undefinedValue = validateCommand({ type: 'saveRun', runId: run.id, actualSample: { state: '', width: undefined } });
  assert.deepEqual(undefinedValue, missing);
  const explicitEmpty = validateCommand({ type: 'saveRun', runId: run.id, actualSample: { width: '' } });
  assert.equal(explicitEmpty.type, 'saveRun');
  if (explicitEmpty.type !== 'saveRun') throw new Error('Unexpected command type');
  assert.equal(Object.hasOwn(explicitEmpty.actualSample!, 'width'), true);
  assert.equal(explicitEmpty.actualSample!.width, '');
  const zeroAndNull = validateCommand({ type: 'saveRun', runId: run.id, actual: { thickness: 0, thicknessUnit: null } });
  assert.equal(zeroAndNull.type, 'saveRun');
  if (zeroAndNull.type !== 'saveRun') throw new Error('Unexpected command type');
  assert.deepEqual(zeroAndNull.actual, { thickness: 0, thicknessUnit: null });
  assert.throws(
    () => validateCommand({ type: 'saveRun', runId: run.id, actual: { thickness: undefined } }),
    /输入格式不正确/,
  );

  const groupId = f.store.snapshot().groups[0].id;
  f.store.command({ type: 'updateGroups', ids: [groupId], patch: { width: '4' } });
  f.store.command({ type: 'updateGroups', ids: [groupId], patch: { width: undefined } });
  assert.equal(f.store.get('groups', groupId).width, '4');

  f.store.command({ type: 'updateFieldRow', itemId, sample: { state: '', width: undefined } });
  assert.equal(f.store.get('samples', sampleId).parameters.width, '3');
  let current = f.store.snapshot().runs[0];
  assert.equal(Object.hasOwn(current.actualSample!, 'width'), false);
  assert.equal(Object.hasOwn(current.actualSources!, 'actualSample.width'), false);
  f.store.command({ type: 'saveRun', runId: run.id, actualSample: { width: undefined } });
  current = f.store.snapshot().runs[0];
  assert.equal(Object.hasOwn(current.actualSample!, 'width'), false);
  assert.equal(Object.hasOwn(current.actualSources!, 'actualSample.width'), false);
  const first = join(f.directory, 'undefined.labrecord');
  await createBackup(f.store, first);
  const restored = await unpackBackup(first, join(f.directory, 'restored-undefined'));
  assert.equal(Object.hasOwn(restored.runs[0].actualSample!, 'width'), false);
  assert.equal(Object.hasOwn(restored.runs[0].actualSources!, 'actualSample.width'), false);

  f.store.command({ type: 'saveRun', runId: run.id, actualSample: { width: '' } });
  current = f.store.snapshot().runs[0];
  assert.equal(current.actualSample!.width, '');
  assert.equal(current.actualSources!['actualSample.width'], 'edited');
  const second = join(f.directory, 'explicit-empty.labrecord');
  await createBackup(f.store, second);
  const emptyRestored = await unpackBackup(second, join(f.directory, 'restored-explicit-empty'));
  assert.equal(emptyRestored.runs[0].actualSample!.width, '');
  assert.equal(emptyRestored.runs[0].actualSources!['actualSample.width'], 'edited');
});
