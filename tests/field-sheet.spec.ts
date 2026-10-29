import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
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
  directory = await mkdtemp(join(tmpdir(), 'labrecord-field-sheet-'));
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
      await page.screenshot({ path: info.outputPath('field-sheet-failure.png') }).catch(() => {});
    await application.close();
  }
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
    !directory.split(sep).pop()?.startsWith('labrecord-field-sheet-')
  )
    throw new Error('Unexpected field-sheet test directory');
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
  return page.evaluate(async (command) => {
    const reply = await window.labrecord.command(command, crypto.randomUUID());
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  }, input);
}

async function mockSaveDialog(path: string, cancelled = false) {
  await application.evaluate(
    ({ dialog }, value) => {
      dialog.showSaveDialog = (async () => ({
        canceled: value.cancelled,
        filePath: value.cancelled ? undefined : value.path,
      })) as typeof dialog.showSaveDialog;
    },
    { path, cancelled },
  );
}

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function rowFor(sheet: Locator, code: string) {
  const rows = sheet.locator('tbody tr');
  for (let index = 0; index < (await rows.count()); index += 1) {
    const row = rows.nth(index);
    if ((await row.locator('td:first-child code').textContent())?.trim() === code) return row;
  }
  throw new Error(`现场规划表里没有编号 ${code}`);
}

