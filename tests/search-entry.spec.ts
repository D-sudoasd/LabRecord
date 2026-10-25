import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Snapshot } from '../src/shared/model.js';

const require = createRequire(import.meta.url);
let application: ElectronApplication, page: Page, directory: string;

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'labrecord-search-entry-'));
  const env = { ...process.env, LABRECORD_TEST_MODE: '1', LABRECORD_TEST_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({
    executablePath: process.env.LABRECORD_EXECUTABLE || require('electron'),
    args: process.env.LABRECORD_EXECUTABLE ? [] : [process.cwd()],
    env,
  });
  page = await application.firstWindow();
  await page.getByRole('button', { name: '载入演示实验', exact: true }).click();
});

test.afterEach(async ({}, info) => {
  if (application?.process()?.exitCode === null) {
    if (info.status !== info.expectedStatus)
      await page.screenshot({ path: info.outputPath('failure.png') }).catch(() => {});
    await application.close();
  }
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
    !directory.split(sep).pop()?.startsWith('labrecord-search-entry-')
  )
    throw new Error('Unexpected search entry test directory');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function snapshot(): Promise<Snapshot> {
  return page.evaluate(async () => {
    const reply = await window.labrecord.snapshot();
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  });
}

test('clearing a failed global search restores experiments, focus and keyboard navigation without writing records', async () => {
  const before = await snapshot();
  await page.getByRole('button', { name: '全库搜索', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '全库搜索' });
  const input = dialog.getByRole('combobox', { name: '全库搜索' });
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(input).toHaveAttribute('aria-controls', 'workspace-results');
  await expect(dialog.getByRole('button', { name: '清除全库搜索' })).toHaveCount(0);
  await input.fill('没有这份实验-EMPTY-SEARCH');
  await expect(dialog.getByRole('status')).toContainText('没有匹配');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await expect(input).not.toHaveAttribute('aria-controls');
  await expect(input).not.toHaveAttribute('aria-activedescendant');

  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(900, 700);
    window.webContents.setZoomFactor(1.5);
  });
  const clear = dialog.getByRole('button', { name: '清除全库搜索', exact: true });
  await expect(clear).toBeInViewport();
  await clear.click();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(input).toHaveAttribute('aria-activedescendant', 'workspace-hit-0');
  await expect(dialog.getByRole('listbox', { name: '实验库' })).toBeVisible();
  await input.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-activedescendant', 'workspace-hit-1');
  await input.press('ArrowUp');
  await expect(input).toHaveAttribute('aria-activedescendant', 'workspace-hit-0');
  await input.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.plan-page')).toBeVisible();
  const after = await snapshot();
  expect(after.experiments).toEqual(before.experiments);
  expect(after.items).toEqual(before.items);
  expect(after.runs).toEqual(before.runs);
  expect(after.events).toEqual(before.events);
});
