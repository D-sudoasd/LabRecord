import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const require = createRequire(import.meta.url);

async function launch(directory: string) {
  const env = { ...process.env, LABRECORD_TEST_MODE: '1', LABRECORD_TEST_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({
    executablePath: process.env.LABRECORD_EXECUTABLE || require('electron'),
    args: process.env.LABRECORD_EXECUTABLE ? [] : [process.cwd()],
    env,
  });
  const page = await application.firstWindow();
  await expect(page.locator('.loading-screen')).toHaveCount(0);
  await expect(page.locator('.app-header')).toBeVisible();
  return { application, page };
}

let directory: string, application: ElectronApplication, page: Page;

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'labrecord-home-'));
  ({ application, page } = await launch(directory));
});

test.afterEach(async () => {
  if (application?.process()?.exitCode === null) await application.close();
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
    !directory.split(sep).pop()?.startsWith('labrecord-home-')
  )
    throw new Error('Unexpected test directory');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('demo experiment can return to the start page and reopen', async () => {
  await page.getByRole('button', { name: '载入演示实验' }).click();
  await expect(page.getByRole('heading', { name: '实验规划' })).toBeVisible();
  await page.getByRole('button', { name: '开始页', exact: true }).click();
  await expect(page.getByRole('heading', { name: '开始页' })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开实验 同步辐射实验 · 演示' })).toBeVisible();
  await page.getByLabel('选择实验').selectOption({ label: '开始页' });
  await expect(page.getByRole('heading', { name: '开始页' })).toBeVisible();
  await page.getByRole('button', { name: '打开实验 同步辐射实验 · 演示' }).click();
  await expect(page.getByRole('heading', { name: '实验规划' })).toBeVisible();
  await page.getByRole('button', { name: '全库搜索' }).click();
  await page.getByRole('button', { name: '回到开始页' }).click();
  await expect(page.getByRole('heading', { name: '开始页' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
