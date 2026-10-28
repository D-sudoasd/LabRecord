import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Snapshot } from '../src/shared/model.js';

const require = createRequire(import.meta.url);
let application: ElectronApplication, page: Page, directory: string;

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'labrecord-sample-entry-'));
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
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
});

test.afterEach(async ({}, info) => {
  if (application?.process()?.exitCode === null) {
    if (info.status !== info.expectedStatus)
      await page.screenshot({ path: info.outputPath('sample-entry-failure.png') }).catch(() => {});
    await application.close();
  }
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
    !directory.split(sep).pop()?.startsWith('labrecord-sample-entry-')
  )
    throw new Error('Unexpected sample-entry test directory');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function snapshot(): Promise<Snapshot> {
  return page.evaluate(async () => {
    const reply = await window.labrecord.snapshot();
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  });
}

async function openQuickAdd() {
  await page.getByRole('button', { name: '新增样品', exact: true }).first().click();
  return page.getByRole('dialog', { name: '添加样品' });
}

test('a clean sample form closes directly without changing records', async () => {
  const before = await snapshot();
  const dialog = await openQuickAdd();
  await dialog.getByRole('button', { name: '关闭对话框' }).click();
  await expect(dialog).toHaveCount(0);
  const after = await snapshot();
  expect(after.samples).toHaveLength(before.samples.length);
  expect(after.items).toHaveLength(before.items.length);
  expect(after.runs).toHaveLength(before.runs.length);
});

test('a changed sample form warns; Escape and continue preserve fields; discard writes nothing', async ({}, info) => {
  const before = await snapshot();
  const dialog = await openQuickAdd();
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(900, 700);
    window.webContents.setZoomFactor(1.5);
  });
  const name = dialog.getByLabel('样品统称 *', { exact: true });
  await name.fill('暂存的试样名称');
  const closeButton = dialog.getByRole('button', { name: '关闭对话框' });
  await closeButton.click();

  const prompt = dialog.getByRole('alertdialog', { name: '放弃这次样品填写？' });
  await expect(prompt).toBeVisible();
  await expect(dialog.locator('form.quick-add-form')).toBeHidden();
  await expect(prompt.getByRole('button', { name: '继续填写' })).toBeFocused();
  await expect(prompt.getByRole('button', { name: '继续填写' })).toBeInViewport();
  await expect(prompt.getByRole('button', { name: '放弃填写' })).toBeInViewport();
  const png = await application.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return image.toPNG().toString('base64');
  });
  await writeFile(
    info.outputPath('discard-confirmation-small-window.png'),
    Buffer.from(png, 'base64'),
  );
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await expect(dialog.locator('form.quick-add-form')).toBeVisible();
  await expect(name).toHaveValue('暂存的试样名称');
  await expect(closeButton).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(prompt).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('form.quick-add-form')).toBeVisible();
  await expect(name).toHaveValue('暂存的试样名称');

  await closeButton.click();
  await prompt.getByRole('button', { name: '继续填写' }).click();
  await expect(name).toHaveValue('暂存的试样名称');
  await expect(closeButton).toBeFocused();

  await closeButton.click();
  await prompt.getByRole('button', { name: '放弃填写' }).click();
  await expect(dialog).toHaveCount(0);
  const after = await snapshot();
  expect(after.samples).toHaveLength(before.samples.length);
  expect(after.items).toHaveLength(before.items.length);
  expect(after.runs).toHaveLength(before.runs.length);
});

test('saved parameters in continue-add count as clean when closing', async () => {
  const before = await snapshot();
  const dialog = await openQuickAdd();
  await dialog.getByLabel('样品统称 *', { exact: true }).fill('已保存的试样');
  await dialog.getByRole('button', { name: '保存并继续添加', exact: true }).click();
  await expect.poll(async () => (await snapshot()).samples.length).toBe(before.samples.length + 1);
  await expect(dialog.getByLabel('样品统称 *', { exact: true })).toHaveValue('');

  await dialog.getByRole('button', { name: '关闭对话框' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('alertdialog', { name: '放弃这次样品填写？' })).toHaveCount(0);

  const reopened = await openQuickAdd();
  const name = reopened.getByLabel('样品统称 *', { exact: true });
  await name.fill('连续添加后新填的样品');
  await reopened.getByRole('button', { name: '关闭对话框' }).click();
  const prompt = reopened.getByRole('alertdialog', { name: '放弃这次样品填写？' });
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: '继续填写' }).click();
  await expect(name).toHaveValue('连续添加后新填的样品');
  await reopened.getByRole('button', { name: '关闭对话框' }).click();
  await prompt.getByRole('button', { name: '放弃填写' }).click();
  await expect(reopened).toHaveCount(0);

  const after = await snapshot();
  expect(after.samples).toHaveLength(before.samples.length + 1);
  expect(after.items).toHaveLength(before.items.length + 1);
  expect(after.runs).toHaveLength(before.runs.length);
});

