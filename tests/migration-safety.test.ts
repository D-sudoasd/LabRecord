import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  addAttachment,
  backupBeforeV3Migration,
  inspectDatabase,
  removeMigrationValidationDirectory,
  unpackBackup,
} from '../src/desktop/backups.js';
import { Store } from '../src/desktop/store.js';
import { fixture, PNG } from './helpers.js';

function makeV1(root: string) {
  const db = new DatabaseSync(join(root, 'records.sqlite'));
  try {
    db.exec(`BEGIN IMMEDIATE;
      UPDATE runs SET json=json_remove(json, '$.actualSample.state', '$.actualSample.specimenName', '$.actualSources');
      UPDATE items SET json=json_remove(json, '$.fieldNote');
      ALTER TABLE items DROP COLUMN field_note;
      PRAGMA user_version=1;
      COMMIT;`);
  } finally {
    db.close();
  }
}

function makeV2(root: string) {
  const db = new DatabaseSync(join(root, 'records.sqlite'));
  try {
    db.exec(`BEGIN IMMEDIATE;
      UPDATE runs SET json=json_remove(json, '$.actualSources');
      PRAGMA user_version=2;
      COMMIT;`);
  } finally {
    db.close();
  }
}

test('migration validation cleanup rejects paths outside the backup directory or with another name', async (t) => {
  const { directory } = fixture(t);
  const backups = join(directory, 'backups');
  await mkdir(backups);
  const outside = await mkdtemp(join(directory, '.validate-v3-'));
  const ordinary = join(backups, 'ordinary');
  const link = join(backups, '.validate-v3-linked');
  await mkdir(ordinary);
  await symlink(outside, link, 'junction');
  await writeFile(join(outside, 'sentinel'), 'outside');
  await writeFile(join(ordinary, 'sentinel'), 'ordinary');
  await assert.rejects(removeMigrationValidationDirectory(backups, outside), /临时目录无效/);
  await assert.rejects(removeMigrationValidationDirectory(backups, ordinary), /临时目录无效/);
  await assert.rejects(removeMigrationValidationDirectory(backups, link), /临时目录无效/);
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'outside');
  assert.equal(await readFile(join(ordinary, 'sentinel'), 'utf8'), 'ordinary');

  const temporary = await mkdtemp(join(backups, '.validate-v3-'));
  await writeFile(join(temporary, 'sentinel'), 'temporary');
  await removeMigrationValidationDirectory(backups, temporary);
  await assert.rejects(stat(temporary), { code: 'ENOENT' });
});

test('v1 migration backup preserves the old database, notes, times and attachment bytes', async (t) => {
  const { store, directory } = fixture(t);
  const itemId = store.command({ type: 'demo' }).itemId!;
  store.command({ type: 'start', itemId });
  const run = store.snapshot().runs[0];
  store.command({ type: 'saveRun', runId: run.id, notes: '原始现场备注' });
  const image = join(directory, 'image.png');
  await writeFile(image, PNG);
  const attachment = await addAttachment(store, run.id, image);
  const root = store.root;
  store.close();
  makeV1(root);
  const original = inspectDatabase(join(root, 'records.sqlite'));
  assert.equal(original.schemaVersion, 1);

  const backupDirectory = join(directory, 'backups');
  const backup = await backupBeforeV3Migration(root, backupDirectory);
  assert.ok(backup);
  assert.match(backup, /before-v3-.*\.labrecord$/);
  assert.deepEqual(inspectDatabase(join(root, 'records.sqlite')), original);
  const restored = join(directory, 'old-restore');
  assert.deepEqual(await unpackBackup(backup, restored), original);
  assert.deepEqual(await readFile(join(restored, attachment.relativePath)), PNG);

  const migrated = new Store(root);
  try {
    const current = migrated.snapshot();
    assert.equal(current.schemaVersion, 3);
    assert.equal(current.runs[0].notes, '原始现场备注');
    assert.equal(current.runs[0].originalStartedAt, original.runs[0].originalStartedAt);
    assert.deepEqual(current.runs[0].snapshot, original.runs[0].snapshot);
  } finally {
    migrated.close();
  }
  assert.equal(await backupBeforeV3Migration(root, backupDirectory), null);
  assert.equal((await readdir(backupDirectory)).length, 1);
  assert.equal(await backupBeforeV3Migration(join(directory, 'new'), backupDirectory), null);
});

