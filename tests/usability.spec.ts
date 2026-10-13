import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Command, Snapshot } from '../src/shared/model.js';

const require = createRequire(import.meta.url);
let application: ElectronApplication, page: Page, directory: string;
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'labrecord-usability-'));
  const env = { ...process.env, LABRECORD_TEST_MODE: '1', LABRECORD_TEST_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({
    executablePath: process.env.LABRECORD_EXECUTABLE || require('electron'),
    args: process.env.LABRECORD_EXECUTABLE ? [] : [process.cwd()],
    env,
  });
  page = await application.firstWindow();
  await page.getByRole('button', { name: '载入演示实验' }).click();
});
test.afterEach(async ({}, info) => {
  if (application?.process()?.exitCode === null) {
    if (info.status !== info.expectedStatus)
      await page.screenshot({ path: info.outputPath('failure.png') }).catch(() => {});
    await application.evaluate(() => {
      (globalThis as any).usabilityFailSave = false;
    });
    await application.close();
  }
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
    !directory.split(sep).pop()?.startsWith('labrecord-usability-')
  )
    throw new Error('Unexpected usability test directory');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
async function snapshot(): Promise<Snapshot> {
  return page.evaluate(async () => {
    const reply = await window.labrecord.snapshot();
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  });
}
async function command(input: Command) {
  return page.evaluate(async (input) => {
    const reply = await window.labrecord.command(input, crypto.randomUUID());
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  }, input);
}
async function capture(path: string) {
  const dismiss = page.getByRole('button', { name: '关闭提示' });
  if (await dismiss.count()) await dismiss.click();
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  const png = await application.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return image.toPNG().toString('base64');
  });
  await writeFile(path, Buffer.from(png, 'base64'));
}

test('workspace running banner returns across experiments only after saving the current draft', async ({}, info) => {
  const initial = await snapshot();
  const runningId = initial.items[0].id;
  await command({ type: 'start', itemId: runningId });
  const other = await command({ type: 'createExperiment', code: 'RETURN-B', name: '另一个实验' });
  await command({
    type: 'addSamples',
    experimentId: other.experimentId!,
    patch: { name: '待编辑组', state: 'B', preparedCount: 2 },
    count: 1,
  });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await page.getByLabel('选择实验').selectOption(other.experimentId!);
  const banner = page.getByRole('region', { name: '进行中的操作' });
  await expect(banner).toContainText(
    initial.samples.find((sample) => sample.id === initial.items[0].sampleId)!.code,
  );
  await application.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => any> }
    )._invokeHandlers;
    const original = handlers.get('command')!;
    (globalThis as any).usabilityFailSave = true;
    ipcMain.removeHandler('command');
    ipcMain.handle('command', (...args) => {
      if ((globalThis as any).usabilityFailSave && args[1]?.type === 'updateGroups')
        return { ok: false, error: '测试：暂时不能保存' };
      return original(...args);
    });
  });
  await page.getByLabel('待编辑组 样品统称').fill('第二实验的新组名');
  await banner.getByRole('button', { name: '返回当前操作' }).click();
  await expect(page.locator('.save-indicator')).toContainText('保存失败');
  await expect(page.locator('.plan-page')).toBeVisible();
  await expect(page.getByLabel('选择实验')).toHaveValue(other.experimentId!);
  await expect(page.getByLabel('待编辑组 样品统称')).toHaveValue('第二实验的新组名');
  await application.evaluate(() => {
    (globalThis as any).usabilityFailSave = false;
  });
  await capture(info.outputPath('running-return.png'));
  await banner.getByRole('button', { name: '返回当前操作' }).click();
  await expect(page.locator('.live-page')).toBeVisible();
  await expect(page.getByLabel('选择实验')).toHaveValue(initial.experiments[0].id);
  const saved = await snapshot();
  expect(saved.groups.find((group) => group.experimentId === other.experimentId)?.name).toBe(
    '第二实验的新组名',
  );
  expect(saved.runs).toHaveLength(1);
  expect(saved.items.find((item) => item.id === runningId)?.status).toBe('running');
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await capture(info.outputPath('planning.png'));
});

test('queue status counts and clear filters preserve the full next-item order', async ({}, info) => {
  const initial = await snapshot();
  const ids = initial.items.map((item) => item.id);
  await command({ type: 'skip', itemId: ids[0] });
  await command({ type: 'start', itemId: ids[1] });
  await command({ type: 'interrupt', itemId: ids[1] });
  const beforeFiltering = await snapshot();
  await page.reload();
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  const filters = page.getByRole('group', { name: '队列筛选' });
  await filters.getByRole('button', { name: '已跳过', exact: true }).click();
  await expect(page.locator('.queue-choice')).toHaveCount(1);
  await expect(page.locator('.queue-choice')).toContainText('TA-01');
  await filters.getByRole('button', { name: '已中断', exact: true }).click();
  await expect(page.locator('.queue-choice')).toContainText('TA-02');
  await page.getByLabel('搜索待测样品').fill('不存在的编号');
  await expect(page.locator('.queue-choice')).toHaveCount(0);
  await page.getByRole('button', { name: '清除队列筛选' }).click();
  await expect(page.getByLabel('搜索待测样品')).toHaveValue('');
  await expect(filters.getByRole('button', { name: '全部', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.queue-choice')).toHaveCount(4);
  const saved = await snapshot();
  expect(saved).toEqual(beforeFiltering);
  expect(saved.items.filter((item) => item.status === 'pending').map((item) => item.id)).toEqual(
    ids.slice(2),
  );
  await capture(info.outputPath('queue-status.png'));
});

test('review gaps distinguish planned names from actual references and remain usable in a narrow window', async ({}, info) => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  await command({ type: 'start', itemId: initial.items[1].id });
  await page.reload();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const filters = page.getByRole('group', { name: '按待核对事项筛选操作记录' });
  const rows = page.locator('.review-table tbody tr');
  await filters.getByRole('button', { name: '文件关联未补充，2次' }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator('td').nth(4)).toHaveText('未关联');
  await expect(rows.first().locator('td').first()).toContainText('DEMO-1');
  await filters.getByRole('button', { name: '时间不完整，1次' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('TA-02');
  await page.getByLabel('搜索操作记录').fill('不存在的编号');
  await expect(page.getByText('没有符合条件的记录')).toBeVisible();
  await page.getByRole('button', { name: '清除筛选', exact: true }).first().click();
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(2).locator('td').nth(4)).toHaveText('尚未开始');
  await page.locator('.review-followup').scrollIntoViewIfNeeded();
  await capture(info.outputPath('review-checks.png'));
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setMinimumSize(0, 0);
    win.setSize(900, 700);
    win.webContents.setZoomFactor(1.5);
  });
  await expect(page.locator('.review-scroll-hint')).toBeVisible();
  await page
    .locator('.review-followup')
    .evaluate((element) => element.scrollIntoView({ block: 'center' }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  const firstCell = rows.first().locator('td').first();
  expect((await firstCell.boundingBox())!.y).toBeLessThan(await page.evaluate(() => innerHeight));
  const left = (await firstCell.boundingBox())!.x;
  await page.locator('.review-table-wrap').evaluate((element) => {
    element.scrollLeft = 700;
  });
  expect(Math.abs((await firstCell.boundingBox())!.x - left)).toBeLessThan(2);
  await capture(info.outputPath('review-small.png'));
});
