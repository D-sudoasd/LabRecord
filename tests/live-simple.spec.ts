import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Command, Snapshot } from '../src/shared/model.js';

const require = createRequire(import.meta.url);
let application: ElectronApplication;
let page: Page;
let directory: string;
const errors: string[] = [];

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'labrecord-live-simple-'));
  errors.length = 0;
  const env = { ...process.env, LABRECORD_TEST_MODE: '1', LABRECORD_TEST_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({
    executablePath: process.env.LABRECORD_EXECUTABLE || require('electron'),
    args: process.env.LABRECORD_EXECUTABLE ? [] : [process.cwd()],
    env,
  });
  page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.locator('.loading-screen')).toHaveCount(0);
  await expect(page.locator('.app-header')).toBeVisible();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
  await page.getByRole('button', { name: '载入演示实验' }).click();
});

test.afterEach(async () => {
  if (application?.process()?.exitCode === null) await application.close();
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
    !directory.split(sep).pop()?.startsWith('labrecord-live-simple-')
  )
    throw new Error('Unexpected live test directory');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  expect(errors).toEqual([]);
});

async function snapshot(): Promise<Snapshot> {
  return page.evaluate(async () => {
    const reply = await window.labrecord.snapshot();
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  });
}

async function command(input: Command) {
  return page.evaluate(async (value) => {
    const reply = await window.labrecord.command(value, crypto.randomUUID());
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  }, input);
}

