import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import {
  addAttachment,
  createBackup,
  unpackBackup,
  inspectDatabase,
  dailyBackup,
} from '../src/desktop/backups.js';
import { Store } from '../src/desktop/store.js';
import { fixture, PNG } from './helpers.js';

test('complete backup restores open operation, history and attachment bytes with verified SHA', async (t) => {
  const { store, directory } = fixture(t);
  const { itemId } = store.command({ type: 'demo' });
  store.command({ type: 'start', itemId });
  const run = store.snapshot().runs[0];
  store.command({ type: 'saveRun', runId: run.id, notes: '等待下次继续' });
  const picture = join(directory, '现场图片.png');
  await writeFile(picture, PNG);
  const attachment = await addAttachment(store, run.id, picture);
  const path = join(directory, 'complete.labrecord');
  await createBackup(store, path);
  const restored = join(directory, 'restored');
  assert.deepEqual(await unpackBackup(path, restored), store.snapshot());
  assert.deepEqual(await readFile(join(restored, attachment.relativePath)), PNG);
  const reopened = new Store(restored);
  assert.equal(reopened.snapshot().runs[0].endedAt, null);
  assert.equal(reopened.snapshot().items[0].status, 'running');
  reopened.close();
  assert.deepEqual(inspectDatabase(join(restored, 'records.sqlite')), store.snapshot());
});

test('damaged archive and missing/changed attachments are rejected; current records remain untouched', async (t) => {
  const { store, directory } = fixture(t);
  const { itemId } = store.command({ type: 'demo' });
  store.command({ type: 'start', itemId });
  const image = join(directory, 'image.png');
  await writeFile(image, PNG);
  const attachment = await addAttachment(store, store.snapshot().runs[0].id, image);
  const path = join(directory, 'good.labrecord');
  await createBackup(store, path);
  const before = store.snapshot();
  const archive = await JSZip.loadAsync(await readFile(path));
  archive.file('records.sqlite', 'corrupted');
  const invalid = join(directory, 'corrupt.labrecord');
  await writeFile(invalid, await archive.generateAsync({ type: 'nodebuffer' }));
  await assert.rejects(unpackBackup(invalid, join(directory, 'bad-restore')), /校验失败/);
  assert.deepEqual(store.snapshot(), before);
  await writeFile(join(store.root, attachment.relativePath), 'changed');
  await assert.rejects(createBackup(store, join(directory, 'invalid.labrecord')), /附件完整性/);
});

test('unlisted and traversing archive paths are rejected', async (t) => {
  const { store, directory } = fixture(t);
  store.command({ type: 'demo' });
  const path = join(directory, 'good.labrecord');
  await createBackup(store, path);
  const archive = await JSZip.loadAsync(await readFile(path));
  archive.file('unlisted.txt', 'bad');
  const invalid = join(directory, 'extra.labrecord');
  await writeFile(invalid, await archive.generateAsync({ type: 'nodebuffer' }));
  await assert.rejects(unpackBackup(invalid, join(directory, 'extra-restore')), /清单之外/);
  archive.remove('unlisted.txt');
  const manifest = JSON.parse(await archive.file('manifest.json')!.async('string'));
  manifest.files[0].name = '../records.sqlite';
  archive.file('manifest.json', JSON.stringify(manifest));
  await writeFile(invalid, await archive.generateAsync({ type: 'nodebuffer' }));
  await assert.rejects(unpackBackup(invalid, join(directory, 'traverse-restore')), /无效文件/);
});

test('automatic backup retains 10 daily copies and never removes manual backups', async (t) => {
  const { store, directory } = fixture(t);
  store.command({ type: 'demo' });
  const target = join(directory, 'backups');
  await mkdir(target);
  for (let day = 1; day <= 11; day++)
    await writeFile(
      join(target, `auto-2025-01-${String(day).padStart(2, '0')}.labrecord`),
      'older fixture',
    );
  await writeFile(join(target, 'manual.labrecord'), 'manual fixture');
  await dailyBackup(store, target);
  const names = await readdir(target);
  assert.equal(names.filter((n) => n.startsWith('auto-')).length, 10);
  assert.ok(names.includes('manual.labrecord'));
  assert.ok(!names.includes('auto-2025-01-01.labrecord'));
});
