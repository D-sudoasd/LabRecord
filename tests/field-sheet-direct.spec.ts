import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import ExcelJS from 'exceljs';
import type { Command, Snapshot } from '../src/shared/model.js';

const require = createRequire(import.meta.url);
let application: ElectronApplication;
let page: Page;
let directory: string;
const pageErrors: string[] = [];

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'labrecord-direct-sheet-'));
  pageErrors.length = 0;
  const env = { ...process.env, LABRECORD_TEST_MODE: '1', LABRECORD_TEST_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({
    executablePath: process.env.LABRECORD_EXECUTABLE || require('electron'),
    args: process.env.LABRECORD_EXECUTABLE ? [] : [process.cwd()],
    env,
  });
  page = await application.firstWindow();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await expect(page.locator('.loading-screen')).toHaveCount(0);
  await expect(page.locator('.app-header')).toBeVisible();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
});

test.afterEach(async ({}, info) => {
  if (application?.process()?.exitCode === null) {
    if (info.status !== info.expectedStatus)
      await page.screenshot({ path: info.outputPath('direct-sheet-failure.png') }).catch(() => {});
    await application.close();
  }
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
    !directory.split(sep).pop()?.startsWith('labrecord-direct-sheet-')
  )
    throw new Error('Unexpected direct-sheet test directory');
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

async function createSample() {
  await page.getByRole('button', { name: '新建第一个实验', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建实验', exact: true });
  await create.getByLabel('实验名称 *', { exact: true }).fill('现场直编验收');
  await create.getByLabel('实验编号 *').fill('DIRECT-1');
  await create.getByRole('button', { name: '创建实验', exact: true }).click();
  await expect(create).toHaveCount(0);
  const experimentId = (await snapshot()).experiments[0].id;
  const added = await command({
    type: 'addSamples',
    experimentId,
    patch: { name: 'Ti2448 试样', state: '固溶', preparedCount: 2 },
    count: 1,
    specimens: [{ name: 'A-01', width: '3.0', dimensionUnit: 'mm' }],
    measurement: { protocol: '室温拉伸' },
  });
  await page.reload();
  await expect(page.locator('.loading-screen')).toHaveCount(0);
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(page.getByRole('region', { name: '现场规划表', exact: true })).toBeVisible();
  return { experimentId, itemId: added.itemId! };
}

test('direct rows share a specimen, keep independent conditions and notes, and preserve start snapshots', async () => {
  const { itemId } = await createSample();
  const sheet = page.getByRole('region', { name: '现场规划表', exact: true });
  const table = sheet.getByRole('table');
  const management = page.locator('details', {
    has: page.getByText('样品准备与批量管理', { exact: true }),
  });
  await expect(management).toHaveCount(1);
  await expect(management).not.toHaveAttribute('open');
  await expect(table.getByRole('columnheader')).toHaveText([
    '简写编号',
    '尺寸',
    '原位参数',
    '实际样品信息',
    '备注',
  ]);
  const firstNote = sheet.getByLabel('G-1 备注', { exact: true });
  const thickness = sheet.getByLabel('G-1 厚度', { exact: true });
  await thickness.fill('0');
  await thickness.blur();
  const thicknessUnit = sheet.getByLabel('G-1 厚度单位', { exact: true });
  await thicknessUnit.fill('μm');
  await thicknessUnit.blur();
  await expect.poll(async () => (await snapshot()).samples[0].parameters.thicknessUnit).toBe('μm');
  expect((await snapshot()).samples[0].parameters.thickness).toBe('0');
  await expect(sheet.getByLabel('G-1 高度', { exact: true })).toHaveValue('');
  await firstNote.fill('首次测量有轻微滑移');
  await firstNote.blur();
  await expect.poll(async () => (await snapshot()).items[0].fieldNote).toBe('首次测量有轻微滑移');
  expect((await snapshot()).runs).toHaveLength(0);

  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  const liveNote = page.getByLabel('现场备注', { exact: true });
  await expect(liveNote).toHaveValue('首次测量有轻微滑移');
  await liveNote.fill('首次测量夹具滑移，需重新开始');
  await liveNote.blur();
  await expect
    .poll(async () => (await snapshot()).items[0].fieldNote)
    .toBe('首次测量夹具滑移，需重新开始');
  expect((await snapshot()).runs).toHaveLength(0);
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(firstNote).toHaveValue('首次测量夹具滑移，需重新开始');
  await sheet.getByRole('button', { name: '再测一次 G-1', exact: true }).click();
  await expect(sheet.getByLabel('G-1-2 备注', { exact: true })).toHaveValue('');
  await sheet.getByRole('button', { name: '再测一次 G-1', exact: true }).click();
  await expect.poll(async () => (await snapshot()).items.length).toBe(2);
  let current = await snapshot();
  expect(current.samples).toHaveLength(1);
  expect(current.groups[0].preparedCount).toBe(2);
  expect(current.items).toHaveLength(2);
  const repeat = current.items.find((item) => item.repeatOf === itemId)!;
  expect(repeat.sampleId).toBe(current.items.find((item) => item.id === itemId)!.sampleId);
  expect(repeat.plannedName).toBe('G-1-2');
  expect(current.items.find((item) => item.id === itemId)?.status).toBe('pending');
  expect(current.runs).toHaveLength(0);

  const repeatedProtocol = sheet.getByLabel('G-1-2 原位参数', { exact: true });
  await repeatedProtocol.fill('第二次测量，保持室温');
  await repeatedProtocol.blur();
  const repeatedNote = sheet.getByLabel('G-1-2 备注', { exact: true });
  await repeatedNote.fill('第二次正常');
  await repeatedNote.blur();
  await expect
    .poll(async () => (await snapshot()).items.find((item) => item.id === repeat.id)?.fieldNote)
    .toBe('第二次正常');
  expect((await snapshot()).items.find((item) => item.id === itemId)?.fieldNote).toBe(
    '首次测量夹具滑移，需重新开始',
  );

  await command({ type: 'start', itemId });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const started = (await snapshot()).runs.find((run) => run.itemId === itemId)!;
  const savedSnapshot = structuredClone(started.snapshot);
  const width = sheet.getByLabel('G-1 宽度', { exact: true });
  await width.fill('3.2');
  await width.blur();
  await expect
    .poll(
      async () => (await snapshot()).runs.find((run) => run.itemId === itemId)?.actualSample?.width,
    )
    .toBe('3.2');
  current = await snapshot();
  expect(current.runs.find((run) => run.itemId === itemId)?.snapshot).toEqual(savedSnapshot);
  expect(current.runs.find((run) => run.itemId === itemId)?.originalStartedAt).toBe(
    started.originalStartedAt,
  );
  expect(current.samples[0].parameters.width).toBe('3.2');
  await expect(sheet.getByLabel('G-1-2 宽度', { exact: true })).toHaveValue('3.2');
  await expect(sheet.getByLabel('G-1-2 备注', { exact: true })).toHaveValue('第二次正常');
  await repeatedNote.fill('');
  await repeatedNote.blur();
  await expect
    .poll(async () => (await snapshot()).items.find((item) => item.id === repeat.id)?.fieldNote)
    .toBe('');
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(sheet.getByLabel('G-1-2 备注', { exact: true })).toHaveValue('');
  await expect(sheet.getByLabel('G-1 备注', { exact: true })).toHaveValue(
    '首次测量夹具滑移，需重新开始',
  );
  await command({ type: 'finish', itemId });
  await command({ type: 'start', itemId: repeat.id });
  await command({ type: 'finish', itemId: repeat.id });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const otherStarted = structuredClone(
    (await snapshot()).runs.find((run) => run.itemId === repeat.id)!,
  );
  await sheet.getByRole('button', { name: '再测一次 G-1-2', exact: true }).click();
  await expect(sheet.getByLabel('G-1-3 备注', { exact: true })).toHaveValue('');
  const firstWidth = sheet.getByLabel('G-1 宽度', { exact: true });
  await firstWidth.fill('3.3');
  await firstWidth.blur();
  await expect
    .poll(
      async () => (await snapshot()).runs.find((run) => run.itemId === itemId)?.actualSample?.width,
    )
    .toBe('3.3');
  expect((await snapshot()).runs.find((run) => run.itemId === repeat.id)).toEqual(otherStarted);
  await expect(sheet.getByLabel('G-1-3 宽度', { exact: true })).toHaveValue('3.3');
});

test('legacy run and sample notes remain visible with their sources after a new measurement note is edited', async () => {
  const { itemId } = await createSample();
  let data = await snapshot();
  await command({
    type: 'updateGroups',
    ids: [data.groups[0].id],
    patch: { notes: '旧样品组备注' },
  });
  await command({
    type: 'updateSamples',
    ids: [data.samples[0].id],
    parameters: { notes: '旧单件备注' },
  });
  await command({ type: 'start', itemId });
  data = await snapshot();
  const run = data.runs.find((entry) => entry.itemId === itemId)!;
  await command({ type: 'saveRun', runId: run.id, notes: '旧现场备注' });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const sheet = page.getByRole('region', { name: '现场规划表', exact: true });
  const note = sheet.getByLabel('G-1 备注', { exact: true });
  await expect(note).toHaveValue('旧现场备注');
  await expect(sheet).toContainText('样品备注：旧单件备注');
  await expect(sheet).toContainText('样品组备注：旧样品组备注');
  await note.fill('新增的测量备注');
  await note.blur();
  await expect
    .poll(async () => (await snapshot()).items.find((item) => item.id === itemId)?.fieldNote)
    .toBe('新增的测量备注');
  data = await snapshot();
  expect(data.runs.find((entry) => entry.id === run.id)?.notes).toBe('旧现场备注');
  expect(data.samples[0].parameters.notes).toBe('旧单件备注');
  expect(data.groups[0].notes).toBe('旧样品组备注');
  await expect(sheet).toContainText('原现场备注：旧现场备注');
});

test('an empty specimen label stays empty after start and may explicitly equal the group name', async () => {
  const { itemId } = await createSample();
  const before = await snapshot();
  const item = before.items.find((entry) => entry.id === itemId)!;
  await command({ type: 'updateSamples', ids: [item.sampleId], parameters: { name: '' } });
  await command({ type: 'start', itemId });
  const started = (await snapshot()).runs.find((entry) => entry.itemId === itemId)!;
  const groupName = started.snapshot.sampleGroupName!;
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const sheet = page.getByRole('region', { name: '现场规划表', exact: true });
  const name = sheet.getByLabel(`${started.filename} 原始编号或名称`, { exact: true });
  await expect(name).toHaveValue('');
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const sample = started.snapshot.sample;
  await page.getByRole('button', {
    name: `修改实际制备 ${sample.code} 操作 ${item.order + 1}`, exact: true,
  }).click();
  const actualDialog = page.getByRole('dialog', { name: '修改实际制备' });
  await expect(actualDialog.getByLabel('实际样品名', { exact: true })).toHaveValue('');
  await actualDialog.getByLabel('实际样品名', { exact: true }).fill(groupName);
  await actualDialog.getByRole('button', { name: '保存实际制备', exact: true }).click();
  await expect.poll(async () =>
    (await snapshot()).runs.find((entry) => entry.id === started.id)?.actualSample?.specimenName,
  ).toBe(groupName);
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(name).toHaveValue(groupName);
  await name.fill('');
  await name.blur();
  await expect.poll(async () =>
    (await snapshot()).runs.find((entry) => entry.id === started.id)?.actualSample?.specimenName,
  ).toBe('');
  await name.fill(groupName);
  await name.blur();
  await expect.poll(async () =>
    (await snapshot()).runs.find((entry) => entry.id === started.id)?.actualSample?.specimenName,
  ).toBe(groupName);
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(page.getByLabel(`${started.filename} 原始编号或名称`, { exact: true })).toHaveValue(groupName);
  const saved = (await snapshot()).runs.find((entry) => entry.id === started.id)!;
  expect(saved.actualSources?.['actualSample.specimenName']).toBe('edited');
  expect(saved.actualSample?.name).toBe(started.actualSample?.name);
  expect(saved.actualSources?.['actualSample.name']).toBe(started.actualSources?.['actualSample.name']);
  expect(saved.snapshot).toEqual(started.snapshot);
  expect(saved.originalStartedAt).toBe(started.originalStartedAt);

  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await page.getByRole('button', { name: '更多现场功能', exact: true }).click();
  await page.getByText('实际参数与数据文件', { exact: true }).click();
  const liveName = page.getByLabel('实际样品名称', { exact: true });
  await expect(liveName).toHaveValue(groupName);
  await liveName.fill('现场新编号');
  await liveName.blur();
  await expect.poll(async () =>
    (await snapshot()).runs.find((entry) => entry.id === started.id)?.actualSample?.specimenName,
  ).toBe('现场新编号');
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(page.getByLabel(`${started.filename} 原始编号或名称`, { exact: true })).toHaveValue('现场新编号');
  const finalRun = (await snapshot()).runs.find((entry) => entry.id === started.id)!;
  expect(finalRun.actualSample?.name).toBe(started.actualSample?.name);
  expect(finalRun.actualSources?.['actualSample.name']).toBe(started.actualSources?.['actualSample.name']);
  expect(finalRun.snapshot).toEqual(started.snapshot);
});

test('an entered 未指定 status and explicit clearing survive reload, start and export', async () => {
  const { itemId } = await createSample();
  const sheet = page.getByRole('region', { name: '现场规划表', exact: true });
  const status = sheet.getByLabel('G-1 样品状态', { exact: true });
  const sampleState = async () => (await snapshot()).samples[0].parameters.state;
  const runState = async () =>
    (await snapshot()).runs.find((run) => run.itemId === itemId)?.actualSample?.state;
  const exportSheet = async (name: string, format: 'pdf' | 'xlsx') => {
    const path = join(directory, name);
    await application.evaluate(({ dialog }, outputPath) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: outputPath,
      })) as typeof dialog.showSaveDialog;
    }, path);
    await sheet
      .getByRole('button', {
        name: format === 'pdf' ? '保存 PDF 打印表' : '导出 Excel',
        exact: true,
      })
      .click();
    await expect(page.locator('.toast')).toContainText(path);
    return path;
  };
  const excelIdentity = async (name: string) => {
    const path = await exportSheet(name, 'xlsx');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path);
    const worksheet = workbook.getWorksheet('现场规划表')!;
    return Array.from(
      { length: worksheet.rowCount - 1 },
      (_, index) => worksheet.getRow(index + 2).getCell(4).text,
    ).join('\n');
  };

  await status.fill('未指定');
  await status.blur();
  await expect.poll(sampleState).toBe('未指定');
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(status).toHaveValue('未指定');
  expect(await excelIdentity('待测状态.xlsx')).toContain('状态：未指定');
  const pdf = await exportSheet('待测状态.pdf', 'pdf');
  const extracted = spawnSync('pdftotext', ['-raw', pdf, '-'], { encoding: 'utf8' });
  if (extracted.error) throw new Error(`无法运行 pdftotext：${extracted.error.message}`);
  expect(extracted.status, extracted.stderr).toBe(0);
  expect(extracted.stdout.replace(/\s+/g, '')).toContain('状态：未指定');

  await status.fill('');
  await status.blur();
  await expect.poll(sampleState).toBe('');
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(status).toHaveValue('');
  expect(await excelIdentity('待测清空状态.xlsx')).not.toContain('状态：未指定');

  await status.fill('未指定');
  await status.blur();
  await expect.poll(sampleState).toBe('未指定');
  await command({ type: 'start', itemId });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(status).toHaveValue('未指定');
  const started = (await snapshot()).runs.find((run) => run.itemId === itemId)!;
  const frozen = structuredClone(started.snapshot);
  expect(frozen.group.state).toBe('未指定');

  await status.fill('加载中');
  await status.blur();
  await expect.poll(runState).toBe('加载中');
  await status.fill('未指定');
  await status.blur();
  await expect.poll(runState).toBe('未指定');
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(status).toHaveValue('未指定');
  expect(await excelIdentity('已开始状态.xlsx')).toContain('状态：未指定');

  await status.fill('');
  await status.blur();
  await expect.poll(runState).toBe('');
  await expect.poll(sampleState).toBe('');
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(status).toHaveValue('');
  const afterClear = (await snapshot()).runs.find((run) => run.itemId === itemId)!;
  expect(afterClear.snapshot).toEqual(frozen);
  expect(afterClear.originalStartedAt).toBe(started.originalStartedAt);
  expect(await excelIdentity('已开始清空状态.xlsx')).toContain(
    '实际样品状态：未填写 · 开始时：未指定',
  );
});