test('quick add keeps specimen drafts when counts change and clears them after saving', async () => {
  const before = await snapshot();
  const dialog = await openQuickAdd();
  await dialog.getByLabel('样品统称 *', { exact: true }).fill('数量调整草稿');
  await dialog.getByLabel('准备数量', { exact: true }).fill('2');
  await dialog.getByLabel('计划测试数量', { exact: true }).fill('2');
  const rows = dialog.locator('.specimen-plan li');
  await expect(rows).toHaveCount(2);
  const first = (await rows.nth(0).locator('code').innerText()).trim();
  const second = (await rows.nth(1).locator('code').innerText()).trim();
  await dialog.getByLabel(`${first} 原始编号或名称`, { exact: true }).fill('原始 A');
  await dialog.getByLabel(`${first} 厚度`, { exact: true }).fill('0.90');
  await dialog.getByLabel(`${first} 厚度单位`, { exact: true }).selectOption('μm');
  await dialog.getByLabel(`${second} 原始编号或名称`, { exact: true }).fill('原始 B');
  await dialog.getByLabel(`${second} 宽度`, { exact: true }).fill('3.7');
  await dialog.getByLabel(`${second} 宽高单位`, { exact: true }).selectOption('cm');

  // A common edit order temporarily exceeds the prepared count.
  await dialog.getByLabel('计划测试数量', { exact: true }).fill('3');
  await expect(dialog.getByRole('alert')).toContainText('不超过准备数量');
  await dialog.getByLabel('准备数量', { exact: true }).fill('3');
  await expect(rows).toHaveCount(3);
  await expect(dialog.getByLabel(`${first} 原始编号或名称`, { exact: true })).toHaveValue('原始 A');
  await expect(dialog.getByLabel(`${first} 厚度`, { exact: true })).toHaveValue('0.90');
  await expect(dialog.getByLabel(`${first} 厚度单位`, { exact: true })).toHaveValue('μm');
  await expect(dialog.getByLabel(`${second} 原始编号或名称`, { exact: true })).toHaveValue(
    '原始 B',
  );
  await expect(dialog.getByLabel(`${second} 宽度`, { exact: true })).toHaveValue('3.7');
  await expect(dialog.getByLabel(`${second} 宽高单位`, { exact: true })).toHaveValue('cm');
  const third = (await rows.nth(2).locator('code').innerText()).trim();
  await dialog.getByLabel(`${third} 原始编号或名称`, { exact: true }).fill('原始 C');
  await dialog.getByLabel(`${third} 高度`, { exact: true }).fill('7.2');

  await dialog.getByLabel('计划测试数量', { exact: true }).fill('0');
  await expect(rows).toHaveCount(0);
  await dialog.getByLabel('计划测试数量', { exact: true }).fill('3');
  await expect(dialog.getByLabel(`${third} 原始编号或名称`, { exact: true })).toHaveValue('原始 C');
  await expect(dialog.getByLabel(`${third} 高度`, { exact: true })).toHaveValue('7.2');
  await dialog.getByLabel('计划测试数量', { exact: true }).fill('1');
  await expect(rows).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: '后面也用这个尺寸' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '保存并继续添加', exact: true }).click();
  await expect.poll(async () => (await snapshot()).samples.length).toBe(before.samples.length + 1);
  await expect(dialog.getByLabel('样品统称 *', { exact: true })).toHaveValue('');
  const after = await snapshot();
  const group = after.groups.find((entry) => entry.name === '数量调整草稿')!;
  const saved = after.samples.filter((entry) => entry.groupId === group.id);
  expect(group.preparedCount).toBe(3);
  expect(saved).toHaveLength(1);
  expect(saved[0].parameters.name).toBe('原始 A');
  expect(saved[0].parameters.thickness).toBe('0.90');
  expect(saved[0].parameters.thicknessUnit).toBe('μm');
  expect(after.items).toHaveLength(before.items.length + 1);

  // A new group must not inherit the drafts hidden before the previous save.
  await dialog.getByLabel('计划测试数量', { exact: true }).fill('3');
  await expect(rows).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    const code = (await rows.nth(index).locator('code').innerText()).trim();
    await expect(dialog.getByLabel(`${code} 原始编号或名称`, { exact: true })).toHaveValue('');
    await expect(dialog.getByLabel(`${code} 厚度`, { exact: true })).toHaveValue('');
    await expect(dialog.getByLabel(`${code} 宽度`, { exact: true })).toHaveValue('');
    await expect(dialog.getByLabel(`${code} 高度`, { exact: true })).toHaveValue('');
  }
});