test('v2 migration backs up attachment bytes and preserves recorded fields before v3', async (t) => {
  const { store, directory } = fixture(t);
  const itemId = store.command({ type: 'demo' }).itemId!;
  store.command({ type: 'start', itemId });
  const run = store.snapshot().runs[0];
  store.command({ type: 'saveRun', runId: run.id, notes: '旧版记录' });
  const image = join(directory, 'image-v2.png');
  await writeFile(image, PNG);
  const attachment = await addAttachment(store, run.id, image);
  const root = store.root;
  store.close();
  makeV2(root);
  const before = inspectDatabase(join(root, 'records.sqlite'));
  const backup = await backupBeforeV3Migration(root, join(directory, 'backups'));
  assert.ok(backup);
  const restoredRoot = join(directory, 'restored-v2');
  const restored = await unpackBackup(backup, restoredRoot);
  assert.deepEqual(restored, before);
  assert.deepEqual(await readFile(join(restoredRoot, attachment.relativePath)), PNG);
  assert.deepEqual(inspectDatabase(join(root, 'records.sqlite')), before);

  const migrated = new Store(root);
  try {
    const after = migrated.snapshot();
    assert.equal(after.schemaVersion, 3);
    assert.deepEqual(after.runs[0].snapshot, before.runs[0].snapshot);
    assert.deepEqual(after.runs[0].actual, before.runs[0].actual);
    assert.deepEqual(after.runs[0].actualSample, before.runs[0].actualSample);
    assert.equal(after.runs[0].originalStartedAt, before.runs[0].originalStartedAt);
    assert.equal(after.runs[0].notes, before.runs[0].notes);
    assert.equal(after.runs[0].actualSources?.['actualSample.width'], 'legacy');
  } finally {
    migrated.close();
  }
});

test('v3 backups reject a field-note column inconsistent with the record', (t) => {
  const { store } = fixture(t);
  store.command({ type: 'demo' });
  const root = store.root;
  store.close();
  const db = new DatabaseSync(join(root, 'records.sqlite'));
  try {
    db.exec("UPDATE items SET field_note='不一致的备注' WHERE rowid=(SELECT MIN(rowid) FROM items)");
  } finally {
    db.close();
  }
  assert.throws(() => inspectDatabase(join(root, 'records.sqlite')), /数据库索引不一致/);
});

test('v1 migration backup includes committed records still in the WAL', async (t) => {
  const { store, directory } = fixture(t);
  const itemId = store.command({ type: 'demo' }).itemId!;
  store.command({ type: 'start', itemId });
  const root = store.root;
  store.close();
  makeV1(root);

  const database = join(root, 'records.sqlite');
  const writer = new DatabaseSync(database);
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    writer
      .prepare("UPDATE runs SET json=json_set(json, '$.notes', ?) WHERE item_id=?")
      .run('WAL 中已提交的备注', itemId);
    assert.ok((await stat(database + '-wal')).size > 0);
    const mainOnly = join(directory, 'main-only.sqlite');
    await copyFile(database, mainOnly);
    assert.notEqual(inspectDatabase(mainOnly).runs[0].notes, 'WAL 中已提交的备注');

    const backup = await backupBeforeV3Migration(root, join(directory, 'backups'));
    assert.ok(backup);
    const restored = await unpackBackup(backup, join(directory, 'old-restore'));
    assert.equal(restored.schemaVersion, 1);
    assert.equal(restored.runs[0].notes, 'WAL 中已提交的备注');
  } finally {
    writer.close();
  }
});

