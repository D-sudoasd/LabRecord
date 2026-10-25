import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Snapshot } from '../src/shared/model.js';

const require = createRequire(import.meta.url);
let application: ElectronApplication, page: Page, directory: string;

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'labrecord-experiment-entry-'));
  const env = { ...process.env, LABRECORD_TEST_MODE: '1', LABRECORD_TEST_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({
    executablePath: process.env.LABRECORD_EXECUTABLE || require('electron'),
    args: process.env.LABRECORD_EXECUTABLE ? [] : [process.cwd()],
    env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.loading-screen')).toHaveCount(0);
});

test.afterEach(async ({}, info) => {
  if (application?.process()?.exitCode === null) {
    if (info.status !== info.expectedStatus)
      await page.screenshot({ path: info.outputPath('failure.png') }).catch(() => {});
    await application.close();
  }
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
    !directory.split(sep).pop()?.startsWith('labrecord-experiment-entry-')
  )
    throw new Error('Unexpected test directory');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function snapshot(): Promise<Snapshot> {
  return page.evaluate(async () => {
    const reply = await window.labrecord.snapshot();
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  });
}

test('same-day codes suggest the next available ID and explain duplicates before saving', async () => {
  await page.getByRole('button', { name: '新建第一个实验', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建实验' });
  const name = dialog.getByLabel('实验名称 *', { exact: true });
  const code = dialog.getByLabel(/实验编号/);
  const base = await code.inputValue();
  expect(base).toMatch(/^EXP-\d{8}$/);
  await name.fill('第一个实验');
  await dialog.getByRole('button', { name: '创建实验', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole('button', { name: '新建实验', exact: true }).click();
  const next = page.getByRole('dialog', { name: '新建实验' });
  const nextCode = next.getByLabel(/实验编号/);
  await expect(nextCode).toHaveValue(`${base}-02`);
  await next.getByLabel('实验名称 *', { exact: true }).fill('第二个实验');
  await nextCode.fill(base);
  await expect(next.locator('.field-error')).toHaveText('实验编号已经存在，请换一个编号。');
  await next.getByRole('button', { name: '创建实验', exact: true }).click();
  await expect(next.getByRole('alert')).toContainText('实验编号已经存在');
  expect((await snapshot()).experiments).toHaveLength(1);

  await nextCode.fill(`${base}-02`);
  await next.getByRole('button', { name: '创建实验', exact: true }).click();
  await expect(next).toHaveCount(0);
  const saved = await snapshot();
  expect(saved.experiments.map((experiment) => experiment.code).sort()).toEqual(
    [`${base}-02`, base].sort(),
  );
  expect(saved.runs).toHaveLength(0);

  await page.getByRole('button', { name: '新建实验', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '新建实验' }).getByLabel(/实验编号/)).toHaveValue(
    `${base}-03`,
  );
});