test('failed inline note save retains the draft and blocks export until retried', async () => {
  const { itemId } = await createSample();
  await application.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as any)._invokeHandlers as Map<string, (...args: any[]) => any>;
    const original = handlers.get('command');
    const originalExport = handlers.get('export-field-sheet');
    if (!original || !originalExport) throw new Error('Original IPC handlers unavailable');
    const control = { fail: true, noteCalls: 0, exportCalls: 0, copyCalls: 0 };
    (globalThis as any).directSheetTest = control;
    ipcMain.removeHandler('command');
    ipcMain.handle('command', async (...args) => {
      if (args[1]?.type === 'updateFieldRow' && 'fieldNote' in args[1]) {
        control.noteCalls += 1;
        if (control.fail) return { ok: false, error: '测试模拟：备注保存失败', rejected: true };
      }
      return original(...args);
    });
    ipcMain.removeHandler('export-field-sheet');
    ipcMain.handle('export-field-sheet', async (...args) => {
      control.exportCalls += 1;
      return originalExport(...args);
    });
    ipcMain.removeHandler('copy-name');
    ipcMain.handle('copy-name', () => {
      control.copyCalls += 1;
      return { ok: true, data: null };
    });
  });
  const sheet = page.getByRole('region', { name: '现场规划表', exact: true });
  const note = sheet.getByLabel('G-1 备注', { exact: true });
  await note.fill('未保存的现场情况');
  await note.blur();
  await expect(sheet.getByRole('alert')).toContainText('测试模拟：备注保存失败');
  await expect(note).toHaveValue('未保存的现场情况');
  expect((await snapshot()).items.find((item) => item.id === itemId)?.fieldNote).toBeUndefined();

  const attemptsBeforeCopy = await application.evaluate(
    () => (globalThis as any).directSheetTest.noteCalls,
  );
  await sheet.getByRole('button', { name: '复制文件夹名 G-1', exact: true }).click();
  await expect
    .poll(() => application.evaluate(() => (globalThis as any).directSheetTest.noteCalls))
    .toBeGreaterThan(attemptsBeforeCopy);
  await expect(page.locator('.toast')).toContainText('测试模拟：备注保存失败');
  expect(await application.evaluate(() => (globalThis as any).directSheetTest.copyCalls)).toBe(0);
  await expect(note).toHaveValue('未保存的现场情况');

  const attemptsBeforeAdd = await application.evaluate(
    () => (globalThis as any).directSheetTest.noteCalls,
  );
  await sheet.getByRole('button', { name: '新增样品', exact: true }).click();
  await expect
    .poll(() => application.evaluate(() => (globalThis as any).directSheetTest.noteCalls))
    .toBeGreaterThan(attemptsBeforeAdd);
  await expect(page.getByRole('dialog', { name: '添加样品', exact: true })).toHaveCount(0);
  await expect(note).toHaveValue('未保存的现场情况');

  const attemptsBeforeExport = await application.evaluate(
    () => (globalThis as any).directSheetTest.noteCalls,
  );
  await sheet.getByRole('button', { name: '导出 Excel', exact: true }).click();
  await expect
    .poll(() => application.evaluate(() => (globalThis as any).directSheetTest.noteCalls))
    .toBeGreaterThan(attemptsBeforeExport);
  expect(await application.evaluate(() => (globalThis as any).directSheetTest.exportCalls)).toBe(0);
  await expect(note).toHaveValue('未保存的现场情况');
  await application.evaluate(() => {
    (globalThis as any).directSheetTest.fail = false;
  });
  await sheet.getByRole('button', { name: '重试', exact: true }).click();
  await expect
    .poll(async () => (await snapshot()).items.find((item) => item.id === itemId)?.fieldNote)
    .toBe('未保存的现场情况');
  await expect(note).toHaveValue('未保存的现场情况');
  const path = join(directory, '重试后现场表.xlsx');
  await application.evaluate(({ dialog }, outputPath) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath: outputPath,
    })) as typeof dialog.showSaveDialog;
  }, path);
  await sheet.getByRole('button', { name: '导出 Excel', exact: true }).click();
  await expect(page.locator('.toast')).toContainText(`Excel 现场规划表已导出：${path}`);
  expect(await application.evaluate(() => (globalThis as any).directSheetTest.exportCalls)).toBe(1);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const worksheet = workbook.getWorksheet('现场规划表')!;
  expect(worksheet.getRow(1).getCell(5).text).toBe('备注');
  expect(worksheet.getRow(2).getCell(5).text).toContain('未保存的现场情况');
});

