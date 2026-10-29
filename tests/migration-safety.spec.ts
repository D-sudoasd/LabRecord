import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Store } from '../src/desktop/store.js';
import { addAttachment, backupBeforeV3Migration, unpackBackup } from '../src/desktop/backups.js';
import { PNG } from './helpers.js';

const require = createRequire(import.meta.url);

for (const version of [1, 2] as const) {
  test(`opening a v${version} workspace saves a complete old-version backup before migration`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'labrecord-migration-ui-'));
    const root = join(directory, 'workspace');
    let application: ElectronApplication | undefined;
    try {
      const store = new Store(root);
      let attachmentPath = '';
      let originalStartedAt: string | null = null;
      try {
        const itemId = store.command({ type: 'demo' }).itemId!;
        store.command({ type: 'start', itemId });
        const run = store.snapshot().runs[0];
        originalStartedAt = run.originalStartedAt;
        store.command({ type: 'saveRun', runId: run.id, notes: '原有现场备注' });
        const image = join(directory, 'image.png');
        await writeFile(image, PNG);
        attachmentPath = (await addAttachment(store, run.id, image)).relativePath;
      } finally {
        store.close();
      }
      const db = new DatabaseSync(join(root, 'records.sqlite'));
      try {
        db.exec("BEGIN IMMEDIATE; UPDATE runs SET json=json_remove(json, '$.actualSources');");
        if (version === 1)
          db.exec(`UPDATE runs SET json=json_remove(json, '$.actualSample.state', '$.actualSample.specimenName');
          UPDATE items SET json=json_remove(json, '$.fieldNote');
          ALTER TABLE items DROP COLUMN field_note;`);
        db.exec(`PRAGMA user_version=${version}; COMMIT;`);
      } finally {
        db.close();
      }

      const env = { ...process.env, LABRECORD_TEST_MODE: '1', LABRECORD_TEST_DATA: directory };
      delete env.ELECTRON_RUN_AS_NODE;
      application = await _electron.launch({
        executablePath: process.env.LABRECORD_EXECUTABLE || require('electron'),
        args: process.env.LABRECORD_EXECUTABLE ? [] : [process.cwd()],
        env,
      });
      const page = await application.firstWindow();
      await expect(page.locator('.loading-screen')).toHaveCount(0);
      const current = await page.evaluate(async () => {
        const reply = await window.labrecord.snapshot();
        if (!reply.ok) throw new Error(reply.error);
        return reply.data;
      });
      expect(current.schemaVersion).toBe(3);
      expect(current.runs[0].notes).toBe('原有现场备注');
      expect(current.runs[0].originalStartedAt).toBe(originalStartedAt);
      const backupDirectory = join(directory, 'backups');
      const backups = (await readdir(backupDirectory)).filter((name) =>
        /^before-v3-.*\.labrecord$/.test(name),
      );
      expect(backups).toHaveLength(1);
      const restored = join(directory, 'restored-old-backup');
      const old = await unpackBackup(join(backupDirectory, backups[0]), restored);
      expect(old.schemaVersion).toBe(version);
      expect(old.runs[0].notes).toBe('原有现场备注');
      expect(old.runs[0].originalStartedAt).toBe(originalStartedAt);
      expect(await readFile(join(restored, attachmentPath))).toEqual(PNG);
    } finally {
      if (application?.process()?.exitCode === null) await application.close();
      if (
        !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
        !directory.split(sep).pop()?.startsWith('labrecord-migration-ui-')
      )
        throw new Error('Unexpected migration test directory');
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
}

test('restoring a v2 backup migrates the staging copy and preserves the current workspace backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'labrecord-migration-ui-'));
  const source = join(directory, 'old-workspace');
  const device = join(directory, 'device');
  let application: ElectronApplication | undefined;
  try {
    const oldStore = new Store(source);
    let attachmentPath = '';
    try {
      const itemId = oldStore.command({ type: 'demo' }).itemId!;
      oldStore.command({ type: 'start', itemId });
      const run = oldStore.snapshot().runs[0];
      oldStore.command({ type: 'saveRun', runId: run.id, notes: '恢复前旧版现场备注' });
      const image = join(directory, 'old-image.png');
      await writeFile(image, PNG);
      attachmentPath = (await addAttachment(oldStore, run.id, image)).relativePath;
    } finally {
      oldStore.close();
    }
    const db = new DatabaseSync(join(source, 'records.sqlite'));
    try {
      db.exec(
        "BEGIN IMMEDIATE; UPDATE runs SET json=json_remove(json, '$.actualSources'); PRAGMA user_version=2; COMMIT;",
      );
    } finally {
      db.close();
    }
    const incoming = await backupBeforeV3Migration(source, join(directory, 'old-backups'));
    expect(incoming).toBeTruthy();
    const env = { ...process.env, LABRECORD_TEST_MODE: '1', LABRECORD_TEST_DATA: device };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({
      executablePath: process.env.LABRECORD_EXECUTABLE || require('electron'),
      args: process.env.LABRECORD_EXECUTABLE ? [] : [process.cwd()],
      env,
    });
    const page = await application.firstWindow();
    await expect(page.locator('.loading-screen')).toHaveCount(0);
    const before = await page.evaluate(async () => {
      const created = await window.labrecord.command(
        { type: 'createExperiment', code: 'LOCAL', name: '本机原实验' },
        crypto.randomUUID(),
      );
      if (!created.ok) throw new Error(created.error);
      const snapshot = await window.labrecord.snapshot();
      if (!snapshot.ok) throw new Error(snapshot.error);
      return snapshot.data;
    });
    await application.evaluate(({ dialog }, incomingPath) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [incomingPath],
      })) as typeof dialog.showOpenDialog;
      dialog.showMessageBox = (async () => ({
        response: 0,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
    }, incoming!);
    const reply = await page.evaluate(() => window.labrecord.restore());
    expect(reply.ok).toBe(true);
    if (!reply.ok || !reply.data) throw new Error('恢复未返回实验数据');
    expect(reply.data.schemaVersion).toBe(3);
    expect(reply.data.runs[0].notes).toBe('恢复前旧版现场备注');
    expect(reply.data.runs[0].actualSources?.['actualSample.width']).toBe('legacy');
    expect(await readFile(join(device, 'workspace', attachmentPath))).toEqual(PNG);
    const backups = await readdir(join(device, 'backups'));
    const previous = backups.find((name) => name.startsWith('before-restore-'));
    const migrated = backups.find((name) => name.startsWith('before-v3-'));
    expect(previous).toBeTruthy();
    expect(migrated).toBeTruthy();
    expect(
      await unpackBackup(join(device, 'backups', previous!), join(directory, 'previous')),
    ).toEqual(before);
    const old = await unpackBackup(join(device, 'backups', migrated!), join(directory, 'old-copy'));
    expect(old.schemaVersion).toBe(2);
    expect(await readFile(join(directory, 'old-copy', attachmentPath))).toEqual(PNG);
  } finally {
    if (application?.process()?.exitCode === null) await application.close();
    if (
      !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
      !directory.split(sep).pop()?.startsWith('labrecord-migration-ui-')
    )
      throw new Error('Unexpected migration test directory');
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
