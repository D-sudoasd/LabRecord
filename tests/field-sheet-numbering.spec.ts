import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const require = createRequire(import.meta.url);
let application: ElectronApplication;
let page: Page;
let directory: string;

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'labrecord-numbering-'));
  const env = { ...process.env, LABRECORD_TEST_MODE: '1', LABRECORD_TEST_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({
    executablePath: process.env.LABRECORD_EXECUTABLE || require('electron'),
    args: process.env.LABRECORD_EXECUTABLE ? [] : [process.cwd()],
    env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.loading-screen')).toHaveCount(0);
  await expect(page.locator('.app-header')).toBeVisible();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
});

test.afterEach(async () => {
  if (application?.process()?.exitCode === null) await application.close();
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
    !directory.split(sep).pop()?.startsWith('labrecord-numbering-')
  )
    throw new Error('Unexpected numbering test directory');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('numbering selection follows the saved pattern after rejection or a lost reply', async () => {
  await page.getByRole('button', { name: '新建第一个实验', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建实验', exact: true });
  await create.getByLabel('实验名称 *', { exact: true }).fill('编号保存验收');
  await create.getByLabel('实验编号 *').fill('NUMBERING-1');
  await create.getByRole('button', { name: '创建实验', exact: true }).click();
  await expect(create).toHaveCount(0);
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const sheet = page.getByRole('region', { name: '现场规划表', exact: true });
  await sheet.getByText('编号格式', { exact: true }).click();
  const select = sheet.getByLabel('新样品编号格式', { exact: true });
  await expect(select).toHaveValue('hyphen');

  await application.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as any)._invokeHandlers as Map<string, (...args: any[]) => any>;
    const original = handlers.get('command');
    if (!original) throw new Error('Original command handler unavailable');
    const control: {
      mode: 'delayReject' | 'pass' | 'lostReply';
      calls: number;
      release?: () => void;
    } = { mode: 'delayReject', calls: 0 };
    (globalThis as any).numberingTest = control;
    ipcMain.removeHandler('command');
    ipcMain.handle('command', async (...args) => {
      const command = args[1];
      if (command?.type === 'updateExperiment' && 'sampleCodePattern' in command) {
        control.calls += 1;
        if (control.mode === 'delayReject') {
          await new Promise<void>((release) => {
            control.release = release;
          });
          return { ok: false, error: '测试模拟：编号保存失败', rejected: true };
        }
        if (control.mode === 'lostReply') {
          const reply = await original(...args);
          return reply?.ok ? { ok: false, error: '测试模拟：保存回复丢失' } : reply;
        }
      }
      return original(...args);
    });
  });

  await select.selectOption('pad');
  await expect(select).toBeDisabled();
  await expect
    .poll(() => application.evaluate(() => (globalThis as any).numberingTest.calls))
    .toBe(1);
  await application.evaluate(() => (globalThis as any).numberingTest.release());
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue('hyphen');
  await expect(sheet.getByRole('alert')).toContainText('测试模拟：编号保存失败');

  await application.evaluate(() => {
    (globalThis as any).numberingTest.mode = 'pass';
  });
  await select.selectOption('pad');
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue('pad');
  await expect(sheet.getByRole('alert')).toHaveCount(0);
  // The legacy padded format is represented by an absent optional property.
  expect(
    await page.evaluate(async () => {
      const reply = await window.labrecord.snapshot();
      if (!reply.ok) throw new Error(reply.error);
      return reply.data.experiments[0].sampleCodePattern;
    }),
  ).toBeUndefined();

  await application.evaluate(() => {
    (globalThis as any).numberingTest.mode = 'lostReply';
  });
  await select.selectOption('hyphen');
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue('hyphen');
  await expect(sheet.getByRole('alert')).toContainText('测试模拟：保存回复丢失');
  expect(
    await page.evaluate(async () => {
      const reply = await window.labrecord.snapshot();
      if (!reply.ok) throw new Error(reply.error);
      return reply.data.experiments[0].sampleCodePattern;
    }),
  ).toBe('{prefix}-{n}');

  await application.evaluate(() => {
    (globalThis as any).numberingTest.mode = 'delayReject';
  });
  await select.selectOption('custom');
  const custom = sheet.getByLabel('自定义编号格式', { exact: true });
  await custom.fill('{prefix}_X{n:02}');
  await sheet.getByRole('button', { name: '使用此格式', exact: true }).click();
  await expect(select).toBeDisabled();
  await expect(custom).toBeDisabled();
  await expect
    .poll(() => application.evaluate(() => (globalThis as any).numberingTest.calls))
    .toBe(4);
  await application.evaluate(() => (globalThis as any).numberingTest.release());
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue('hyphen');
  await expect(sheet.getByRole('alert')).toContainText('测试模拟：编号保存失败');
  await select.selectOption('custom');
  await expect(custom).toHaveValue('{prefix}_X{n:02}');
});
