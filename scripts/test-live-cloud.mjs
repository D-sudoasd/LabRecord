import { _electron, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

// Explicit live validation against the selected private repository. Never run as part of ordinary tests.
const repository = process.argv[2];
if (!repository || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository))
  throw new Error('Usage: node scripts/test-live-cloud.mjs owner/private-repository');
const root = process.cwd(),
  prefix = 'validation-' + randomUUID();
const directory = await mkdtemp(join(tmpdir(), 'labrecord-cloud-'));
const native = promisify(execFile),
  require = createRequire(import.meta.url);
let application,
  page,
  validated = false;
const stages = [];
async function launch(name) {
  const env = {
    ...process.env,
    LABRECORD_TEST_MODE: '1',
    LABRECORD_TEST_DATA: join(directory, name),
    LABRECORD_TEST_SYNC_PREFIX: prefix,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LABRECORD_EXECUTABLE || require('electron');
  application = await _electron.launch({
    executablePath,
    args: process.env.LABRECORD_EXECUTABLE ? [] : [root],
    env,
  });
  page = await application.firstWindow();
  await page.waitForSelector('.app-header');
}
async function call(method, ...args) {
  const reply = await page.evaluate(async ({ method, args }) => window.labrecord[method](...args), {
    method,
    args,
  });
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}
const command = (value) => call('command', value, randomUUID());
let encryptedTokenVerified = false;
async function connect(manual = false) {
  const token = manual
    ? (
        await native('gh', ['auth', 'token', '--hostname', 'github.com'], { windowsHide: true })
      ).stdout.trim()
    : undefined;
  const info = await call('cloudConnect', {
    repository,
    create: false,
    ...(token ? { token } : {}),
  });
  assert.equal(info.connected, true);
  if (manual) {
    assert.ok(token, 'GitHub CLI credentials required for this explicit live check');
    const saved = await readFile(join(directory, 'computer-b', 'cloud-credentials.json'), 'utf8');
    assert.equal(JSON.parse(saved).source, 'encrypted-token');
    assert.ok(!saved.includes(token), 'plaintext credentials must not be saved');
    encryptedTokenVerified = await application.evaluate(
      ({ safeStorage }, input) =>
        safeStorage.isEncryptionAvailable() &&
        safeStorage.decryptString(Buffer.from(input.encryptedToken, 'base64')) === input.token,
      { encryptedToken: JSON.parse(saved).encryptedToken, token },
    );
    assert.ok(encryptedTokenVerified);
  }
}
async function stop() {
  await application.close();
  application = null;
}
try {
  await launch('computer-a');
  const runtime = await application.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
  }));
  assert.equal(
    runtime.version,
    JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version,
  );
  await command({ type: 'demo' });
  let snapshot = await call('snapshot');
  await command({
    type: 'updateGroups',
    ids: [snapshot.groups[0].id],
    patch: { name: '同步验收试样', width: '3.1', dimensionUnit: 'mm' },
  });
  await command({ type: 'start', itemId: snapshot.items[0].id });
  snapshot = await call('snapshot');
  const image = join(directory, 'cloud-test.png');
  const imageBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=',
    'base64',
  );
  await writeFile(image, imageBytes);
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, image);
  await call('addAttachment', snapshot.runs[0].id);
  await command({ type: 'finish', itemId: snapshot.items[0].id });
  await connect();
  await page.reload();
  await page.getByRole('button', { name: '云同步', exact: true }).click();
  await page.getByRole('button', { name: '同步实验记录', exact: true }).click();
  await expect(page.getByRole('button', { name: '关闭对话框', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.locator('.toast')).toContainText('已上传', { timeout: 120000 });
  assert.ok((await call('cloudStatus')).lastSyncedAt);
  stages.push('uploaded');
  await page.keyboard.press('Escape');
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, directory);
  const exported = await call('exportReport', snapshot.experiments[0].id);
  assert.equal(exported.archiveState, 'pending');
  const reportDeadline = Date.now() + 180000;
  while (true) {
    const job = (await call('reportJobs')).find((job) => job.id === exported.archiveId);
    if (job?.state === 'failed') throw new Error(job.error);
    if (job?.state === 'uploaded') break;
    if (Date.now() > reportDeadline) throw new Error('report upload timed out');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  stages.push('report-archived');
  let result;
  await stop();
  await launch('computer-b');
  await connect(true);
  result = await call('cloudSync');
  assert.equal(result.action, 'downloaded');
  stages.push(result.action);
  snapshot = await call('snapshot');
  assert.equal(snapshot.groups[0].name, '同步验收试样');
  assert.equal(snapshot.groups[0].width, '3.1');
  assert.equal(snapshot.attachments.length, 1);
  const attachment = snapshot.attachments[0];
  assert.deepEqual(
    await readFile(join(directory, 'computer-b/workspace', attachment.relativePath)),
    imageBytes,
  );
  assert.equal(attachment.sha256, createHash('sha256').update(imageBytes).digest('hex'));
  const reports = await call('cloudReports');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].id, exported.archiveId);
  await application.evaluate(({ dialog, shell }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    shell.showItemInFolder = () => {};
  }, directory);
  const downloaded = await call('downloadCloudReport', exported.archiveId);
  const reportManifest = JSON.parse(
    await readFile(join(exported.localPath, 'manifest.json'), 'utf8'),
  );
  for (const file of reportManifest.files)
    assert.deepEqual(
      await readFile(join(downloaded, file.path)),
      await readFile(join(exported.localPath, file.path)),
    );
  assert.ok(JSON.parse(await readFile(join(downloaded, 'records.json'), 'utf8')).runs[0].endedAt);
  stages.push('report-downloaded-verified');
  await command({
    type: 'saveRun',
    runId: snapshot.runs[0].id,
    notes: '电脑 B 补充现场记录',
    actualSample: { width: '3.05' },
  });
  result = await call('cloudSync');
  assert.equal(result.action, 'uploaded');
  stages.push(result.action);
  await stop();
  await launch('computer-a');
  result = await call('cloudSync');
  assert.equal(result.action, 'downloaded');
  stages.push(result.action);
  snapshot = await call('snapshot');
  assert.equal(snapshot.runs[0].notes, '电脑 B 补充现场记录');
  assert.equal(snapshot.runs[0].actualSample.width, '3.05');
  assert.ok(
    (await readdir(join(directory, 'computer-a/backups'))).some((name) =>
      name.startsWith('before-cloud-'),
    ),
  );
  assert.equal((await call('cloudSync')).action, 'unchanged');
  stages.push('unchanged');
  await command({ type: 'saveRun', runId: snapshot.runs[0].id, notes: '电脑 A 独立修改' });
  await stop();
  await launch('computer-b');
  await command({ type: 'saveRun', runId: snapshot.runs[0].id, notes: '电脑 B 独立修改' });
  await call('cloudSync');
  await stop();
  await launch('computer-a');
  result = await call('cloudSync');
  assert.equal(result.action, 'conflict');
  stages.push('conflict');
  assert.equal((await call('snapshot')).runs[0].notes, '电脑 A 独立修改');
  await stop();
  const info = JSON.parse(
    (
      await native(
        'gh',
        ['api', `repos/${repository}`, '--jq', '{private:.private,default_branch:.default_branch}'],
        { windowsHide: true },
      )
    ).stdout,
  );
  assert.equal(info.private, true);
  await mkdir(join(root, 'local_artifacts'), { recursive: true });
  const evidence = {
    checkedAt: new Date().toISOString(),
    repository,
    private: info.private,
    runtime,
    profiles: 2,
    stages,
    imageBytesVerified: true,
    localBackupVerified: true,
    conflictPreservedBoth: true,
    encryptedTokenVerified,
    isolatedRemotePrefix: prefix,
  };
  await writeFile(
    join(root, 'local_artifacts/cloud-validation.json'),
    JSON.stringify(evidence, null, 2),
  );
  const publicEvidence = {
    ...evidence,
    repository: '(private repository)',
    runtime: { ...runtime, appPath: '(packaged application)' },
    isolatedRemotePrefix: '(isolated synthetic test directory)',
  };
  await writeFile(
    join(root, 'docs/cloud-validation.json'),
    JSON.stringify(publicEvidence, null, 2) + '\n',
  );
  console.log(JSON.stringify(publicEvidence, null, 2));
  validated = true;
} finally {
  if (application) await application.close();
  if (validated) {
    const listDirectory = async (path) => {
      if (!path.startsWith(prefix)) throw new Error('Unexpected validation prefix');
      const result = await native(
        'gh',
        [
          'api',
          `repos/${repository}/contents/${path}`,
          '--jq',
          '.[]|{path:.path,sha:.sha,type:.type}',
        ],
        { windowsHide: true },
      );
      const entries = result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse),
        files = [];
      for (const entry of entries) {
        if (entry.type === 'dir') {
          files.push(...(await listDirectory(entry.path)));
        } else files.push(entry);
      }
      return files;
    };
    const files = await listDirectory(prefix);
    for (const file of files) {
      if (!file.path.startsWith(prefix + '/') || file.type !== 'file')
        throw new Error('Unexpected remote validation file');
      await native(
        'gh',
        [
          'api',
          '--method',
          'DELETE',
          `repos/${repository}/contents/${file.path}`,
          '-f',
          'message=LabRecord: clean isolated synthetic validation files',
          '-f',
          `sha=${file.sha}`,
        ],
        { windowsHide: true, maxBuffer: 1048576 },
      );
    }
    console.log(
      'Isolated synthetic validation files removed from the repository working tree; its history remains recoverable.',
    );
  }
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
    !directory.split(sep).pop()?.startsWith('labrecord-cloud-')
  )
    throw new Error('Unexpected validation directory');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
