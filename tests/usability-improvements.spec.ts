import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Command, Snapshot } from '../src/shared/model.js';

const require = createRequire(import.meta.url);
let application: ElectronApplication, page: Page, directory: string;
let pageErrors: string[];

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'labrecord-improvements-'));
  const env = { ...process.env, LABRECORD_TEST_MODE: '1', LABRECORD_TEST_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({
    executablePath: process.env.LABRECORD_EXECUTABLE || require('electron'),
    args: process.env.LABRECORD_EXECUTABLE ? [] : [process.cwd()],
    env,
  });
  page = await application.firstWindow();
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
  await page.getByRole('button', { name: '载入演示实验', exact: true }).click();
});

test.afterEach(async ({}, info) => {
  if (application?.process()?.exitCode === null) {
    if (info.status !== info.expectedStatus)
      await page.screenshot({ path: info.outputPath('failure.png') }).catch(() => {});
    await application.evaluate(() => {
      (globalThis as any).improvementsFailSave = false;
    });
    await application.close();
  }
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
    !directory.split(sep).pop()?.startsWith('labrecord-improvements-')
  )
    throw new Error('Unexpected improvements test directory');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  expect(pageErrors).toEqual([]);
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

async function rejectRunSaves() {
  await application.evaluate(({ ipcMain }) => {
    const original = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => any> }
    )._invokeHandlers.get('command')!;
    (globalThis as any).improvementsFailSave = true;
    ipcMain.removeHandler('command');
    ipcMain.handle('command', (...args) =>
      (globalThis as any).improvementsFailSave && args[1]?.type === 'saveRun'
        ? { ok: false, error: '验收：暂时不能保存', rejected: true }
        : original(...args),
    );
  });
}

async function allowRunSaves() {
  await application.evaluate(() => {
    (globalThis as any).improvementsFailSave = false;
  });
}

async function capture(path: string) {
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  const png = await application.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'),
  );
  await writeFile(path, Buffer.from(png, 'base64'));
}

test('quick add keeps optional preparation compact and inherited values visible with continuous-entry focus', async () => {
  const initial = await snapshot();
  await page.getByRole('button', { name: '新增样品', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '添加样品', exact: true });
  const material = dialog.locator('details.material-preparation-fields');
  const name = dialog.getByLabel('样品统称 *', { exact: true });
  await expect(material).not.toHaveAttribute('open');
  await expect(material.getByLabel('成分', { exact: true })).not.toBeVisible();
  await material.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(material.getByLabel('成分', { exact: true })).toBeVisible();
  await name.fill('连续录入合金');
  await material.getByLabel('成分', { exact: true }).fill('Ti-15Nb（at.%）');
  await dialog.getByRole('button', { name: '热处理制度设为无', exact: true }).click();
  await name.focus();
  await page.keyboard.press('Control+Enter');
  await expect(name).toHaveValue('');
  await expect(name).toBeFocused();
  await expect(material.locator('summary')).toContainText('已填写');
  await expect(material.getByLabel('成分', { exact: true })).toHaveValue('Ti-15Nb（at.%）');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '新增样品', exact: true }).first().click();
  await expect(material).not.toHaveAttribute('open');
  await dialog.getByRole('button', { name: '沿用上一组参数', exact: true }).click();
  await expect(material).toHaveAttribute('open');
  await expect(material.getByLabel('成分', { exact: true })).toHaveValue('Ti-15Nb（at.%）');
  await expect(dialog.getByLabel('热处理制度', { exact: true })).toHaveValue('无');
  await expect(name).toBeFocused();
  await page.keyboard.press('Escape');
  const after = await snapshot();
  expect(after.groups).toHaveLength(initial.groups.length + 1);
  expect(after.samples).toHaveLength(initial.samples.length + 1);
  expect(after.groups.at(-1)?.composition).toBe('Ti-15Nb（at.%）');
  expect(after.groups.at(-1)?.heatTreatment).toBe('无');
  expect(after.runs).toEqual(initial.runs);
});