async function addSample(
  code: string,
  groupName: string,
  state: string,
  rawName: string,
  protocol: string,
  width: string,
  chooseInSitu = true,
  note = '',
) {
  await page.getByRole('button', { name: '新增样品', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '添加样品', exact: true });
  await dialog.getByLabel('样品统称 *', { exact: true }).fill(groupName);
  await dialog.getByLabel('样品状态', { exact: true }).fill(state);
  await dialog.getByText('批量添加或设置备样', { exact: true }).click();
  await dialog.getByLabel('准备数量', { exact: true }).fill('2');
  await dialog.getByLabel('计划测试数量', { exact: true }).fill('1');
  await dialog.getByLabel(`${code} 原始编号或名称`, { exact: true }).fill(rawName);
  if (chooseInSitu) {
    await dialog.getByText('更多测量设置（可选）', { exact: true }).click();
    await dialog.getByLabel('实验方式', { exact: true }).selectOption('In situ');
  }
  await dialog.getByLabel('实验制度', { exact: true }).fill(protocol);
  await dialog.getByLabel(`${code} 宽度`, { exact: true }).fill(width);
  if (note) await dialog.getByLabel(`${code} 本次测量备注`, { exact: true }).fill(note);
  await dialog.getByRole('button', { name: '添加并安排测试', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test('new experiments use one printed row per measurement and export the saved five-column plan', async ({}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.getByRole('button', { name: '新建第一个实验', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建实验', exact: true });
  await create.getByLabel('实验名称 *', { exact: true }).fill('现场表验收');
  await create.getByLabel('实验编号 *').fill('SHEET-01');
  await create.getByRole('button', { name: '创建实验', exact: true }).click();
  await expect(create).toHaveCount(0);
  await page.getByRole('button', { name: '实验规划', exact: true }).click();

  const longProtocolChunk = '循环加载，升温 10 °C/min，保温 30 min；LONG-PROTOCOL-CHUNK；';
  const longProtocol = `长制度首段；应变速率 1e-3 s⁻¹；${longProtocolChunk.repeat(130)}最终参数标记-LONG-PROTOCOL-END`;
  const longNoteChunk = '现场情况记录；LONG-NOTE-CHUNK；';
  const longNote = `首次测量实际情况；${longNoteChunk.repeat(80)}最终备注-LONG-NOTE-END`;
  await addSample(
    'G-1',
    'Ti2448 拉伸组 A',
    '固溶',
    '原始标签-TA17',
    longProtocol,
    '3.0',
    true,
    longNote,
  );
  await addSample(
    'G-2',
    'Ti2448 拉伸组 B',
    '冷轧',
    '原始标签-TA18',
    '升至 375 °C，保温 30 min',
    '2.8',
    false,
  );

  let data = await snapshot();
  expect(data.samples.map((sample) => sample.code)).toEqual(['G-1', 'G-2']);
  expect(data.groups.find((group) => group.name === 'Ti2448 拉伸组 B')?.mode).toBe('未定');
  expect(data.items.find((item) => item.sampleId === data.samples[1].id)?.measurement?.mode).toBe(
    '未定',
  );
  expect(data.items.map((item) => item.plannedName)).toEqual(['G-1', 'G-2']);
  expect(data.items.find((item) => item.sampleId === data.samples[0].id)?.fieldNote).toBe(longNote);
  expect(data.runs).toHaveLength(0);
  const first = data.items.find((item) => item.sampleId === data.samples[0].id)!;
  const appended = await command({
    type: 'scheduleMeasurements',
    itemIds: [first.id],
    measurement: {
      mode: 'In situ',
      technique: 'SXRD',
      regime: 'cyclic',
      protocol: '同一实物的第二项测量；1e-3 s⁻¹',
    },
  });
  const appendedId = appended.itemId!;
  data = await snapshot();
  expect(data.items.find((item) => item.id === appendedId)?.plannedName).toBe('G-1-2');
  expect(data.items.find((item) => item.id === appendedId)?.fieldNote || '').toBe('');
  expect(data.items.filter((item) => item.sampleId === first.sampleId)).toHaveLength(2);
  expect(data.samples).toHaveLength(2);
  const secondSampleItem = data.items.find((item) => item.sampleId === data.samples[1].id)!;
  await command({ type: 'skip', itemId: secondSampleItem.id });

  const longIdentityChunk = '冷轧 60%，加工后清洗并测量；LONG-IDENTITY-CHUNK；';
  const longIdentity = `TA17 的原始加工信息；${longIdentityChunk.repeat(42)}最终样品信息标记-LONG-IDENTITY-END`;
  await command({
    type: 'updateSamples',
    ids: [first.sampleId],
    parameters: { processing: longIdentity },
  });

  await command({ type: 'start', itemId: first.id });
  await command({ type: 'finish', itemId: first.id });
  const runAtStart = (await snapshot()).runs.find((run) => run.itemId === first.id)!;
  await command({
    type: 'saveRun',
    runId: runAtStart.id,
    actualSample: { width: '2.95' },
  });
  await command({
    type: 'updateSamples',
    ids: [first.sampleId],
    parameters: { name: '后来修正的样品原始标签-TA17', width: '2.7' },
  });

  await page.reload();
  await expect(page.locator('.loading-screen')).toHaveCount(0);
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const sheet = page.getByRole('region', { name: '现场规划表', exact: true });
  const table = sheet.getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText([
    '简写编号',
    '尺寸',
    '原位参数',
    '实际样品信息',
    '备注',
  ]);
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await expect(table.locator('tbody tr td').filter({ hasText: 'G-1-2' })).toHaveCount(1);

  const firstRow = await rowFor(sheet, 'G-1');
  const repeatedRow = await rowFor(sheet, 'G-1-2');
  const secondSampleRow = await rowFor(sheet, 'G-2');
  await expect(firstRow).toHaveCount(1);
  await expect(repeatedRow).toHaveCount(1);
  await expect(secondSampleRow).toHaveCount(1);
  await expect(firstRow.locator('td:first-child code')).toHaveText('G-1');
  await expect(repeatedRow.locator('td:first-child code')).toHaveText('G-1-2');
  await expect(secondSampleRow.locator('td:first-child code')).toHaveText('G-2');
  await expect(firstRow.getByLabel('G-1 原位参数', { exact: true })).toHaveValue(longProtocol);
  await expect(firstRow).toContainText('状态：已完成');
  await expect(firstRow.getByLabel('G-1 宽度', { exact: true })).toHaveValue('2.95');
  await expect(firstRow.getByRole('cell').nth(1)).toContainText('3.0');
  await expect(firstRow.getByRole('cell').nth(3)).toContainText('Ti2448 拉伸组 A');
  await expect(firstRow.getByLabel('G-1 原始编号或名称', { exact: true })).toHaveValue(
    '原始标签-TA17',
  );
  await expect(firstRow.getByLabel('G-1 备注', { exact: true })).toHaveValue(longNote);
  await firstRow.getByText('更多', { exact: true }).click();
  await expect(firstRow).toContainText('最终样品信息标记-LONG-IDENTITY-END');
  await firstRow.getByText('更多', { exact: true }).click();
  const compactRow = await firstRow.boundingBox();
  expect(compactRow?.height).toBeLessThan(500);
  await expect(repeatedRow.getByLabel('G-1-2 宽度', { exact: true })).toHaveValue('2.7');
  await expect(repeatedRow.getByLabel('G-1-2 原位参数', { exact: true })).toHaveValue(
    '同一实物的第二项测量；1e-3 s⁻¹',
  );
  await expect(repeatedRow.getByLabel('G-1-2 原始编号或名称', { exact: true })).toHaveValue(
    '后来修正的样品原始标签-TA17',
  );
  await expect(repeatedRow.getByLabel('G-1-2 备注', { exact: true })).toHaveValue('');
  await expect(secondSampleRow.getByLabel('G-2 原始编号或名称', { exact: true })).toHaveValue(
    '原始标签-TA18',
  );
  await expect(secondSampleRow.getByLabel('G-2 原位参数', { exact: true })).toHaveValue(
    '升至 375 °C，保温 30 min',
  );
  await expect(secondSampleRow).toContainText('状态：已跳过');
  await expect(table).not.toContainText('未启用备样');

  await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('copy-name');
    ipcMain.handle('copy-name', (_event, name) => {
      (globalThis as any).copiedFieldName = name;
      return { ok: true, data: null };
    });
  });
  await repeatedRow.getByRole('button', { name: '复制文件夹名 G-1-2', exact: true }).click();
  await expect
    .poll(() => application.evaluate(() => (globalThis as any).copiedFieldName))
    .toBe('G-1-2');
  data = await snapshot();
  expect(data.runs).toHaveLength(1);
  expect(data.items.find((item) => item.id === appendedId)?.status).toBe('pending');
  expect(data.items.filter((item) => item.status === 'running')).toHaveLength(0);

  const specimenName = repeatedRow.getByLabel('G-1-2 原始编号或名称', { exact: true });
  await specimenName.fill('导出前立即编辑的原始标签');

  const xlsx = join(directory, '现场规划表.xlsx');
  await mockSaveDialog(xlsx);
  await sheet.getByRole('button', { name: '导出 Excel', exact: true }).click();
  await expect(page.locator('.toast')).toContainText(`Excel 现场规划表已导出：${xlsx}`);
  await expect.poll(() => fileExists(xlsx)).toBe(true);
  data = await snapshot();
  expect(data.samples[0].parameters.name).toBe('导出前立即编辑的原始标签');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsx);
  await copyFile(xlsx, info.outputPath('field-sheet.xlsx'));
  expect(workbook.worksheets.map((worksheet) => worksheet.name)).toEqual(['现场规划表']);
  const worksheet = workbook.worksheets[0];
  const header = worksheet.getRow(1).values as string[];
  const codeColumn = header.indexOf('简写编号');
  const protocolColumn = header.indexOf('原位参数');
  const identityColumn = header.indexOf('实际样品信息');
  const noteColumn = header.indexOf('备注');
  expect(codeColumn).toBeGreaterThan(0);
  expect(protocolColumn).toBeGreaterThan(0);
  expect(identityColumn).toBeGreaterThan(0);
  expect(noteColumn).toBeGreaterThan(0);
  expect(header.slice(1)).toEqual(['简写编号', '尺寸', '原位参数', '实际样品信息', '备注']);
  const rowsByCode = new Map<string, string[][]>();
  const formatsByCode = new Map<string, string[]>();
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber).values as string[];
    const code = String(row[codeColumn] ?? '');
    expect(code).toBeTruthy();
    const parts = rowsByCode.get(code) ?? [];
    parts.push(row);
    rowsByCode.set(code, parts);
    const formats = formatsByCode.get(code) ?? [];
    formats.push(String(worksheet.getRow(rowNumber).getCell(codeColumn).numFmt ?? ''));
    formatsByCode.set(code, formats);
    expect(String(row[protocolColumn] ?? '').length).toBeLessThanOrEqual(32767);
  }
  expect([...rowsByCode.keys()]).toEqual(['G-1', 'G-2', 'G-1-2']);
  const unspecifiedRows = rowsByCode.get('G-2')!;
  expect(unspecifiedRows.map((row) => String(row[protocolColumn] ?? '')).join('\n')).toContain(
    '升至 375 °C，保温 30 min',
  );
  const longRows = rowsByCode.get('G-1')!;
  expect(longRows.length).toBeGreaterThan(1);
  expect(longRows.every((row) => row[codeColumn] === 'G-1')).toBe(true);
  expect(formatsByCode.get('G-1')!.slice(1)).toEqual(
    Array(formatsByCode.get('G-1')!.length - 1).fill('@"（续）"'),
  );
  const compact = (value: string) => value.replace(/\s+/g, '');
  const exportedLong = longRows.map((row) => String(row[protocolColumn] ?? '')).join('\n');
  expect(compact(exportedLong)).toContain(compact(longProtocol));
  expect(exportedLong).toContain('1e-3 s⁻¹');
  expect(exportedLong).toContain('最终参数标记-LONG-PROTOCOL-END');
  const exportedNote = longRows.map((row) => String(row[noteColumn] ?? '')).join('\n');
  expect(compact(exportedNote)).toContain(compact(longNote));
  expect(exportedNote).toContain('最终备注-LONG-NOTE-END');
  expect(rowsByCode.get('G-1-2')!.every((row) => !String(row[noteColumn] ?? '').trim())).toBe(true);
  const exportedRepeatedIdentity = rowsByCode
    .get('G-1-2')!
    .map((row) => String(row[identityColumn] ?? ''))
    .join('\n');
  expect(compact(exportedRepeatedIdentity)).toContain(compact(longIdentity));
  const exportedStartedIdentity = String(longRows[0][identityColumn]);
  expect(exportedStartedIdentity).toContain('原始标签-TA17');
  expect(exportedStartedIdentity).not.toContain('导出前立即编辑的原始标签');
  expect(String(rowsByCode.get('G-1-2')![0][identityColumn])).toContain('导出前立即编辑的原始标签');

  const pdf = join(directory, '现场规划表.pdf');
  await mockSaveDialog(pdf);
  await sheet.getByRole('button', { name: '保存 PDF 打印表', exact: true }).click();
  await expect(page.locator('.toast')).toContainText(`PDF 打印表已保存：${pdf}`);
  await expect.poll(() => fileExists(pdf)).toBe(true);
  const pdfBytes = await readFile(pdf);
  await copyFile(pdf, info.outputPath('field-sheet.pdf'));
  expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdfBytes.length).toBeGreaterThan(5000);
  const pdfSource = pdfBytes.toString('latin1');
  const pdfPages = (pdfSource.match(/\/Type\s*\/Page\b/g) || []).length;
  expect(pdfPages).toBeGreaterThan(1);
  expect(pdfSource).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s*\]/);
  const extracted = spawnSync('pdftotext', ['-raw', pdf, '-'], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (extracted.error)
    throw new Error(`无法运行 pdftotext，PDF 内容核验未完成：${extracted.error.message}`);
  if (extracted.status !== 0)
    throw new Error(`pdftotext 提取 PDF 失败（退出状态 ${extracted.status}）：${extracted.stderr}`);
  const extractedPages = extracted.stdout.split('\f').filter((part) => part.trim());
  for (const [index, part] of extractedPages.entries()) {
    for (const header of ['简写编号', '尺寸', '原位参数', '实际样品信息', '备注'])
      expect(compact(part), `PDF 第 ${index + 1} 页应重复“${header}”表头`).toContain(header);
  }
  const protocolPages = extractedPages.filter((part) => part.includes('LONG-PROTOCOL-CHUNK'));
  expect(protocolPages.length).toBeGreaterThan(1);
  expect(protocolPages[0]).toContain('G-1');
  for (const part of protocolPages) {
    expect(part).toContain('G-1');
    if (part !== protocolPages[0]) expect(part).toContain('（续）');
  }
  const identityPages = extractedPages.filter((part) => part.includes('LONG-IDENTITY-CHUNK'));
  expect(identityPages.length).toBeGreaterThan(1);
  for (const part of identityPages) expect(part).toMatch(/G-1(?:-2)?(?:\s|（)/);
  const compactPdfText = compact(extracted.stdout);
  expect((compactPdfText.match(/LONG-PROTOCOL-CHUNK/g) || []).length).toBe(130);
  expect((compactPdfText.match(/LONG-IDENTITY-CHUNK/g) || []).length).toBe(84);
  expect((compactPdfText.match(/LONG-NOTE-CHUNK/g) || []).length).toBe(80);
  expect(compactPdfText.split('升温10°C/min').length - 1).toBe(130);
  // The second sample has one additional 30-minute hold beyond the 130 long-protocol chunks.
  expect(compactPdfText.split('升至375°C，保温30min').length - 1).toBe(1);
  expect(compactPdfText.split('保温30min').length - 1).toBe(131);
  expect(compactPdfText.split('加工后清洗并测量').length - 1).toBe(84);
  expect(compactPdfText).toContain('应变速率1e-3s⁻¹');
  expect(compact(extracted.stdout)).toContain(compact('最终参数标记-LONG-PROTOCOL-END'));
  expect(compact(extracted.stdout)).toContain(compact('最终样品信息标记-LONG-IDENTITY-END'));
  expect(compact(extracted.stdout)).toContain(compact('最终备注-LONG-NOTE-END'));
  expect(extracted.stdout).toContain('状态：已跳过');
  expect(extracted.stdout).toContain('G-1-2');
  const dismissToast = page.getByRole('button', { name: '关闭提示', exact: true });
  if (await dismissToast.isVisible()) await dismissToast.click();
  await sheet.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('field-sheet.png'), fullPage: true });

  const beforeCancel = await snapshot();
  const cancelPath = join(directory, 'cancelled.pdf');
  await mockSaveDialog(cancelPath, true);
  await sheet.getByRole('button', { name: '保存 PDF 打印表', exact: true }).click();
  await expect.poll(() => fileExists(cancelPath)).toBe(false);
  expect(await snapshot()).toEqual(beforeCancel);

  const rejectedPath = join(directory, 'workspace', 'invalid.xlsx');
  await mockSaveDialog(rejectedPath);
  await sheet.getByRole('button', { name: '导出 Excel', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('实验数据目录之外');
  await expect.poll(() => fileExists(rejectedPath)).toBe(false);
  data = await snapshot();
  expect(data.runs).toHaveLength(beforeCancel.runs.length);
  expect(data.items).toHaveLength(beforeCancel.items.length);
  expect(errors).toEqual([]);
});