test('wide table keeps each code visible while editing notes at 900x700 and 150% zoom', async () => {
  await createSample();
  const sheet = page.getByRole('region', { name: '现场规划表', exact: true });
  await sheet.getByRole('button', { name: '再测一次 G-1', exact: true }).click();
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(900, 700);
    window.webContents.setZoomFactor(1.5);
  });
  const wrap = sheet.locator('.field-sheet-table-wrap');
  await wrap.scrollIntoViewIfNeeded();
  for (const code of ['G-1', 'G-1-2']) {
    const note = sheet.getByLabel(`${code} 备注`, { exact: true });
    const row = note.locator('xpath=ancestor::tr[1]');
    await row.locator('td').first().scrollIntoViewIfNeeded();
    await wrap.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect.poll(() => wrap.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    const visibility = await row
      .locator('td')
      .first()
      .evaluate((cell) => {
        const bounds = cell.querySelector('code')!.getBoundingClientRect();
        const viewport = cell.closest('.field-sheet-table-wrap')!.getBoundingClientRect();
        const left = Math.max(bounds.left, viewport.left);
        const right = Math.min(bounds.right, viewport.right);
        const top = Math.max(bounds.top, viewport.top, 0);
        const bottom = Math.min(bounds.bottom, viewport.bottom, window.innerHeight);
        const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
        return {
          position: getComputedStyle(cell).position,
          visibleWidth: Math.max(0, right - left),
          codeWidth: bounds.width,
          visibleHeight: Math.max(0, bottom - top),
          codeHeight: bounds.height,
          unobscured: !!hit && cell.contains(hit),
        };
      });
    expect(visibility.position).toBe('sticky');
    expect(visibility.visibleWidth, `${code} 编号应在横向滚动后完整可见`).toBeGreaterThanOrEqual(
      visibility.codeWidth - 1,
    );
    expect(visibility.visibleHeight, `${code} 编号应在窗口内完整可见`).toBeGreaterThanOrEqual(
      visibility.codeHeight - 1,
    );
    expect(visibility.unobscured, `${code} 编号不能被其他单元格遮挡`).toBe(true);
    await note.fill(`${code} 的现场备注`);
    await note.blur();
  }
  await expect
    .poll(async () => (await snapshot()).items.map((item) => item.fieldNote))
    .toEqual(['G-1 的现场备注', 'G-1-2 的现场备注']);
});
