import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Snapshot } from '../src/shared/model.js';

const require = createRequire(import.meta.url);
let application: ElectronApplication, page: Page, directory: string;

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'labrecord-sample-entry-'));
  const env = { ...process.env, LABRECORD_TEST_MODE: '1', LABRECORD_TEST_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({
    executablePath: process.env.LABRECORD_EXECUTABLE || require('electron'),
    args: process.env.LABRECORD_EXECUTABLE ? [] : [process.cwd()],
    env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.loading-screen')).toHaveCount(0);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
  await page.getByRole('button', { name: '载入演示实验' }).click();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
});

test.afterEach(async ({}, info) => {
  if (application?.process()?.exitCode === null) {
    if (info.status !== info.expectedStatus)
      await page.screenshot({ path: info.outputPath('sample-entry-failure.png') }).catch(() => {});
    await application.close();
  }
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
    !directory.split(sep).pop()?.startsWith('labrecord-sample-entry-')
  )
    throw new Error('Unexpected sample-entry test directory');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function snapshot(): Promise<Snapshot> {
  return page.evaluate(async () => {
    const reply = await window.labrecord.snapshot();
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  });
}

async function openQuickAdd() {
  await page.getByRole('button', { name: '新增样品', exact: true }).first().click();
  return page.getByRole('dialog', { name: '添加样品' });
}

test('a clean sample form closes directly without changing records', async () => {
  const before = await snapshot();
  const dialog = await openQuickAdd();
  await dialog.getByRole('button', { name: '关闭对话框' }).click();
  await expect(dialog).toHaveCount(0);
  const after = await snapshot();
  expect(after.samples).toHaveLength(before.samples.length);
  expect(after.items).toHaveLength(before.items.length);
  expect(after.runs).toHaveLength(before.runs.length);
});

test('a changed sample form warns; Escape and continue preserve fields; discard writes nothing', async ({}, info) => {
  const before = await snapshot();
  const dialog = await openQuickAdd();
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(900, 700);
    window.webContents.setZoomFactor(1.5);
  });
  const name = dialog.getByLabel('样品统称 *', { exact: true });
  await name.fill('暂存的试样名称');
  const closeButton = dialog.getByRole('button', { name: '关闭对话框' });
  await closeButton.click();

  const prompt = dialog.getByRole('alertdialog', { name: '放弃这次样品填写？' });
  await expect(prompt).toBeVisible();
  await expect(dialog.locator('form.quick-add-form')).toBeHidden();
  await expect(prompt.getByRole('button', { name: '继续填写' })).toBeFocused();
  await expect(prompt.getByRole('button', { name: '继续填写' })).toBeInViewport();
  await expect(prompt.getByRole('button', { name: '放弃填写' })).toBeInViewport();
  const png = await application.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return image.toPNG().toString('base64');
  });
  await writeFile(
    info.outputPath('discard-confirmation-small-window.png'),
    Buffer.from(png, 'base64'),
  );
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await expect(dialog.locator('form.quick-add-form')).toBeVisible();
  await expect(name).toHaveValue('暂存的试样名称');
  await expect(closeButton).toBeFocused();

  await closeButton.click();
  await prompt.getByRole('button', { name: '继续填写' }).click();
  await expect(name).toHaveValue('暂存的试样名称');
  await expect(closeButton).toBeFocused();

  await closeButton.click();
  await prompt.getByRole('button', { name: '放弃填写' }).click();
  await expect(dialog).toHaveCount(0);
  const after = await snapshot();
  expect(after.samples).toHaveLength(before.samples.length);
  expect(after.items).toHaveLength(before.items.length);
  expect(after.runs).toHaveLength(before.runs.length);
});

test('saved parameters in continue-add count as clean when closing', async () => {
  const before = await snapshot();
  const dialog = await openQuickAdd();
  await dialog.getByLabel('样品统称 *', { exact: true }).fill('已保存的试样');
  await dialog.getByRole('button', { name: '保存并继续添加', exact: true }).click();
  await expect.poll(async () => (await snapshot()).samples.length).toBe(before.samples.length + 1);
  await expect(dialog.getByLabel('样品统称 *', { exact: true })).toHaveValue('');

  await dialog.getByRole('button', { name: '关闭对话框' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('alertdialog', { name: '放弃这次样品填写？' })).toHaveCount(0);

  const reopened = await openQuickAdd();
  const name = reopened.getByLabel('样品统称 *', { exact: true });
  await name.fill('连续添加后新填的样品');
  await reopened.getByRole('button', { name: '关闭对话框' }).click();
  const prompt = reopened.getByRole('alertdialog', { name: '放弃这次样品填写？' });
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: '继续填写' }).click();
  await expect(name).toHaveValue('连续添加后新填的样品');
  await reopened.getByRole('button', { name: '关闭对话框' }).click();
  await prompt.getByRole('button', { name: '放弃填写' }).click();
  await expect(reopened).toHaveCount(0);

  const after = await snapshot();
  expect(after.samples).toHaveLength(before.samples.length + 1);
  expect(after.items).toHaveLength(before.items.length + 1);
  expect(after.runs).toHaveLength(before.runs.length);
});

test('Ctrl+Enter ignores key repeats and IME composition then saves once', async () => {
  const before = await snapshot();
  const dialog = await openQuickAdd();
  const name = dialog.getByLabel('样品统称 *', { exact: true });
  await name.fill('键盘快捷添加');

  const prevented = await name.evaluate((input) => {
    const repeat = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    const composing = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(repeat);
    input.dispatchEvent(composing);
    return [repeat.defaultPrevented, composing.defaultPrevented];
  });
  expect(prevented).toEqual([true, true]);
  await expect(dialog.locator('form.quick-add-form')).toBeVisible();
  expect((await snapshot()).samples).toHaveLength(before.samples.length);
  await expect(name).toHaveValue('键盘快捷添加');

  await name.press('Control+Enter');
  await expect.poll(async () => (await snapshot()).samples.length).toBe(before.samples.length + 1);
  await expect(name).toHaveValue('');
  expect((await snapshot()).samples).toHaveLength(before.samples.length + 1);
  await name.fill('下一组尚未保存');
  await name.press('Escape');
  const prompt = dialog.getByRole('alertdialog', { name: '放弃这次样品填写？' });
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: '继续填写' }).click();
  await expect(name).toHaveValue('下一组尚未保存');
  expect((await snapshot()).samples).toHaveLength(before.samples.length + 1);
});