test('arrange preserves hidden specimen drafts without inventing sample names', async () => {
  const dialog = await openQuickAdd();
  await dialog.getByLabel('样品统称 *', { exact: true }).fill('待安排草稿组');
  await dialog.getByLabel('样品状态', { exact: true }).fill('固溶');
  await dialog.getByLabel('准备数量', { exact: true }).fill('3');
  await dialog.getByLabel('计划测试数量', { exact: true }).fill('0');
  await dialog.getByRole('button', { name: '添加为备样', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const groupRow = page.locator('.plan-table tr').filter({
    has: page.getByRole('textbox', { name: '待安排草稿组 样品统称', exact: true }),
  });
  await groupRow.getByRole('button', { name: '安排测试', exact: true }).click();
  const arrange = page.getByRole('dialog', { name: '安排待测样品' });
  const count = arrange.getByLabel('本次加入待测队列的数量 *', { exact: true });
  await count.fill('2');
  const rows = arrange.locator('.specimen-plan li');
  await expect(rows).toHaveCount(2);
  let firstCode = (await rows.nth(0).locator('code').innerText()).trim();
  await expect(arrange.getByLabel(`${firstCode} 样品名`, { exact: true })).toHaveValue('');
  await arrange.getByLabel(`${firstCode} 自定编号`, { exact: true }).fill('Q-1');
  firstCode = 'Q-1';
  await expect(arrange.getByLabel(`${firstCode} 样品名`, { exact: true })).toHaveValue('');
  const secondCustom = rows.nth(1).getByLabel(/自定编号/);
  await secondCustom.fill(firstCode);
  const addButton = arrange.getByRole('button', { name: '加入待测队列', exact: true });
  await expect(arrange.getByRole('alert')).toContainText('已存在');
  await expect(addButton).toBeDisabled();
  await expect(addButton).toHaveAttribute('aria-describedby', 'arrange-code-error');
  await secondCustom.fill('');
  await expect(addButton).toBeEnabled();
  const secondCode = (await rows.nth(1).locator('code').innerText()).trim();
  await arrange.getByLabel(`${firstCode} 样品名`, { exact: true }).fill('原始 A');
  await arrange.getByLabel(`${firstCode} 样品状态`, { exact: true }).fill('时效');
  await arrange.getByLabel(`${firstCode} 备注`, { exact: true }).fill('第一件备注');
  await arrange.getByLabel(`${firstCode} 实验制度`, { exact: true }).fill('第二段条件');
  await arrange.getByLabel(`${firstCode} 厚度`, { exact: true }).fill('1.1');
  await arrange.getByLabel(`${secondCode} 样品名`, { exact: true }).fill('原始 B');
  await arrange.getByLabel(`${secondCode} 宽度`, { exact: true }).fill('2.4');

  await count.fill('4');
  await expect(arrange.getByRole('alert')).toContainText('最多安排 3');
  await count.fill('2');
  await expect(arrange.getByLabel(`${firstCode} 样品名`, { exact: true })).toHaveValue('原始 A');
  await expect(arrange.getByLabel(`${firstCode} 样品状态`, { exact: true })).toHaveValue('时效');
  await expect(arrange.getByLabel(`${firstCode} 备注`, { exact: true })).toHaveValue('第一件备注');
  await expect(arrange.getByLabel(`${firstCode} 实验制度`, { exact: true })).toHaveValue(
    '第二段条件',
  );
  await expect(arrange.getByLabel(`${secondCode} 样品名`, { exact: true })).toHaveValue('原始 B');
  await expect(arrange.getByLabel(`${secondCode} 宽度`, { exact: true })).toHaveValue('2.4');

  await count.fill('1');
  await expect(rows).toHaveCount(1);
  await expect(arrange.getByRole('button', { name: '后面也用这个尺寸' })).toHaveCount(0);
  await arrange.getByLabel('粘贴样品名', { exact: true }).fill('粘贴更新 A');
  await arrange.getByRole('button', { name: '按行填入样品名', exact: true }).click();
  await count.fill('2');
  await expect(arrange.getByLabel(`${firstCode} 样品名`, { exact: true })).toHaveValue(
    '粘贴更新 A',
  );
  await expect(arrange.getByLabel(`${secondCode} 样品名`, { exact: true })).toHaveValue('原始 B');
  await expect(arrange.getByLabel(`${secondCode} 宽度`, { exact: true })).toHaveValue('2.4');
  await count.fill('1');
  await addButton.click();
  await expect(arrange).toHaveCount(0);
  let data = await snapshot();
  const group = data.groups.find((entry) => entry.name === '待安排草稿组')!;
  let samples = data.samples.filter((entry) => entry.groupId === group.id);
  expect(samples).toHaveLength(1);
  expect(samples[0].code).toBe('Q-1');
  expect(samples[0].parameters.name).toBe('粘贴更新 A');
  expect(samples[0].parameters.thickness).toBe('1.1');
  expect(samples[0].parameters.protocol).toBe('第二段条件');

  // Reopening the dialog starts a fresh draft. A missing name stays missing on save.
  await groupRow.getByRole('button', { name: '安排测试', exact: true }).click();
  const reopened = page.getByRole('dialog', { name: '安排待测样品' });
  const freshCode = (await reopened.locator('.specimen-plan li code').first().innerText()).trim();
  await expect(reopened.getByLabel(`${freshCode} 样品名`, { exact: true })).toHaveValue('');
  await expect(reopened.getByLabel(`${freshCode} 宽度`, { exact: true })).toHaveValue('');
  await reopened.getByRole('button', { name: '加入待测队列', exact: true }).click();
  await expect(reopened).toHaveCount(0);
  data = await snapshot();
  samples = data.samples.filter((entry) => entry.groupId === group.id);
  expect(samples).toHaveLength(2);
  expect(samples[1].parameters.name).toBeUndefined();
  const fieldRow = page.getByRole('region', { name: '现场规划表' }).locator('tbody tr', {
    has: page.locator('code', { hasText: samples[1].code }),
  });
  await expect(fieldRow.locator('td').nth(3)).toContainText('待安排草稿组');
  await expect(fieldRow.locator('td').nth(3)).not.toContainText(`待安排草稿组-${freshCode}`);

  // A second specimen cannot use a code that looks like a repeat of the first one.
  const newGroup = await openQuickAdd();
  await newGroup.getByText('更多信息 · 制备、条件与备注', { exact: true }).click();
  await newGroup.getByLabel('编号前缀').fill('Q-1-');
  await expect(newGroup.getByRole('alert')).toContainText('可能混淆');
  await expect(
    newGroup.getByRole('button', { name: '添加并安排测试', exact: true }),
  ).toBeDisabled();
  await newGroup.getByRole('button', { name: '关闭对话框' }).click();
  await newGroup.getByRole('alertdialog').getByRole('button', { name: '放弃填写' }).click();
  await expect(newGroup).toHaveCount(0);

  await groupRow.getByRole('button', { name: '安排测试', exact: true }).click();
  const conflict = page.getByRole('dialog', { name: '安排待测样品' });
  const conflictCode = (
    await conflict.locator('.specimen-plan li code').first().innerText()
  ).trim();
  await conflict.getByLabel(`${conflictCode} 自定编号`, { exact: true }).fill('Q-1-2');
  await expect(conflict.getByRole('alert')).toContainText('可能混淆');
  await expect(conflict.getByRole('button', { name: '加入待测队列', exact: true })).toBeDisabled();
});

test('Ctrl+Enter ignores key repeats and IME composition then saves once', async () => {
  const before = await snapshot();
  const dialog = await openQuickAdd();
  const name = dialog.getByLabel('样品统称 *', { exact: true });
  await name.fill('键盘快捷添加');

  const prevented = await name.evaluate((input) => {
    const repeat = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    const composing = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(repeat);
    input.dispatchEvent(composing);
    return [repeat.defaultPrevented, composing.defaultPrevented];
  });
  expect(prevented).toEqual([true, true]);
  await expect(dialog.locator('form.quick-add-form')).toBeVisible();
  expect((await snapshot()).samples).toHaveLength(before.samples.length);
  await expect(name).toHaveValue('键盘快捷添加');

  await name.press('Control+Enter');
  await expect.poll(async () => (await snapshot()).samples.length).toBe(before.samples.length + 1);
  await expect(name).toHaveValue('');
  expect((await snapshot()).samples).toHaveLength(before.samples.length + 1);
  await name.fill('下一组尚未保存');
  await name.press('Escape');
  const prompt = dialog.getByRole('alertdialog', { name: '放弃这次样品填写？' });
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: '继续填写' }).click();
  await expect(name).toHaveValue('下一组尚未保存');
  expect((await snapshot()).samples).toHaveLength(before.samples.length + 1);
});