test('simple field view shares each measurement note without creating a run', async () => {
  const initial = await snapshot();
  const item = initial.items[0];
  const code =
    item.plannedName || initial.samples.find((sample) => sample.id === item.sampleId)!.code;
  await page.getByRole('button', { name: '进入现场记录' }).click();
  await expect(page.getByRole('button', { name: '开始操作', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '记录问题', exact: true })).toBeHidden();
  const notes = page.getByLabel('现场备注', { exact: true });
  await expect(notes).toBeVisible();
  await notes.fill('装样时先调整位置');
  await notes.blur();
  await expect
    .poll(async () => (await snapshot()).items.find((entry) => entry.id === item.id)?.fieldNote)
    .toBe('装样时先调整位置');
  expect((await snapshot()).runs).toHaveLength(0);

  await page.getByRole('button', { name: '更多现场功能', exact: true }).click();
  await expect(page.getByRole('button', { name: '记录问题', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '添加图片', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '收起现场功能', exact: true }).click();
  await expect(page.getByRole('button', { name: '记录问题', exact: true })).toBeHidden();

  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(page.getByLabel(`${code} 备注`, { exact: true })).toHaveValue('装样时先调整位置');
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  await expect(page.getByLabel('现场备注', { exact: true })).toHaveValue('装样时先调整位置');
  const started = await snapshot();
  expect(started.runs).toHaveLength(1);
  expect(started.runs[0].notes).toBe('');
  expect(started.runs[0].originalStartedAt).toBeTruthy();
});

test('an old run note is editable as a new note without changing historical text', async () => {
  const initial = await snapshot();
  const item = initial.items[0];
  await command({ type: 'start', itemId: item.id });
  const run = (await snapshot()).runs[0];
  await command({ type: 'saveRun', runId: run.id, notes: '旧现场观察' });
  await page.reload();
  await expect(page.locator('.loading-screen')).toHaveCount(0);
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  const notes = page.getByLabel('现场备注', { exact: true });
  await expect(notes).toHaveValue('旧现场观察');
  await expect(page.getByText('当前内容来自原现场备注；修改不会覆盖原记录。')).toBeVisible();
  await notes.fill('新观察');
  await notes.blur();
  await expect
    .poll(async () => (await snapshot()).items.find((entry) => entry.id === item.id)?.fieldNote)
    .toBe('新观察');
  await expect(page.getByText('原现场备注：旧现场观察')).toBeVisible();
  expect((await snapshot()).runs[0].notes).toBe('旧现场观察');

  await notes.fill('');
  await notes.blur();
  await expect
    .poll(async () => (await snapshot()).items.find((entry) => entry.id === item.id)?.fieldNote)
    .toBe('');
  await page.reload();
  await expect(page.locator('.loading-screen')).toHaveCount(0);
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await expect(page.getByLabel('现场备注', { exact: true })).toHaveValue('');
  await expect(page.getByText('原现场备注：旧现场观察')).toBeVisible();
  expect((await snapshot()).runs[0].notes).toBe('旧现场观察');
});

test('an empty experiment keeps its live empty state and return action visible', async () => {
  const created = await command({ type: 'createExperiment', code: 'EMPTY-LIVE', name: '空现场' });
  await page.reload();
  await page.getByLabel('选择实验', { exact: true }).selectOption(created.experimentId!);
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await expect(page.getByText('还没有待测样品', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回实验规划', exact: true }).click();
  await expect(page.getByRole('button', { name: '实验规划', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('corrected actual state stays visible and searchable without altering the start snapshot', async () => {
  const initial = await snapshot();
  const item = initial.items[0];
  await command({ type: 'start', itemId: item.id });
  const run = (await snapshot()).runs.find((entry) => entry.itemId === item.id)!;
  await command({ type: 'updateFieldRow', itemId: item.id, sample: { state: '时效态' } });
  await page.reload();
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  const heading = page.locator('.current-heading');
  await expect(heading).toContainText('实际状态：时效态');
  await expect(heading).toContainText(`开始时：${run.snapshot.group.state}`);
  await page.getByRole('button', { name: '更多现场功能', exact: true }).click();
  await page.getByLabel('搜索待测样品', { exact: true }).fill('时效态');
  await expect(page.locator('.queue-list .queue-row')).toHaveCount(1);
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await page.getByLabel('搜索操作记录', { exact: true }).fill('时效态');
  await expect(page.locator('.review-table tbody tr')).toHaveCount(1);
  const after = (await snapshot()).runs.find((entry) => entry.id === run.id)!;
  expect(after.snapshot).toEqual(run.snapshot);
  expect(after.originalStartedAt).toBe(run.originalStartedAt);
});

test('opening detailed live controls scrolls the selected late queue item into view', async () => {
  const created = await command({ type: 'createExperiment', code: 'LONG-LIVE', name: '长队列' });
  await command({
    type: 'addSamples', experimentId: created.experimentId!, count: 30, prefix: 'J',
    patch: { name: '长队列样品', state: '固溶', preparedCount: 30 },
  });
  await page.reload();
  await page.getByLabel('选择实验', { exact: true }).selectOption(created.experimentId!);
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await page.getByRole('button', { name: '队列与搜索', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '待测队列与搜索' });
  await dialog.getByRole('button', { name: '选择样品 J-30 操作 30', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '更多现场功能', exact: true }).click();
  const list = page.locator('.live-layout > .queue .queue-list');
  await expect.poll(() => list.evaluate((element) => {
    const selected = element.querySelector('.queue-row.current .queue-choice strong');
    if (!selected) return false;
    const bounds = element.getBoundingClientRect();
    const title = selected.getBoundingClientRect();
    return title.top >= bounds.top && title.bottom <= bounds.bottom;
  })).toBe(true);
});

test('simple view exposes long actual and changed protocols without hiding the main action', async ({}, info) => {
  const initial = await snapshot();
  const item = initial.items[0];
  await command({ type: 'start', itemId: item.id });
  const started = (await snapshot()).runs[0];
  const actual = `实际制度-${'长内容'.repeat(150)}-末尾`;
  const planned = `更新计划-${'长内容'.repeat(150)}-末尾`;
  await command({ type: 'saveRun', runId: started.id, actual: { protocol: actual } });
  await command({ type: 'updateGroups', ids: [initial.groups[0].id], patch: { protocol: planned } });
  await page.reload();
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(900, 700);
    win.webContents.setZoomFactor(1.5);
  });
  await expect.poll(() => page.evaluate(() => matchMedia('(max-width: 650px)').matches)).toBe(true);
  const heading = page.locator('.current-heading');
  const drift = heading.locator('.live-comparison').filter({ has: page.locator('.plan-drift') });
  const protocol = heading.locator('.live-comparison').filter({ has: page.locator('.actual-protocol') });
  await expect(drift.locator('summary')).toBeVisible();
  await expect(protocol.locator('summary')).toBeVisible();
  await expect(heading.locator('.actual-protocol')).toContainText('开始时');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  for (const comparison of [drift, protocol]) {
    expect((await comparison.boundingBox())!.height).toBeLessThan(45);
  }
  await page.getByRole('button', { name: '完成并切换下一项', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('simple-long-protocol-900-150.png') });
  await expect(page.getByRole('button', { name: '完成并切换下一项', exact: true })).toBeInViewport({ ratio: 1 });
  await protocol.locator('summary').click();
  await expect(protocol.locator('p')).toContainText(actual);
  await expect(protocol.locator('p')).toContainText(started.snapshot.group.protocol);
  await drift.locator('summary').click();
  await expect(drift.locator('p')).toContainText(planned);
  const after = (await snapshot()).runs.find((entry) => entry.id === started.id)!;
  expect(after.snapshot).toEqual(started.snapshot);
  expect(after.originalStartedAt).toBe(started.originalStartedAt);
});

test('simple view follow-up actions open the right controls without changing the record', async () => {
  const initial = await snapshot();
  const item = initial.items[0];
  await command({ type: 'start', itemId: item.id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'addEvent', experimentId: item.experimentId, itemId: item.id, runId: run.id,
    eventType: 'issue', text: '装样方向待核对', category: '样品',
  });
  const before = await snapshot();
  await page.reload();
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  const gaps = page.getByRole('list', { name: '待核对', exact: true });
  await expect(gaps.getByRole('button', { name: '时间不完整', exact: true })).toBeVisible();
  await expect(gaps.getByRole('button', { name: '文件未关联', exact: true })).toBeVisible();
  await expect(gaps.getByRole('button', { name: '未处理问题', exact: true })).toBeVisible();
  await gaps.getByRole('button', { name: '时间不完整', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '修正起止时间' })).toBeVisible();
  await page.keyboard.press('Escape');
  await gaps.getByRole('button', { name: '未处理问题', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '未处理的问题' })).toContainText('装样方向待核对');
  await page.keyboard.press('Escape');
  await gaps.getByRole('button', { name: '文件未关联', exact: true }).click();
  await expect(page.getByRole('button', { name: '收起现场功能', exact: true })).toBeVisible();
  await expect(page.getByLabel('实际文件名', { exact: true })).toBeVisible();
  await expect(page.getByLabel('实际文件名', { exact: true })).toBeFocused();
  const after = await snapshot();
  expect(after.runs).toEqual(before.runs);
  expect(after.events).toEqual(before.events);
});