test('arrange defaults to one and arrange-all remains a cancellable draft without guessing unknown quantities', async () => {
  const initial = await snapshot();
  const row = page.locator('.plan-table tbody > tr').first();
  await row.getByRole('button', { name: '安排测试', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '安排待测样品', exact: true });
  const count = dialog.getByLabel('本次加入待测队列的数量 *', { exact: true });
  await expect(count).toHaveValue('1');
  await expect(dialog.locator('.specimen-plan > li')).toHaveCount(1);
  await dialog.getByRole('button', { name: '全部安排 2 个', exact: true }).click();
  await expect(count).toHaveValue('2');
  await expect(dialog.locator('.specimen-plan > li')).toHaveCount(2);
  expect((await snapshot()).samples).toEqual(initial.samples);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect((await snapshot()).items).toEqual(initial.items);
  await row.getByRole('button', { name: '安排测试', exact: true }).click();
  await expect(count).toHaveValue('1');
  await dialog.getByRole('button', { name: '全部安排 2 个', exact: true }).click();
  await dialog.getByRole('button', { name: /加入待测队列/ }).click();
  await expect(dialog).toHaveCount(0);
  const arranged = await snapshot();
  expect(arranged.samples).toHaveLength(initial.samples.length + 2);
  expect(arranged.items).toHaveLength(initial.items.length + 2);
  expect(arranged.groups[0].preparedCount).toBe(initial.groups[0].preparedCount);
  expect(arranged.runs).toHaveLength(0);
  await command({
    type: 'addSamples',
    experimentId: initial.experiments[0].id,
    patch: { name: '准备数量未填', state: '未知', preparedCount: null },
    count: 0,
  });
  await page.reload();
  await page
    .getByRole('row', { name: /准备数量未填/ })
    .getByRole('button', { name: '安排测试', exact: true })
    .click();
  await expect(count).toHaveValue('1');
  await expect(dialog.getByRole('button', { name: /全部安排/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect((await snapshot()).samples).toEqual(arranged.samples);
});

test('measurement filters reset together and review gaps open the exact existing record for safe completion', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const finished = (await snapshot()).runs[0];
  await command({ type: 'saveRun', runId: finished.id, actual: { thickness: '1.2' } });
  await command({ type: 'start', itemId: initial.items[1].id });
  await command({ type: 'updateGroups', ids: [initial.groups[0].id], patch: { thickness: '1.4' } });
  const before = await snapshot();
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const planner = page.getByRole('region', { name: '测量计划', exact: true });
  await planner.getByLabel('搜索测量计划', { exact: true }).fill('TA-01');
  await planner.getByLabel('按状态筛选测量', { exact: true }).selectOption('completed');
  await planner.getByRole('button', { name: '计划已变', exact: true }).click();
  await planner.getByRole('button', { name: '实际已改', exact: true }).click();
  await expect(planner.locator('tbody tr')).toHaveCount(1);
  await planner.getByRole('checkbox', { name: '选择测量 1 TA-01', exact: true }).check();
  await planner.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(planner.locator('tbody tr')).toHaveCount(initial.items.length);
  await expect(planner.getByLabel('搜索测量计划', { exact: true })).toHaveValue('');
  await expect(planner.getByLabel('按状态筛选测量', { exact: true })).toHaveValue('');
  await expect(planner.getByRole('button', { name: '计划已变', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(planner.getByRole('button', { name: '实际已改', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(planner.locator('input[type=checkbox]:checked')).toHaveCount(0);
  await planner.getByLabel('搜索测量计划', { exact: true }).fill('不会匹配任何样品');
  await expect(
    planner.getByText('没有符合筛选的测量。清除筛选可恢复全部测量，队列顺序保持不变。'),
  ).toBeVisible();
  await planner.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(planner.locator('tbody tr')).toHaveCount(initial.items.length);
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const roster = page.getByRole('list', { name: '待核对清单', exact: true });
  await roster.getByRole('button', { name: '补充时间 TA-02 操作 2', exact: true }).click();
  const times = page.getByRole('dialog', { name: '修正起止时间', exact: true });
  await expect(times.locator('.dialog-target')).toContainText('TA-02');
  await expect(times.getByLabel('结束时间', { exact: true })).toHaveValue('');
  await times.getByRole('button', { name: '取消', exact: true }).click();
  expect((await snapshot()).runs).toEqual(before.runs);
  await roster.getByRole('button', { name: '填写文件 TA-01 操作 1', exact: true }).click();
  const files = page.getByRole('dialog', { name: '填写数据文件', exact: true });
  await expect(files.locator('.dialog-target')).toContainText('TA-01');
  await files.getByLabel('扫描编号', { exact: true }).fill('取消的扫描号');
  await files.getByRole('button', { name: '取消', exact: true }).click();
  expect((await snapshot()).runs).toEqual(before.runs);
  await roster.getByRole('button', { name: '填写文件 TA-01 操作 1', exact: true }).click();
  await files.getByLabel('扫描编号', { exact: true }).fill('SCAN-REVIEW-DIRECT');
  await rejectRunSaves();
  await files.getByRole('button', { name: '保存文件关联', exact: true }).click();
  await expect(files.getByRole('alert')).toContainText('暂时不能保存');
  await expect(files.getByLabel('扫描编号', { exact: true })).toHaveValue('SCAN-REVIEW-DIRECT');
  expect((await snapshot()).runs).toEqual(before.runs);
  await allowRunSaves();
  await files.getByRole('button', { name: '保存文件关联', exact: true }).click();
  await expect(files).toHaveCount(0);
  await expect(page.locator('.review-page')).toBeVisible();
  await expect(
    roster.getByRole('button', { name: '填写文件 TA-01 操作 1', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '填写文件 TA-03 操作 3', exact: true }),
  ).toHaveCount(0);
  const after = await snapshot();
  expect(after.items).toEqual(before.items);
  expect(after.runs).toHaveLength(before.runs.length);
  expect(after.runs.find((run) => run.id !== finished.id)).toEqual(
    before.runs.find((run) => run.id !== finished.id),
  );
  const saved = after.runs.find((run) => run.id === finished.id)!;
  expect(saved.actual.scanId).toBe('SCAN-REVIEW-DIRECT');
  expect(saved.snapshot).toEqual(finished.snapshot);
  expect(saved.originalStartedAt).toBe(finished.originalStartedAt);
  expect(saved.originalEndedAt).toBe(finished.originalEndedAt);
});

test('field notes precede context cards and copying flushes safely while narrow context controls wrap', async ({}, info) => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  await command({ type: 'start', itemId: initial.items[1].id });
  const before = await snapshot();
  const run = before.runs.find((entry) => entry.itemId === initial.items[1].id)!;
  await page.reload();
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  const currentChoice = page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true });
  await currentChoice.click();
  const code = currentChoice.locator('strong');
  await code.scrollIntoViewIfNeeded();
  await expect(code).toHaveText('TA-02');
  await expect(code).toBeInViewport({ ratio: 1 });
  const queueLayout = await currentChoice.evaluate((element) => {
    const content = element.querySelector('div')!;
    const label = element.querySelector('strong')!;
    const row = element.closest('.queue-row')!;
    const more = row.querySelector('.queue-more')!;
    return {
      viewportWidth: innerWidth,
      contentWidth: content.getBoundingClientRect().width,
      codeHeight: label.getBoundingClientRect().height,
      codeLineHeight: parseFloat(getComputedStyle(label).lineHeight),
      rowRight: row.getBoundingClientRect().right,
      moreRight: more.getBoundingClientRect().right,
    };
  });
  expect(queueLayout.contentWidth).toBeGreaterThanOrEqual(125);
  expect(queueLayout.codeHeight).toBeLessThanOrEqual(queueLayout.codeLineHeight + 1);
  expect(queueLayout.moreRight).toBeLessThanOrEqual(queueLayout.rowRight + 1);
  await writeFile(info.outputPath('queue-layout.json'), JSON.stringify(queueLayout, null, 2));
  const notes = page.getByLabel('现场备注', { exact: true });
  const quick = page.getByRole('group', { name: '常用现场记录', exact: true });
  const copy = page.getByRole('button', { name: '复制数据文件夹名', exact: true });
  await expect(copy).toHaveCount(1);
  const quickBox = (await quick.boundingBox())!;
  const notesBox = (await notes.boundingBox())!;
  expect(quickBox.y + quickBox.height).toBeLessThanOrEqual(notesBox.y);
  for (const label of ['最近记录', '现场先核对', '现场下一项']) {
    const box = (await page.getByRole('region', { name: label, exact: true }).boundingBox())!;
    expect(notesBox.y + notesBox.height).toBeLessThanOrEqual(box.y);
  }
  await capture(info.outputPath('field-priority-wide.png'));
  await application.evaluate(({ clipboard }) => clipboard.writeText('复制前的内容'));
  await rejectRunSaves();
  await notes.fill('复制前仍需保存的现场备注');
  await copy.click();
  await expect(page.locator('.save-indicator')).toContainText('保存失败');
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('复制前的内容');
  await expect(notes).toHaveValue('复制前仍需保存的现场备注');
  expect((await snapshot()).runs).toEqual(before.runs);
  await allowRunSaves();
  await copy.click();
  await expect(page.locator('.save-indicator')).toContainText('已保存到本机');
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(run.filename);
  await expect(page.locator('.current-heading h2')).toHaveText('TA-02');
  const after = await snapshot();
  expect(after.runs).toHaveLength(2);
  expect(after.items).toEqual(before.items);
  expect(after.runs.find((entry) => entry.id === run.id)?.notes).toBe('复制前仍需保存的现场备注');
  expect(after.runs.find((entry) => entry.id === run.id)?.snapshot).toEqual(run.snapshot);
  expect(after.runs.find((entry) => entry.id === run.id)?.originalStartedAt).toBe(
    run.originalStartedAt,
  );
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setMinimumSize(0, 0);
    win.setSize(900, 700);
    win.webContents.setZoomFactor(1.5);
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  const recent = page.getByRole('region', { name: '最近记录', exact: true });
  await recent.scrollIntoViewIfNeeded();
  expect(await recent.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await capture(info.outputPath('field-context-narrow.png'));
});

test('workspace search reveals further matches, restores keyboard focus and only views the chosen sample', async ({}, info) => {
  const initial = await snapshot();
  await command({
    type: 'addSamples',
    experimentId: initial.experiments[0].id,
    patch: { name: '检索候选合金', state: '原态', preparedCount: 12 },
    count: 12,
  });
  await page.reload();
  const before = await snapshot();
  await page.getByRole('button', { name: '全库搜索', exact: true }).focus();
  await page.keyboard.press('Control+K');
  const dialog = page.getByRole('dialog', { name: '全库搜索', exact: true });
  const input = dialog.getByRole('combobox', { name: '全库搜索', exact: true });
  await expect(input).toBeFocused();
  await expect(dialog.getByText('当前实验', { exact: true })).toBeVisible();
  await input.fill('检索候选合金');
  await expect(dialog.getByRole('option')).toHaveCount(8);
  await expect(dialog).toContainText('显示 8 / 12 项结果');
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setMinimumSize(0, 0);
    win.setSize(900, 700);
    win.webContents.setZoomFactor(1.5);
  });
  await dialog.getByRole('button', { name: '显示更多结果', exact: true }).click();
  await expect(dialog.getByRole('option')).toHaveCount(12);
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('aria-activedescendant', 'workspace-hit-8');
  expect((await snapshot()).runs).toEqual(before.runs);
  const target = (await dialog.getByRole('option').nth(8).locator('strong').innerText()).split(
    ' · ',
  )[0];
  await expect(input).toBeInViewport({ ratio: 1 });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await capture(info.outputPath('search-more-narrow.png'));
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.current-heading h2')).toHaveText(target);
  expect((await snapshot()).runs).toEqual(before.runs);
  expect((await snapshot()).items).toEqual(before.items);
  await page.keyboard.press('Control+K');
  await input.fill('无匹配检索词');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await dialog.getByRole('button', { name: '清除全库搜索', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(dialog.getByRole('listbox', { name: '实验库', exact: true })).toBeVisible();
  await expect(input).toHaveAttribute('aria-activedescendant', 'workspace-hit-0');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect((await snapshot()).runs).toEqual(before.runs);
});
