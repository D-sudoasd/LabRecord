import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Snapshot } from '../src/shared/model.js';

const require = createRequire(import.meta.url);
let application: ElectronApplication;
let page: Page;
let directory: string;

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'labrecord-more-info-'));
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

test.afterEach(async () => {
  if (application?.process()?.exitCode === null) await application.close();
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
    !directory.split(sep).pop()?.startsWith('labrecord-more-info-')
  )
    throw new Error('Unexpected more-info test directory');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function snapshot(): Promise<Snapshot> {
  return page.evaluate(async () => {
    const result = await window.labrecord.snapshot();
    if (!result.ok) throw new Error(result.error);
    return result.data;
  });
}

test('more specimen information keeps the main row simple and preserves inherited fields', async () => {
  const before = await snapshot();
  const sample = before.samples.find((entry) => entry.code === 'TA-01')!;
  const row = page
    .getByRole('region', { name: '现场规划表' })
    .getByRole('row')
    .filter({ has: page.getByRole('textbox', { name: 'TA-01 原始编号或名称' }) });
  await row.getByText('更多', { exact: true }).click();
  await row.getByRole('button', { name: '更多样品信息 TA-01', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '更多样品信息', exact: true });
  await expect(dialog.getByLabel('实物样品母码', { exact: true })).toHaveValue('TA-01');
  await expect(dialog.getByText('这一件的实验制度', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('原始编号或名称', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('宽度', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('温度', { exact: true })).toHaveValue('25');
  await dialog.getByLabel('加工工艺', { exact: true }).fill('现场前加工');
  await dialog.getByRole('button', { name: '保存更多信息', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const after = (await snapshot()).samples.find((entry) => entry.id === sample.id)!;
  expect(after.parameters).toEqual({ ...sample.parameters, processing: '现场前加工' });
  expect(after.values).toEqual(sample.values);
});

test('switching to spare-only cannot silently discard an entered measurement note', async () => {
  const before = await snapshot();
  await page.getByRole('button', { name: '新增样品', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加样品', exact: true });
  await dialog.getByLabel('样品统称 *', { exact: true }).fill('备样边界');
  const name = dialog.getByRole('textbox', { name: /原始编号或名称$/ });
  const note = dialog.getByRole('textbox', { name: /本次测量备注$/ });
  await name.fill('原始编号');
  await note.fill('先保留这条现场备注');
  await dialog.getByText('批量添加或设置备样', { exact: true }).click();
  const count = dialog.getByLabel('计划测试数量', { exact: true });
  await count.fill('0');
  await dialog.getByRole('button', { name: '添加为备样', exact: true }).click();
  const warning = dialog.getByRole('alertdialog', { name: '有已填写的样品被数量缩减隐藏' });
  await expect(warning).toContainText('1 件隐藏样品');
  await warning.getByRole('button', { name: '返回检查', exact: true }).click();
  await count.fill('1');
  await expect(name).toHaveValue('原始编号');
  await expect(note).toHaveValue('先保留这条现场备注');
  await dialog.getByRole('button', { name: '关闭对话框' }).click();
  await dialog.getByRole('alertdialog').getByRole('button', { name: '放弃填写' }).click();
  await expect(dialog).toHaveCount(0);
  const after = await snapshot();
  expect(after.samples).toEqual(before.samples);
  expect(after.items).toEqual(before.items);
  expect(after.runs).toEqual(before.runs);
});
