import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Command, Snapshot } from '../src/shared/model.js';

const require = createRequire(import.meta.url);
let application: ElectronApplication, page: Page, directory: string;

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'labrecord-review-field-notes-'));
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
});

test.afterEach(async () => {
  if (application?.process()?.exitCode === null) await application.close();
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
    !directory.split(sep).pop()?.startsWith('labrecord-review-field-notes-')
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

async function command(value: Command) {
  return page.evaluate(async (input) => {
    const reply = await window.labrecord.command(input, crypto.randomUUID());
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  }, value);
}

test('review edits one measurement note before start and preserves the older run note', async () => {
  const before = await snapshot();
  const item = before.items.slice().sort((a, b) => a.order - b.order)[0];
  const sample = before.samples.find((entry) => entry.id === item.sampleId)!;
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const button = page.getByRole('button', {
    name: `修改备注 ${sample.code} 操作 ${item.order + 1}`,
    exact: true,
  });
  await button.click();
  let dialog = page.getByRole('dialog', { name: '修改现场备注', exact: true });
  await dialog.getByLabel('现场备注', { exact: true }).fill('尚未开始的备注');
  await dialog.getByRole('button', { name: '保存备注', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  let after = await snapshot();
  expect(after.items.find((entry) => entry.id === item.id)?.fieldNote).toBe('尚未开始的备注');
  expect(after.runs).toHaveLength(0);
  await expect(page.locator('.review-table')).toContainText('尚未开始的备注');

  await command({ type: 'start', itemId: item.id });
  const started = (await snapshot()).runs.find((entry) => entry.itemId === item.id)!;
  await command({ type: 'saveRun', runId: started.id, notes: '旧现场备注原文' });
  await page.reload();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const row = page.locator('.review-table tbody tr', {
    has: page.getByRole('button', {
      name: `修改备注 ${sample.code} 操作 ${item.order + 1}`,
      exact: true,
    }),
  });
  await expect(row).toContainText('尚未开始的备注');
  await expect(row).toContainText('原现场备注：旧现场备注原文');
  await row
    .getByRole('button', { name: `修改备注 ${sample.code} 操作 ${item.order + 1}`, exact: true })
    .click();
  dialog = page.getByRole('dialog', { name: '修改现场备注', exact: true });
  await dialog.getByLabel('现场备注', { exact: true }).fill('现场新的备注');
  await dialog.getByRole('button', { name: '保存备注', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  after = await snapshot();
  expect(after.items.find((entry) => entry.id === item.id)?.fieldNote).toBe('现场新的备注');
  expect(after.runs.find((entry) => entry.id === started.id)?.notes).toBe('旧现场备注原文');
  expect(after.runs.find((entry) => entry.id === started.id)?.snapshot).toEqual(started.snapshot);
  expect(after.runs.find((entry) => entry.id === started.id)?.originalStartedAt).toBe(
    started.originalStartedAt,
  );
  await page.getByLabel('搜索操作记录', { exact: true }).fill('现场新的备注');
  await expect(page.locator('.review-table tbody tr')).toHaveCount(1);
});

test('saving an unchanged legacy note does not create a duplicate measurement note', async () => {
  const before = await snapshot();
  const item = before.items[0];
  const sample = before.samples.find((entry) => entry.id === item.sampleId)!;
  await command({ type: 'start', itemId: item.id });
  const run = (await snapshot()).runs.find((entry) => entry.itemId === item.id)!;
  await command({ type: 'saveRun', runId: run.id, notes: '原有观察' });
  await page.reload();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await page.getByRole('button', {
    name: `修改备注 ${sample.code} 操作 ${item.order + 1}`, exact: true,
  }).click();
  const dialog = page.getByRole('dialog', { name: '修改现场备注', exact: true });
  await expect(dialog.getByLabel('现场备注', { exact: true })).toHaveValue('原有观察');
  await dialog.getByRole('button', { name: '保存备注', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const after = await snapshot();
  expect(Object.prototype.hasOwnProperty.call(after.items.find((entry) => entry.id === item.id), 'fieldNote')).toBe(false);
  expect(after.runs.find((entry) => entry.id === run.id)?.notes).toBe('原有观察');
  await expect(page.locator('.review-table tbody tr').first()).toContainText('原现场备注：原有观察');
});

test('review editing one legacy actual field keeps all other unrecorded fields absent', async () => {
  const before = await snapshot();
  const item = before.items[0];
  const sample = before.samples.find((entry) => entry.id === item.sampleId)!;
  await command({ type: 'start', itemId: item.id });
  const started = (await snapshot()).runs.find((entry) => entry.itemId === item.id)!;
  await application.close();
  const db = new DatabaseSync(join(directory, 'workspace', 'records.sqlite'));
  try {
    const row = db.prepare('SELECT json FROM runs WHERE id = ?').get(started.id) as { json: string };
    const legacy = JSON.parse(row.json);
    delete legacy.actualSample;
    delete legacy.actual.thickness;
    delete legacy.actual.thicknessUnit;
    for (const key of Object.keys(legacy.actualSources || {}))
      if (key.startsWith('actualSample.') || key === 'actual.thickness' || key === 'actual.thicknessUnit')
        delete legacy.actualSources[key];
    db.prepare('UPDATE runs SET json = ? WHERE id = ?').run(JSON.stringify(legacy), started.id);
  } finally {
    db.close();
  }
  const env = { ...process.env, LABRECORD_TEST_MODE: '1', LABRECORD_TEST_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({
    executablePath: process.env.LABRECORD_EXECUTABLE || require('electron'),
    args: process.env.LABRECORD_EXECUTABLE ? [] : [process.cwd()],
    env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.loading-screen')).toHaveCount(0);
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await page.getByRole('button', {
    name: `修改实际制备 ${sample.code} 操作 ${item.order + 1}`, exact: true,
  }).click();
  let dialog = page.getByRole('dialog', { name: '修改实际制备', exact: true });
  await dialog.getByLabel('实际制备或试剂', { exact: true }).fill('仅修正试剂');
  await dialog.getByRole('button', { name: '保存实际制备', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  let run = (await snapshot()).runs.find((entry) => entry.id === started.id)!;
  expect(run.actualSample).toBeUndefined();
  expect(Object.prototype.hasOwnProperty.call(run.actual, 'thickness')).toBe(false);
  await page.getByRole('button', {
    name: `修改实际尺寸 ${sample.code} 操作 ${item.order + 1}`, exact: true,
  }).click();
  dialog = page.getByRole('dialog', { name: '修改实际尺寸', exact: true });
  await dialog.getByLabel('实际宽度', { exact: true }).fill('3.5');
  await dialog.getByRole('button', { name: '保存实际尺寸', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  run = (await snapshot()).runs.find((entry) => entry.id === started.id)!;
  expect(run.actualSample).toEqual({ width: '3.5' });
  expect(run.actualSources?.['actualSample.width']).toBe('edited');
  expect(Object.prototype.hasOwnProperty.call(run.actual, 'thickness')).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(run.actual, 'thicknessUnit')).toBe(false);
  expect(run.snapshot).toEqual(started.snapshot);
  expect(run.originalStartedAt).toBe(started.originalStartedAt);
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const sheet = page.getByRole('region', { name: '现场规划表' });
  const code = run.filename || item.plannedName || sample.code;
  await expect(sheet.getByLabel(`${code} 原始编号或名称`, { exact: true })).toHaveValue('');
  await expect(sheet.getByLabel(`${code} 厚度`, { exact: true })).toHaveValue('');
  await expect(sheet.getByLabel(`${code} 高度`, { exact: true })).toHaveValue('');
  await expect(sheet.getByLabel(`${code} 宽高单位`, { exact: true })).toHaveValue('');
  await expect(sheet.getByLabel(`${code} 样品状态`, { exact: true })).toHaveAttribute('placeholder', '未记录');
  await expect(sheet.getByLabel(`${code} 宽度`, { exact: true })).toHaveValue('3.5');
  await expect(sheet).toContainText('开始时');
  const state = sheet.getByLabel(`${code} 样品状态`, { exact: true });
  await state.fill('人工修正状态');
  await state.blur();
  await expect.poll(async () =>
    (await snapshot()).runs.find((entry) => entry.id === started.id)?.actualSample?.state,
  ).toBe('人工修正状态');
  run = (await snapshot()).runs.find((entry) => entry.id === started.id)!;
  expect(run.actualSample).toEqual({ width: '3.5', state: '人工修正状态' });
  expect(run.snapshot).toEqual(started.snapshot);
  const height = sheet.getByLabel(`${code} 高度`, { exact: true });
  await height.fill('6');
  await height.fill('');
  await height.blur();
  await expect.poll(async () =>
    (await snapshot()).runs.find((entry) => entry.id === started.id)?.actualSources?.['actualSample.height'],
  ).toBe('edited');
  run = (await snapshot()).runs.find((entry) => entry.id === started.id)!;
  expect(run.actualSample?.height).toBe('');
  expect(run.snapshot).toEqual(started.snapshot);
});

test('explicitly clearing a planned empty dimension records the user edit', async () => {
  const before = await snapshot();
  const item = before.items[0];
  const sample = before.samples.find((entry) => entry.id === item.sampleId)!;
  await command({ type: 'start', itemId: item.id });
  const started = (await snapshot()).runs.find((entry) => entry.itemId === item.id)!;
  expect(started.actualSample?.height).toBe('');
  expect(started.actualSources?.['actualSample.height']).toBe('planned');
  await page.reload();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await page.getByRole('button', {
    name: `修改实际尺寸 ${sample.code} 操作 ${item.order + 1}`, exact: true,
  }).click();
  const dialog = page.getByRole('dialog', { name: '修改实际尺寸', exact: true });
  const height = dialog.getByLabel('实际高度', { exact: true });
  await height.fill('5');
  await height.fill('');
  await dialog.getByRole('button', { name: '保存实际尺寸', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const after = (await snapshot()).runs.find((entry) => entry.id === started.id)!;
  expect(after.actualSample?.height).toBe('');
  expect(after.actualSources?.['actualSample.height']).toBe('edited');
  expect(after.snapshot).toEqual(started.snapshot);
});
