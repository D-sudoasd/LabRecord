// Capture real packaged UI with disposable synthetic records, never the user's database.
import { _electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve('.');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const directory = await mkdtemp(join(tmpdir(), 'labrecord-readme-capture-'));
const output = join(root, `local_artifacts/release-${version}-readme/captures`);
await mkdir(output, { recursive: true });
const env = { ...process.env, LABRECORD_TEST_MODE: '1', LABRECORD_TEST_DATA: directory };
delete env.ELECTRON_RUN_AS_NODE;
let application;
try {
  application = await _electron.launch({
    executablePath: join(root, 'release/win-unpacked/LabRecord.exe'),
    args: [],
    env,
  });
  const runtime = await application.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
  }));
  if (runtime.version !== version || !runtime.packaged) throw new Error('Package version mismatch');
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1400, 940);
    window.webContents.setZoomFactor(1);
  });
  const page = await application.firstWindow();
  const snapshot = () =>
    page.evaluate(async () => {
      const reply = await window.labrecord.snapshot();
      if (!reply.ok) throw new Error(reply.error);
      return reply.data;
    });
  const command = (input) =>
    page.evaluate(async (input) => {
      const reply = await window.labrecord.command(input, crypto.randomUUID());
      if (!reply.ok) throw new Error(reply.error);
    }, input);
  const sourcesPath = join(root, 'docs/images/sources.json');
  const sources = JSON.parse(await readFile(sourcesPath, 'utf8'));
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  async function capture(name) {
    const dismiss = page.getByRole('button', { name: '关闭提示', exact: true });
    if (await dismiss.count()) await dismiss.click();
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelector('dialog .modal-body')?.scrollTo(0, 0);
    });
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    const png = Buffer.from(
      await application.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
          .toPNG()
          .toString('base64'),
      ),
      'base64',
    );
    const path = `docs/images/${name}-${version}.png`;
    await writeFile(join(root, path), png);
    await writeFile(join(output, `${name}.png`), png);
    sources.current = sources.current.filter((entry) => entry.path !== path);
    sources.current.push({
      path,
      softwareVersion: version,
      packaged: true,
      codeRevision: revision,
      capturedAtUtc: new Date().toISOString(),
      source: `local_artifacts/release-${version}-readme/captures/${name}.png`,
      captureScript: 'scripts/capture-readme.mjs',
      method: 'BrowserWindow.webContents.capturePage; no image retouching',
      selfCheckReport: 'test-results/desktop-report.json',
      sha256: createHash('sha256').update(png).digest('hex'),
      bytes: png.length,
      scope: 'Supplementary real UI capture with isolated synthetic records; not research data.',
    });
  }
  await page.getByRole('button', { name: '载入演示实验', exact: true }).click();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await capture('planning');
  const itemId = (await snapshot()).items[0].id;
  await command({ type: 'start', itemId });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: run.id,
    notes: '合成演示：此处记录现场观察与操作说明。',
  });
  await page.reload();
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await expect(page.getByRole('button', { name: '完成并切换下一项', exact: true })).toBeVisible();
  await capture('live');
  await command({ type: 'finish', itemId });
  await page.reload();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await capture('review');
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await page.getByRole('button', { name: '新增样品', exact: true }).first().click();
  const modal = page.getByRole('dialog', { name: '添加样品', exact: true });
  await modal.getByLabel('样品统称 *', { exact: true }).fill('Ti2448 演示试样');
  await modal.getByLabel('准备数量', { exact: true }).fill('6');
  await modal.getByLabel('计划测试数量', { exact: true }).fill('4');
  await modal.getByLabel('厚度', { exact: true }).fill('0.8');
  await modal.getByLabel('宽度', { exact: true }).fill('3.0');
  await capture('quick-add');
  sources.description = `Real Electron screenshots with synthetic experiments and isolated temporary data. README uses versioned planning/live/review/quick-add images from the final packaged ${version}. All other images retain their recorded versions. Software verification does not constitute scientific acceptance.`;
  await writeFile(sourcesPath, JSON.stringify(sources, null, 2) + '\n');
  console.log(`Captured four real ${version} screens without toast overlays or user records.`);
} finally {
  if (application) await application.close();
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
    !directory.split(sep).pop().startsWith('labrecord-readme-capture-')
  )
    throw new Error('Unexpected capture directory');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