test('failed pre-migration backup leaves v1 database untouched', async (t) => {
  const { store, directory } = fixture(t);
  store.command({ type: 'demo' });
  const root = store.root;
  store.close();
  makeV1(root);
  const before = inspectDatabase(join(root, 'records.sqlite'));
  const blockingFile = join(directory, 'not-a-directory');
  await writeFile(blockingFile, 'x');
  await assert.rejects(
    backupBeforeV3Migration(root, join(blockingFile, 'backups')),
    /升级前完整备份失败，数据尚未升级/,
  );
  assert.deepEqual(inspectDatabase(join(root, 'records.sqlite')), before);
});

test('failed pre-migration backup leaves v2 database untouched', async (t) => {
  const { store, directory } = fixture(t);
  store.command({ type: 'demo' });
  const root = store.root;
  store.close();
  makeV2(root);
  const before = inspectDatabase(join(root, 'records.sqlite'));
  const blockingFile = join(directory, 'v2-not-a-directory');
  await writeFile(blockingFile, 'x');
  await assert.rejects(
    backupBeforeV3Migration(root, join(blockingFile, 'backups')),
    /升级前完整备份失败，数据尚未升级/,
  );
  assert.deepEqual(inspectDatabase(join(root, 'records.sqlite')), before);
});

test('changed attachment blocks pre-migration backup without changing v1 data', async (t) => {
  const { store, directory } = fixture(t);
  const itemId = store.command({ type: 'demo' }).itemId!;
  store.command({ type: 'start', itemId });
  const image = join(directory, 'image.png');
  await writeFile(image, PNG);
  const attachment = await addAttachment(store, store.snapshot().runs[0].id, image);
  const root = store.root;
  store.close();
  makeV1(root);
  const before = inspectDatabase(join(root, 'records.sqlite'));
  await writeFile(join(root, attachment.relativePath), 'changed');
  await assert.rejects(
    backupBeforeV3Migration(root, join(directory, 'backups')),
    /升级前完整备份失败，数据尚未升级.*附件完整性检查失败/,
  );
  assert.deepEqual(inspectDatabase(join(root, 'records.sqlite')), before);
});

test('changed attachment blocks pre-migration backup without changing v2 data', async (t) => {
  const { store, directory } = fixture(t);
  const itemId = store.command({ type: 'demo' }).itemId!;
  store.command({ type: 'start', itemId });
  const image = join(directory, 'v2-image.png');
  await writeFile(image, PNG);
  const attachment = await addAttachment(store, store.snapshot().runs[0].id, image);
  const root = store.root;
  store.close();
  makeV2(root);
  const before = inspectDatabase(join(root, 'records.sqlite'));
  await writeFile(join(root, attachment.relativePath), 'changed');
  await assert.rejects(
    backupBeforeV3Migration(root, join(directory, 'backups')),
    /升级前完整备份失败，数据尚未升级.*附件完整性检查失败/,
  );
  assert.deepEqual(inspectDatabase(join(root, 'records.sqlite')), before);
});

test('duplicate attachment paths cannot produce an unrestorable migration backup', async (t) => {
  const { store, directory } = fixture(t);
  const itemId = store.command({ type: 'demo' }).itemId!;
  store.command({ type: 'start', itemId });
  const image = join(directory, 'image.png');
  await writeFile(image, PNG);
  const attachment = await addAttachment(store, store.snapshot().runs[0].id, image);
  store.put('attachments', { ...attachment, id: randomUUID() });
  const root = store.root;
  store.close();
  makeV1(root);
  const before = inspectDatabase(join(root, 'records.sqlite'));
  await assert.rejects(
    backupBeforeV3Migration(root, join(directory, 'backups')),
    /升级前完整备份失败，数据尚未升级.*附件路径重复/,
  );
  assert.deepEqual(inspectDatabase(join(root, 'records.sqlite')), before);
});
