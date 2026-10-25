import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Command, Snapshot } from '../src/shared/model.js';
import { recordedClock } from '../src/shared/recordedTime.js';

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
  const upcoming = page.getByRole('region', { name: '下一项待测' });
  await expect(upcoming).toContainText('TA-01');
  await expect(upcoming).toContainText('原位');
  await expect(upcoming).toContainText('0.8 mm');
  await expect(upcoming).toContainText('375');
  await expect(upcoming).toContainText('DEMO-1_TA-01');
  await expect(upcoming).not.toContainText('核对装样方向');
  await upcoming.getByRole('button', { name: '复制下一项文件夹 TA-01', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('DEMO-1_TA-01');
  await expect(page.locator('.plan-page')).toBeVisible();
  expect((await snapshot()).runs).toHaveLength(0);
  await page.getByRole('button', { name: '全库搜索', exact: true }).click();
  const libraryNext = page
    .getByRole('dialog', { name: '全库搜索' })
    .getByRole('option', { name: '查看下一项 TA-01', exact: true });
  await expect(libraryNext).toContainText('0.8 mm');
  await expect(libraryNext).toContainText('DEMO-1_TA-01');
  await expect(libraryNext).not.toContainText('核对装样方向');
  await libraryNext.click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('TA-01');
  await expect(page.locator('.live-page')).toBeVisible();
  expect((await snapshot()).runs).toHaveLength(0);
  const initial = await snapshot();
  const ids = initial.items.map((item) => item.id);
  await command({ type: 'skip', itemId: ids[0] });
  await command({ type: 'start', itemId: ids[1] });
  await command({ type: 'interrupt', itemId: ids[1] });
  const openRun = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: openRun.id,
    notes: '队列备注不参与搜索',
    actual: { scanId: 'SCAN-QUEUE-02', filename: 'frame_queue.cbf' },
  });
  const beforeFiltering = await snapshot();
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const planning = page.locator('.planning-card');
  await planning.getByLabel('搜索样品组', { exact: true }).fill('SCAN-QUEUE-02');
  await expect(planning.locator('.toolbar-title')).toContainText('1 /');
  await planning.getByLabel('搜索样品组', { exact: true }).fill('队列备注不参与搜索');
  await expect(planning.locator('.toolbar-title')).toContainText('0 /');
  await planning.getByRole('button', { name: '清除搜索样品组', exact: true }).click();
  const measurementSearch = page.getByLabel('搜索测量计划', { exact: true });
  await measurementSearch.fill('SCAN-QUEUE-02');
  await expect(page.getByRole('checkbox', { name: /TA-02/ })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /TA-03/ })).toHaveCount(0);
  await measurementSearch.fill('');
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await expect(page.locator('.live-progress')).toContainText('备样 5');
  await expect(page.locator('.live-progress')).toContainText('本组备样 2');
  const samplesBeforeSpare = (await snapshot()).samples.length;
  await page.getByRole('button', { name: '启用备样', exact: true }).click();
  const spareDialog = page.getByRole('dialog', { name: '选择样品组启用备样' });
  const currentGroup = spareDialog.getByRole('button', { name: '启用备样 Ti-A 拉伸试样 当前样品组' });
  await expect(currentGroup).toContainText('备样 2');
  await expect(spareDialog.getByRole('button', { name: '启用备样 Ti-B 对照试样', exact: true })).toContainText(
    '备样 3',
  );
  await spareDialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  expect((await snapshot()).samples).toHaveLength(samplesBeforeSpare);
  expect((await snapshot()).runs).toHaveLength(1);
  await page.getByRole('button', { name: '启用本组备样（2）', exact: true }).click();
  const arrange = page.getByRole('dialog', { name: '启用备样' });
  await expect(arrange).toContainText('备样 2');
  await expect(arrange.getByRole('spinbutton')).toHaveValue('1');
  await expect(arrange.locator('.specimen-plan code').first()).toHaveText('S01');
  await arrange.getByRole('button', { name: '沿用已有前缀 TA-', exact: true }).click();
  await expect(arrange.locator('.specimen-plan code').first()).toHaveText('TA-05');
  await arrange.getByRole('button', { name: '取消', exact: true }).click();
  expect((await snapshot()).samples).toHaveLength(samplesBeforeSpare);
  expect((await snapshot()).runs).toHaveLength(1);
  const recent = page.getByRole('region', { name: '最近记录' });
  await expect(recent).toContainText('最近中断');
  await expect(recent).toContainText('TA-02');
  await expect(recent).toContainText('SCAN-QUEUE-02');
  await expect(recent).toContainText(beforeFiltering.runs[0].filename);
  await expect(recent).not.toContainText('队列备注不参与搜索');
  expect((await snapshot()).runs).toHaveLength(1);
  await page.getByRole('button', { name: '选择样品 TA-02 操作 2' }).click();
  const queued = await snapshot();
  const interrupted = queued.runs[0];
  const pendingFolder = queued.items.find((item) => item.order === 2)?.plannedName || '';
  expect(interrupted.filename).not.toBe('');
  expect(pendingFolder).not.toBe('');
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2' })).toContainText(
    interrupted.filename,
  );
  await expect(page.getByRole('button', { name: '选择样品 TA-03 操作 3' })).toContainText(
    pendingFolder,
  );
  const nextRegion = page.getByRole('region', { name: '现场下一项' });
  await expect(nextRegion).toContainText(pendingFolder);
  await nextRegion.getByRole('button', { name: '复制下一项文件夹 TA-03', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(pendingFolder);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('TA-02');
  expect((await snapshot()).runs).toHaveLength(1);
  expect((await snapshot()).runs[0].originalStartedAt).toBe(interrupted.originalStartedAt);
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2' })).toContainText(
    'SCAN-QUEUE-02',
  );
  await page.getByLabel('搜索待测样品', { exact: true }).fill('SCAN-QUEUE-02');
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2' })).toBeVisible();
  await expect(page.getByRole('button', { name: '选择样品 TA-03 操作 3' })).toHaveCount(0);
  await page.getByLabel('搜索待测样品', { exact: true }).fill('队列备注不参与搜索');
  await expect(page.locator('.queue-choice')).toHaveCount(0);
  await page.getByLabel('搜索待测样品', { exact: true }).fill('frame_queue.cbf');
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2' })).toBeVisible();
  await page.getByRole('button', { name: '清除搜索待测样品', exact: true }).click();
  const startedClock = recordedClock(
    interrupted.startedAt,
    interrupted.offsetMinutes,
    interrupted.timezone,
  )!;
  const endedClock = recordedClock(
    interrupted.endedAt,
    interrupted.offsetMinutes,
    interrupted.timezone,
  )!;
  await expect(page.locator('.time-card')).toContainText(startedClock.clock);
  await expect(page.locator('.time-card')).toContainText(endedClock.clock);
  await expect(page.locator('.time-card')).toContainText(startedClock.zone);
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

test('a retest shows the original scan and folder and opens that run without starting another', async () => {
  const initial = await snapshot();
  const originalId = initial.items[0].id;
  await command({ type: 'start', itemId: originalId });
  await command({ type: 'finish', itemId: originalId });
  const finished = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: finished.id,
    actual: { scanId: 'SCAN-REPEAT-01' },
  });
  await command({ type: 'repeat', itemId: originalId });
  await page.reload();
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  const repeat = (await snapshot()).items.find((item) => item.repeatOf === originalId)!;
  const row = page.getByRole('button', { name: `选择样品 TA-01 操作 ${repeat.order + 1}` });
  await expect(row).toContainText('重测自 TA-01');
  await expect(row).toContainText('SCAN-REPEAT-01');
  await expect(row).toContainText(finished.filename);
  await row.click();
  const origin = page.getByRole('region', { name: '重测来源' });
  await expect(origin).toContainText('SCAN-REPEAT-01');
  await expect(origin).toContainText(finished.filename);
  await origin.getByRole('button', { name: '查看原操作 TA-01', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('TA-01');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].originalStartedAt).toBe(finished.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(finished.originalEndedAt);
  expect(after.runs[0].snapshot.sample.id).toBe(finished.snapshot.sample.id);
  expect(after.items.find((item) => item.id === repeat.id)?.sampleId).toBe(finished.sampleId);
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await page.getByLabel('搜索操作记录', { exact: true }).fill('SCAN-REPEAT-01');
  const reviewRow = page.locator('.review-table tbody tr', { hasText: '重测自 TA-01' });
  await expect(reviewRow).toContainText('SCAN-REPEAT-01');
  await expect(reviewRow).toContainText(finished.filename);
  await reviewRow.getByRole('button', { name: '查看原操作 TA-01', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('TA-01');
  const reviewed = await snapshot();
  expect(reviewed.runs).toHaveLength(1);
  expect(reviewed.runs[0].originalEndedAt).toBe(finished.originalEndedAt);
  expect(reviewed.runs[0].snapshot.sample.id).toBe(finished.snapshot.sample.id);
});

test('review gaps distinguish planned names from actual references and remain usable in a narrow window', async ({}, info) => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  await command({
    type: 'addEvent',
    experimentId: initial.experiments[0].id,
    itemId: initial.items[0].id,
    eventType: 'note',
    text: '记录时区核对',
  });
  await command({ type: 'start', itemId: initial.items[1].id });
  await page.reload();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const filters = page.getByRole('group', { name: '按待核对事项筛选操作记录' });
  const rows = page.locator('.review-table tbody tr');
  await filters.getByRole('button', { name: '文件关联未补充，2次' }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator('td').nth(4)).toContainText('未关联');
  await expect(rows.first().locator('td').first()).toContainText('DEMO-1');
  await filters.getByRole('button', { name: '时间不完整，1次' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('TA-02');
  await page.getByLabel('搜索操作记录').fill('不存在的编号');
  await expect(page.getByText('没有符合条件的记录')).toBeVisible();
  await page.getByRole('button', { name: '清除筛选', exact: true }).first().click();
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(2).locator('td').nth(4)).toHaveText('尚未开始');
  const finished = (await snapshot()).runs.find((run) => run.endedAt)!;
  const finishedClock = recordedClock(finished.startedAt, finished.offsetMinutes, finished.timezone)!;
  await expect(page.locator('.review-table tbody tr', { hasText: 'TA-01' }).locator('td').nth(2)).toHaveAttribute(
    'title',
    `${finishedClock.clock} ${finishedClock.zone}`,
  );
  await expect(page.locator('.review-table tbody tr', { hasText: 'TA-01' }).locator('td').nth(2)).toContainText(
    finishedClock.clock,
  );
  const note = (await snapshot()).events.find((event) => event.text === '记录时区核对')!;
  const noteClock = recordedClock(note.createdAt, finished.offsetMinutes, finished.timezone)!;
  await page
    .locator('.review-table tbody tr', { hasText: 'TA-01' })
    .getByRole('button', { name: '历史', exact: true })
    .click();
  const history = page.getByRole('dialog', { name: '记录与修改历史' });
  await expect(history).toContainText('记录时区核对');
  await expect(history).toContainText(noteClock.clock);
  await expect(history).toContainText(noteClock.zone);
  await history.getByRole('button', { name: '关闭对话框', exact: true }).click();
  expect((await snapshot()).runs.find((run) => run.id === finished.id)?.originalStartedAt).toBe(
    finished.originalStartedAt,
  );
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

test('experiment library and next pending open the field without starting a run', async () => {
  test.setTimeout(90000);
  const progress = page.getByRole('region', { name: '下一项待测' });
  await expect(progress).toContainText('TA-01');
  await progress.getByRole('button', { name: '去现场查看下一项 TA-01', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('TA-01');
  expect((await snapshot()).runs).toHaveLength(0);
  await expect(page.getByText('待测。下一步：开始。')).toBeVisible();

  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  await expect(page.getByRole('button', { name: '完成并切换下一项' })).toBeVisible();
  const upcoming = page.getByRole('region', { name: '现场下一项' });
  await expect(upcoming).toContainText('TA-02');
  await expect(upcoming).toContainText('原位');
  await expect(upcoming).toContainText('0.8 mm');
  await expect(upcoming).toContainText('375');
  await expect(upcoming).toContainText('DEMO-1_TA-02');
  await expect(upcoming).not.toContainText('核对装样方向');
  expect((await snapshot()).runs).toHaveLength(1);
  await page.getByRole('button', { name: '待核对', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2' })).toHaveCount(0);
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2' })).toBeVisible();
  await expect(
    page.getByRole('option', { name: '同步辐射实验 · 演示 · DEMO-1 · 待核对 1' }),
  ).toHaveCount(1);
  await page.getByRole('button', { name: '复制样品 ID', exact: true }).click();
  const copiedId = await application.evaluate(({ clipboard }) => clipboard.readText());
  const afterCopy = await snapshot();
  const copiedRun = afterCopy.runs[0];
  expect(copiedId).toBe(copiedRun.snapshot.sample.id);
  expect(copiedId).toBe(copiedRun.sampleId);
  expect(copiedRun.endedAt).toBeNull();
  expect(copiedRun.originalStartedAt).toBe(copiedRun.startedAt);
  expect((await snapshot()).runs).toHaveLength(1);
  await page.keyboard.press('Control+K');
  const idSearch = page.getByRole('dialog', { name: '全库搜索' });
  await idSearch.locator('input').fill(copiedId);
  await expect(idSearch.getByRole('option', { name: /TA-01/ })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.getByLabel('搜索待测样品', { exact: true }).fill(copiedId.slice(0, 7));
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toHaveCount(0);
  await page.getByLabel('搜索待测样品', { exact: true }).fill(copiedId);
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2' })).toHaveCount(0);
  await page.getByRole('button', { name: '清除搜索待测样品', exact: true }).click();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(progress).toContainText('TA-02');
  const planning = page.locator('.planning-card');
  await planning.getByLabel('搜索样品组', { exact: true }).fill(copiedId.slice(0, 7));
  await expect(planning.locator('.toolbar-title')).toContainText('0 /');
  await planning.getByLabel('搜索样品组', { exact: true }).fill(copiedId);
  await expect(planning.locator('.toolbar-title')).toContainText('1 /');
  await planning.getByRole('button', { name: '清除搜索样品组', exact: true }).click();
  const checkFirst = page.getByRole('region', { name: '先核对' });
  await expect(checkFirst).toContainText('TA-01');
  await expect(checkFirst).toContainText('时间不完整');
  await expect(checkFirst).toContainText('文件未关联');
  await checkFirst.getByRole('button', { name: '去核对 TA-01', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('TA-01');
  expect((await snapshot()).runs).toHaveLength(1);
  expect((await snapshot()).runs[0].endedAt).toBeNull();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await progress.getByRole('button', { name: '去现场查看下一项 TA-02', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('TA-02');
  await expect(page.getByText('待测。先完成正在进行的操作。')).toBeVisible();
  expect((await snapshot()).runs).toHaveLength(1);
  expect((await snapshot()).items.filter((item) => item.status === 'running')).toHaveLength(1);

  await page.getByRole('button', { name: '全库搜索', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '全库搜索' });
  await expect(dialog.locator('.library-count', { hasText: '准备' })).toContainText('9');
  await expect(dialog.locator('.library-count', { hasText: '计划样品' })).toContainText('4');
  await expect(dialog.locator('.library-count', { hasText: '计划操作' })).toContainText('4');
  await expect(dialog.locator('.library-count', { hasText: '备样' })).toContainText('5');
  await expect(dialog.locator('.library-count', { hasText: '时间不完整' })).toContainText('1');
  await expect(dialog.locator('.library-count', { hasText: '文件未关联' })).toContainText('1');
  await expect(dialog.getByRole('option', { name: '返回进行中 TA-01', exact: true })).toBeVisible();
  await expect(dialog.getByRole('option', { name: '去核对 TA-01', exact: true })).toHaveCount(0);
  await dialog.getByRole('option', { name: '查看下一项 TA-02', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('TA-02');
  expect((await snapshot()).runs).toHaveLength(1);

  await page.getByRole('button', { name: '全库搜索', exact: true }).click();
  const search = page.getByRole('dialog', { name: '全库搜索' }).getByRole('combobox', { name: '全库搜索', exact: true });
  await search.fill('核对装样方向');
  await expect(page.getByText('没有匹配的样品或实验')).toBeVisible();
  await search.fill('演示材料');
  await expect(page.getByText('没有匹配的样品或实验')).toBeVisible();
  await search.fill('375');
  await expect(page.getByRole('option', { name: /TA-01/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const recorded = await snapshot();
  const openRun = recorded.runs.find((run) =>
    recorded.items.some((item) => item.id === run.itemId && item.status === 'running'),
  )!;
  await command({
    type: 'saveRun',
    runId: openRun.id,
    actual: { thickness: '1.1', scanId: 'SCAN-88421' },
  });
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('TA-01');
  const beforeScanCopy = await snapshot();
  const scanRun = beforeScanCopy.runs[0];
  await page.getByText('实际参数与数据文件', { exact: true }).click();
  await page.getByRole('button', { name: '复制扫描编号', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('SCAN-88421');
  await page.getByText('实际参数与数据文件', { exact: true }).click();
  const afterScanCopy = await snapshot();
  expect(afterScanCopy.runs[0].actual.scanId).toBe('SCAN-88421');
  expect(afterScanCopy.runs[0].endedAt).toBeNull();
  expect(afterScanCopy.runs[0].originalStartedAt).toBe(scanRun.originalStartedAt);
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toContainText(
    '时间不完整',
  );
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).not.toContainText(
    '文件未关联',
  );
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2' })).not.toContainText(
    '时间不完整',
  );
  await page.getByRole('button', { name: '专注当前样品', exact: true }).click();
  const gaps = page.getByRole('list', { name: '待核对' });
  await expect(gaps).toContainText('时间不完整');
  await expect(gaps).not.toContainText('文件未关联');
  const beforeTimes = await snapshot();
  const runningBefore = beforeTimes.runs.find((run) =>
    beforeTimes.items.some((item) => item.id === run.itemId && item.status === 'running'),
  )!;
  await page.getByRole('button', { name: '时间不完整', exact: true }).click();
  const timeDialog = page.getByRole('dialog', { name: '修正起止时间' });
  await expect(timeDialog).toBeVisible();
  await timeDialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const afterTimes = await snapshot();
  const runningAfter = afterTimes.runs.find((run) => run.id === runningBefore.id)!;
  expect(runningAfter.endedAt).toBeNull();
  expect(runningAfter.originalStartedAt).toBe(runningBefore.originalStartedAt);
  expect(runningAfter.startedAt).toBe(runningBefore.startedAt);
  await page.getByRole('button', { name: '退出专注', exact: true }).click();
  await expect(page.getByRole('list', { name: '与开始时计划不同' })).toContainText('1.1 mm');
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const changes = page.getByRole('list', { name: 'TA-01 与开始时计划不同' });
  await expect(changes).toContainText('0.8 mm');
  await expect(changes).toContainText('1.1 mm');
  await expect(page.getByText('尚无完整起止')).toBeVisible();
  await expect(page.locator('.review-table tbody tr', { hasText: 'TA-01' })).toContainText('未计入');
  await expect(page.locator('.review-table tbody tr', { hasText: 'TA-02' })).not.toContainText(
    '未计入',
  );
  const reviewRun = (await snapshot()).runs[0];
  await page.getByLabel('搜索操作记录', { exact: true }).fill(reviewRun.id.slice(0, 7));
  await expect(page.locator('.review-table tbody tr', { hasText: 'TA-01' })).toHaveCount(0);
  await page.getByLabel('搜索操作记录', { exact: true }).fill(reviewRun.id);
  await expect(page.locator('.review-table tbody tr', { hasText: 'TA-01' })).toHaveCount(1);
  await expect(page.locator('.review-table tbody tr', { hasText: 'TA-02' })).toHaveCount(0);
  await page.getByRole('button', { name: '清除搜索操作记录', exact: true }).click();
  await expect(page.locator('.review-table tbody tr', { hasText: 'TA-01' })).toContainText(
    reviewRun.snapshot.sample.id,
  );
  await page.getByRole('button', { name: '复制样品 ID TA-01 操作 1', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(
    reviewRun.snapshot.sample.id,
  );
  await page.getByRole('button', { name: '复制数据文件夹 TA-01 操作 1', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(reviewRun.filename);
  const afterReviewCopy = await snapshot();
  expect(afterReviewCopy.runs).toHaveLength(1);
  expect(afterReviewCopy.runs[0].endedAt).toBeNull();
  expect(afterReviewCopy.runs[0].originalStartedAt).toBe(reviewRun.originalStartedAt);
  expect(afterReviewCopy.runs[0].filename).toBe(reviewRun.filename);
  await page.getByRole('button', { name: '复制扫描编号 TA-01 操作 1', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('SCAN-88421');
  const afterScanReview = await snapshot();
  expect(afterScanReview.runs[0].actual.scanId).toBe(reviewRun.actual.scanId);
  expect(afterScanReview.runs[0].endedAt).toBeNull();
  expect(afterScanReview.runs[0].originalStartedAt).toBe(reviewRun.originalStartedAt);
  await expect(page.getByText('1 次起止不完整，未计入')).toBeVisible();
  const roster = page.getByRole('list', { name: '待核对清单' });
  await expect(roster).toContainText('TA-01');
  await expect(roster).toContainText('时间不完整');
  await expect(roster).not.toContainText('TA-02');
  await roster.getByRole('button', { name: '打开 TA-01', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('TA-01');
  const opened = await snapshot();
  expect(opened.runs).toHaveLength(1);
  expect(opened.runs[0].endedAt).toBeNull();
  await page.getByRole('button', { name: '全库搜索', exact: true }).click();
  const referenceSearch = page.getByRole('dialog', { name: '全库搜索' }).getByRole('combobox', { name: '全库搜索', exact: true });
  await referenceSearch.fill('SCAN-88421');
  await expect(page.getByRole('option', { name: /TA-01/ })).toBeVisible();
  await referenceSearch.fill('核对装样方向');
  await expect(page.getByText('没有匹配的样品或实验')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
});
