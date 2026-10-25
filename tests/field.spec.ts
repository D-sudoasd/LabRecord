import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Command, Snapshot } from '../src/shared/model.js';
import { recordedClock } from '../src/shared/recordedTime.js';
import { runDurationLabel } from '../src/shared/duration.js';
import { PNG } from './helpers.js';

const require = createRequire(import.meta.url);
let application: ElectronApplication, page: Page, directory: string, errors: string[];
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'labrecord-field-'));
  const env = { ...process.env, LABRECORD_TEST_MODE: '1', LABRECORD_TEST_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({
    executablePath: process.env.LABRECORD_EXECUTABLE || require('electron'),
    args: process.env.LABRECORD_EXECUTABLE ? [] : [process.cwd()],
    env,
  });
  page = await application.firstWindow();
  errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.locator('.loading-screen')).toHaveCount(0);
  await expect(page.locator('.app-header')).toBeVisible();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
  await page.getByRole('button', { name: '载入演示实验' }).click();
  await page.getByRole('button', { name: '进入现场记录' }).click();
});
test.afterEach(async ({}, info) => {
  if (application?.process()?.exitCode === null) {
    if (info.status !== info.expectedStatus)
      await page.screenshot({ path: info.outputPath('field-failure.png') }).catch(() => {});
    // Release test-only holds so the application's real close/flush handshake can finish.
    await application.evaluate(() => {
      const state = globalThis as any;
      state.fieldFault = false;
      state.fieldRelease?.();
      state.fieldNativeRelease?.();
    });
    await application.close();
  }
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
    !directory.split(sep).pop()?.startsWith('labrecord-field-')
  )
    throw new Error('Unexpected field test directory');
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
  return page.evaluate(async (command) => {
    const reply = await window.labrecord.command(command, crypto.randomUUID());
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  }, input);
}
async function start() {
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  await expect(page.getByRole('button', { name: '完成并切换下一项' })).toBeEnabled();
  return (await snapshot()).runs[0];
}
async function capture(path: string) {
  await page.locator('.app-rail nav button').evaluateAll(async (buttons) => {
    const transitions = buttons
      .flatMap((button) => button.getAnimations())
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(transitions.map((transition) => transition.finished.catch(() => {})));
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const png = await application.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return image.toPNG().toString('base64');
  });
  await writeFile(path, Buffer.from(png, 'base64'));
}
async function intercept(
  mode: 'before-write' | 'lost-reply' | 'observe',
  type: string,
  eventType?: string,
) {
  await application.evaluate(
    ({ ipcMain }, { mode, type, eventType }) => {
      const original = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => any> }
      )._invokeHandlers.get('command');
      if (!original) throw new Error('Original IPC handler unavailable');
      const state = globalThis as any;
      state.fieldCalls = [];
      state.fieldFault = mode !== 'observe';
      ipcMain.removeHandler('command');
      ipcMain.handle('command', async (...args) => {
        const [, input, requestId] = args;
        state.fieldCalls.push({ command: JSON.parse(JSON.stringify(input)), requestId });
        const selected = input?.type === type && (!eventType || input.eventType === eventType);
        if (selected && state.fieldFault && mode === 'before-write')
          return { ok: false, error: '现场测试：写入前失败' };
        const result = await original(...args);
        if (selected && state.fieldFault && mode === 'lost-reply') {
          if (!result.ok) throw new Error('Expected a successful real database write');
          return { ok: false, error: '现场测试：已写入但响应丢失' };
        }
        return result;
      });
    },
    { mode, type, eventType },
  );
}
async function calls() {
  return application.evaluate(
    () => (globalThis as any).fieldCalls as { command: Command; requestId: string }[],
  );
}
async function stopFault() {
  await application.evaluate(() => {
    (globalThis as any).fieldFault = false;
  });
}
async function holdCommand(type: string) {
  await application.evaluate(({ ipcMain }, type) => {
    const original = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => any> }
    )._invokeHandlers.get('command');
    if (!original) throw new Error('Original IPC handler unavailable');
    const state = globalThis as any;
    state.fieldHeld = false;
    let held = false;
    ipcMain.removeHandler('command');
    ipcMain.handle('command', async (...args) => {
      if (args[1]?.type === type && !held) {
        held = true;
        state.fieldHeld = true;
        await new Promise<void>((resolve) => {
          state.fieldRelease = resolve;
        });
      }
      return original(...args);
    });
  }, type);
}
async function waitHeld() {
  await expect
    .poll(() => application.evaluate(() => Boolean((globalThis as any).fieldHeld)))
    .toBe(true);
}
async function releaseCommand() {
  await application.evaluate(() => (globalThis as any).fieldRelease());
}
async function holdFiles(paths: string[]) {
  await application.evaluate(({ dialog }, paths) => {
    const state = globalThis as any;
    state.fieldNativeHeld = false;
    dialog.showOpenDialog = (async () => {
      state.fieldNativeHeld = true;
      await new Promise<void>((resolve) => {
        state.fieldNativeRelease = resolve;
      });
      return { canceled: false, filePaths: paths };
    }) as typeof dialog.showOpenDialog;
  }, paths);
}
async function waitFiles() {
  await expect
    .poll(() => application.evaluate(() => Boolean((globalThis as any).fieldNativeHeld)))
    .toBe(true);
}

for (const mode of ['before-write', 'lost-reply'] as const) {
  test(`quick record: ${mode}, free-note flush, rapid click and navigation retry preserve one intent`, async () => {
    const run = await start();
    await intercept(mode, 'addEvent', 'note');
    await page.getByLabel('现场备注', { exact: true }).fill('自由备注原文，快记不得覆盖');
    await page.getByRole('button', { name: '快速记录：已装样', exact: true }).dblclick();
    await expect(page.locator('.quick-record-bar.failed')).toContainText('已装样');
    const beforeRetry = await snapshot();
    expect(beforeRetry.runs[0].notes).toBe('自由备注原文，快记不得覆盖');
    expect(beforeRetry.events.filter((e) => e.text === '已装样')).toHaveLength(
      mode === 'lost-reply' ? 1 : 0,
    );
    await page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true }).click();
    await expect
      .poll(async () => (await calls()).filter((c) => c.command.type === 'addEvent').length)
      .toBeGreaterThanOrEqual(2);
    await expect(page.locator('.current-heading h2')).toHaveText('TA-01');
    await page.keyboard.press('Control+1');
    await expect
      .poll(async () => (await calls()).filter((c) => c.command.type === 'addEvent').length)
      .toBeGreaterThanOrEqual(3);
    await expect(page.locator('.live-page')).toBeVisible();
    const failed = (await calls()).filter((c) => c.command.type === 'addEvent');
    expect(failed.length).toBeGreaterThanOrEqual(3);
    expect(new Set(failed.map((c) => c.requestId)).size).toBe(1);
    for (const attempt of failed) expect(attempt.command).toEqual(failed[0].command);
    const ordered = await calls();
    expect(ordered.findIndex((c) => c.command.type === 'saveRun')).toBeLessThan(
      ordered.findIndex((c) => c.command.type === 'addEvent'),
    );
    await stopFault();
    await page.keyboard.press('Control+3');
    await expect(page.locator('.review-page')).toBeVisible();
    const saved = await snapshot();
    expect(saved.events.filter((e) => e.text === '已装样')).toHaveLength(1);
    const event = saved.events.find((e) => e.text === '已装样')!;
    expect([event.itemId, event.runId]).toEqual([run.itemId, run.id]);
    expect(saved.runs[0].notes).toBe('自由备注原文，快记不得覆盖');
    expect(saved.runs[0].snapshot).toEqual(run.snapshot);
    expect(saved.runs[0].originalStartedAt).toBe(run.originalStartedAt);
    expect(saved.runs[0].originalEndedAt).toBeNull();
    expect(
      new Set((await calls()).filter((c) => c.command.type === 'addEvent').map((c) => c.requestId))
        .size,
    ).toBe(1);
    await expect(page.locator('.save-indicator')).toContainText('已保存到本机');
  });
}

test('rapid recording clicks keep one start, one quick note and one finish without starting the next sample', async () => {
  await page.getByRole('button', { name: '开始操作', exact: true }).dblclick();
  await expect(page.getByRole('button', { name: '完成并切换下一项' })).toBeEnabled();
  const started = await snapshot();
  expect(started.runs).toHaveLength(1);
  expect(started.events.filter((e) => e.type === 'start')).toHaveLength(1);
  expect(started.runs[0].endedAt).toBeNull();
  await page.getByRole('button', { name: '快速记录：数据待检查', exact: true }).dblclick();
  await expect
    .poll(async () => (await snapshot()).events.filter((e) => e.text === '本次数据待检查。').length)
    .toBe(1);
  await page.getByRole('button', { name: '完成并切换下一项' }).dblclick();
  await expect(page.locator('.current-heading h2')).toHaveText('TA-02');
  await expect(page.getByRole('button', { name: '开始操作', exact: true })).toBeEnabled();
  const ended = await snapshot();
  expect(ended.runs).toHaveLength(1);
  expect(ended.events.filter((e) => e.type === 'finish')).toHaveLength(1);
  expect(ended.items.filter((i) => i.status === 'running')).toHaveLength(0);
  expect(ended.items.filter((i) => i.status === 'pending')).toHaveLength(3);
});

test('issue templates and custom text survive Cancel, Escape, close and page changes without creating an unsubmitted event', async () => {
  await page.getByRole('button', { name: '记录问题', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '记录现场问题' });
  await dialog.getByRole('button', { name: '信号待检查', exact: true }).click();
  await expect(dialog.getByLabel('发生了什么？')).toHaveValue('信号异常，原因待检查。');
  await dialog.getByLabel('问题类别').selectOption('设备异常');
  await dialog.getByLabel('发生了什么？').fill('信号异常，原因待检查。另需核对探测器连接。');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  for (const close of ['Escape', '关闭对话框'] as const) {
    await page.getByRole('button', { name: '记录问题', exact: true }).click();
    await expect(dialog.getByLabel('发生了什么？')).toHaveValue(
      '信号异常，原因待检查。另需核对探测器连接。',
    );
    await expect(dialog.getByLabel('问题类别')).toHaveValue('设备异常');
    await expect(dialog.getByRole('button', { name: '信号待检查', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    if (close === 'Escape') await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: close }).click();
  }
  await page.keyboard.press('Control+1');
  await expect(page.locator('.plan-page')).toBeVisible();
  await page.keyboard.press('Control+2');
  await page.getByRole('button', { name: '记录问题', exact: true }).click();
  await expect(dialog.getByLabel('发生了什么？')).toHaveValue(
    '信号异常，原因待检查。另需核对探测器连接。',
  );
  const beforeSubmit = await snapshot();
  expect(beforeSubmit.events.filter((e) => e.type === 'issue')).toHaveLength(0);
  expect(beforeSubmit.runs).toHaveLength(0);
  await dialog.getByRole('button', { name: '保存问题记录' }).click();
  await expect(dialog).toHaveCount(0);
  const issue = (await snapshot()).events.find((e) => e.type === 'issue')!;
  expect(issue.data.category).toBe('设备异常');
  expect(issue.runId).toBeNull();
  expect(issue.itemId).toBe(beforeSubmit.items[0].id);
  expect(issue.data.resolvedAt).toBeNull();
  await page.getByRole('button', { name: '记录问题', exact: true }).click();
  await expect(dialog.getByLabel('发生了什么？')).toHaveValue('');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
});

for (const mode of ['before-write', 'lost-reply'] as const) {
  test(`submitted issue: ${mode} retains its payload and request ID across closing and retry`, async () => {
    const run = await start();
    await intercept(mode, 'addEvent', 'issue');
    await page.getByRole('button', { name: '记录问题', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '记录现场问题' });
    await dialog.getByRole('button', { name: '装样待检查', exact: true }).click();
    await dialog.getByRole('button', { name: '保存问题记录' }).click();
    await expect(dialog.getByRole('button', { name: '重试此记录' })).toBeEnabled();
    await expect(dialog.getByLabel('发生了什么？')).toHaveValue('装样位置或方向待检查。');
    await expect(dialog.getByLabel('发生了什么？')).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '记录问题', exact: true }).click();
    await expect(dialog.getByLabel('问题类别')).toHaveValue('装样问题');
    await expect(dialog.getByRole('button', { name: '装样待检查', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.keyboard.press('Control+1');
    await expect(page.locator('.live-page')).toBeVisible();
    expect((await snapshot()).events.filter((e) => e.type === 'issue')).toHaveLength(
      mode === 'lost-reply' ? 1 : 0,
    );
    await stopFault();
    await page.getByRole('button', { name: '记录问题', exact: true }).click();
    await dialog.getByRole('button', { name: '重试此记录' }).click();
    await expect(dialog).toHaveCount(0);
    const issues = (await snapshot()).events.filter((e) => e.type === 'issue');
    expect(issues).toHaveLength(1);
    expect([issues[0].itemId, issues[0].runId]).toEqual([run.itemId, run.id]);
    const attempts = (await calls()).filter((c) => c.command.type === 'addEvent');
    expect(attempts.length).toBeGreaterThanOrEqual(3);
    expect(new Set(attempts.map((c) => c.requestId)).size).toBe(1);
    for (const attempt of attempts) expect(attempt.command).toEqual(attempts[0].command);
    await page.getByRole('button', { name: '记录问题', exact: true }).click();
    await expect(dialog.getByLabel('发生了什么？')).toHaveValue('');
    await page.keyboard.press('Escape');
  });
}

for (const issue of [false, true]) {
  test(`delayed completion keeps the opened ${issue ? 'issue' : 'note'} dialog on the original item/run and blocks every close path while saving`, async () => {
    const run = await start();
    await holdCommand('finish');
    await page.getByRole('button', { name: '完成并切换下一项' }).click();
    await waitHeld();
    await page
      .getByRole('button', { name: issue ? '记录问题' : '添加时间线记录', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: issue ? '记录现场问题' : '添加时间线记录' });
    await expect(dialog.locator('.dialog-target')).toContainText('TA-01');
    if (issue) await dialog.getByRole('button', { name: '信号待检查', exact: true }).click();
    else await dialog.getByLabel('记录内容').fill('完成返回前打开的记录');
    await releaseCommand();
    await expect(page.locator('.current-heading h2')).toHaveText('TA-02');
    await expect(dialog.locator('.dialog-target')).toContainText('TA-01');
    await holdCommand('addEvent');
    await dialog
      .getByRole('button', { name: issue ? '保存问题记录' : '添加记录', exact: true })
      .click();
    await waitHeld();
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '关闭对话框' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await releaseCommand();
    await expect(dialog).toHaveCount(0);
    const data = await snapshot();
    const event = data.events.find((e) => e.type === (issue ? 'issue' : 'note'))!;
    expect([event.experimentId, event.itemId, event.runId]).toEqual([
      run.experimentId,
      run.itemId,
      run.id,
    ]);
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].snapshot).toEqual(run.snapshot);
    expect(data.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  });
}

test('time dialog survives delayed completion, disables Cancel/Escape while saving and uses the same fixed interface from Review', async () => {
  const run = await start();
  await holdCommand('finish');
  await page.getByRole('button', { name: '完成并切换下一项' }).click();
  await waitHeld();
  await page.getByRole('button', { name: '修正时间', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修正起止时间' });
  await releaseCommand();
  await expect(page.locator('.current-heading h2')).toHaveText('TA-02');
  const finished = (await snapshot()).runs[0];
  const end = await page.evaluate((time) => {
    const date = new Date(Date.parse(time!) + 60000);
    // datetime-local canonicalizes zero seconds to minute precision in Chromium.
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 19)
      .replace(/:00$/, '');
  }, run.startedAt);
  await expect(dialog.locator('.dialog-target')).toContainText('TA-01');
  await dialog.getByLabel('结束时间', { exact: true }).fill(end);
  await dialog.getByLabel('修改说明（可选）').fill('按独立合成日志修正');
  await holdCommand('times');
  await dialog.getByRole('button', { name: '保存时间记录' }).click();
  await waitHeld();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '关闭对话框' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await releaseCommand();
  await expect(dialog).toHaveCount(0);
  const saved = (await snapshot()).runs[0];
  expect(saved.originalStartedAt).toBe(finished.originalStartedAt);
  expect(saved.originalEndedAt).toBe(finished.originalEndedAt);
  expect(saved.snapshot).toEqual(finished.snapshot);
  expect(Date.parse(saved.endedAt!) - Date.parse(saved.startedAt!)).toBeGreaterThanOrEqual(59000);
  expect((await snapshot()).runs).toHaveLength(1);
  await page.keyboard.press('Control+3');
  await page
    .locator('.review-table tbody tr')
    .filter({ hasText: 'TA-01' })
    .getByRole('button', { name: '时间', exact: true })
    .click();
  await expect(dialog.locator('.dialog-target')).toContainText('TA-01');
  await expect(dialog.getByLabel('结束时间', { exact: true })).toHaveValue(end);
  await page.keyboard.press('Escape');
});

test('native file selection merges the latest typed references and retains the original run after sample navigation', async () => {
  const run = await start();
  const file = join(directory, '仪器原始数据.txt');
  await writeFile(file, 'synthetic reference only');
  await page.getByText('实际参数与数据文件', { exact: true }).click();
  await intercept('observe', 'saveRun');
  await page.getByLabel('数据文件引用', { exact: true }).fill('刚输入的路径A');
  await holdFiles([file]);
  await page.getByRole('button', { name: '选择数据文件', exact: true }).click();
  await waitFiles();
  expect(
    (await calls()).some(
      (c) => c.command.type === 'saveRun' && c.command.actual?.files === '刚输入的路径A',
    ),
  ).toBe(true);
  await page.getByLabel('数据文件引用', { exact: true }).fill('刚输入的路径A\n选择期间输入的路径B');
  await page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true }).click();
  await application.evaluate(() => (globalThis as any).fieldNativeRelease());
  await expect(page.locator('.current-heading h2')).toHaveText('TA-02');
  await expect
    .poll(async () => (await snapshot()).runs[0].actual.files)
    .toBe(`刚输入的路径A\n选择期间输入的路径B\n${file}`);
  const saved = await snapshot();
  expect(saved.runs).toHaveLength(1);
  expect(saved.runs[0].id).toBe(run.id);
  expect(saved.runs[0].snapshot).toEqual(run.snapshot);
});

test('delayed native picture selection remains attached to the originally viewed run after completion', async () => {
  const run = await start();
  await page.getByRole('button', { name: '完成并切换下一项' }).click();
  await expect(page.locator('.current-heading h2')).toHaveText('TA-02');
  await page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true }).click();
  await page.getByLabel('现场备注', { exact: true }).fill('图片选择前的补充');
  await expect(page.locator('.save-indicator')).toContainText('已保存到本机');
  const image = join(directory, '固定目标.png');
  await writeFile(image, PNG);
  await holdFiles([image]);
  await page.getByRole('button', { name: '添加图片', exact: true }).click();
  await waitFiles();
  await page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true }).click();
  await expect(page.locator('.current-heading h2')).toHaveText('TA-02');
  await application.evaluate(() => (globalThis as any).fieldNativeRelease());
  await expect.poll(async () => (await snapshot()).attachments.length).toBe(1);
  const saved = await snapshot();
  expect(saved.attachments[0].runId).toBe(run.id);
  expect(saved.runs[0].notes).toBe('图片选择前的补充');
  expect(saved.runs[0].snapshot).toEqual(run.snapshot);
  await expect(page.locator('.current-heading h2')).toHaveText('TA-02');
});

test('a picture can be removed without changing the recorded run', async () => {
  const run = await start();
  const image = join(directory, '要移除.png');
  const kept = join(directory, '要保留.png');
  await writeFile(image, PNG);
  await writeFile(kept, PNG);
  await application.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: paths,
    })) as typeof dialog.showOpenDialog;
  }, [image, kept]);
  await page.getByRole('button', { name: '添加图片', exact: true }).click();
  await expect.poll(async () => (await snapshot()).attachments.length).toBe(2);
  await page.getByRole('button', { name: '移除图片 要移除.png', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '移除现场图片' });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await snapshot()).attachments).toHaveLength(2);
  await page.getByRole('button', { name: '移除图片 要移除.png', exact: true }).click();
  await page.getByRole('button', { name: '确认移除', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '移除图片 要保留.png', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '移除图片 要移除.png', exact: true })).toHaveCount(0);
  const after = await snapshot();
  expect(after.attachments).toHaveLength(1);
  expect(after.attachments[0].name).toBe('要保留.png');
  expect(after.attachments[0].runId).toBe(run.id);
  expect(after.runs[0].snapshot).toEqual(run.snapshot);
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].startedAt).toBe(run.startedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.events.some((event) => event.text === '移除图片：要移除.png')).toBe(true);
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
  expect(after.groups.find((group) => group.id === run.snapshot.group.id)?.preparedCount).toBe(6);
});

test('search finds a started sample by an attached picture name', async () => {
  const run = await start();
  await command({ type: 'saveRun', runId: run.id, notes: '只写备注' });
  const image = join(directory, '装样照片.png');
  await writeFile(image, PNG);
  await application.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: paths,
    })) as typeof dialog.showOpenDialog;
  }, [image]);
  await page.getByRole('button', { name: '添加图片', exact: true }).click();
  await expect.poll(async () => (await snapshot()).attachments.length).toBe(1);
  const row = page.getByRole('button', { name: '选择样品 TA-01 操作 1' });
  await expect(row).toContainText('图片 装样照片.png');
  await expect(row).not.toContainText('只写备注');
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2' })).not.toContainText('装样照片');
  await page.getByLabel('搜索待测样品', { exact: true }).fill('装样照片');
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2' })).toHaveCount(0);
  await page.getByLabel('搜索待测样品', { exact: true }).fill('只写备注');
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toHaveCount(0);
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await expect(page.locator('.review-table tbody tr', { hasText: 'TA-01' }).locator('.review-pictures')).toContainText(
    '装样照片.png',
  );
  await page.getByLabel('搜索操作记录', { exact: true }).fill('装样照片');
  await expect(page.locator('.review-table tbody tr', { hasText: 'TA-01' })).toHaveCount(1);
  await expect(page.locator('.review-table tbody tr', { hasText: 'TA-02' })).toHaveCount(0);
  await page.locator('h1').click();
  await page.keyboard.press('Control+K');
  const library = page.getByRole('dialog', { name: '全库搜索' });
  await library.getByRole('combobox', { name: '全库搜索', exact: true }).fill('装样照片');
  await expect(library.getByRole('option', { name: /TA-01/ })).toContainText('图片');
  await page.keyboard.press('Escape');
  const after = await snapshot();
  expect(after.attachments).toHaveLength(1);
  expect(after.runs[0].snapshot).toEqual(run.snapshot);
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
});

test('review can open an attached picture without writing a record', async () => {
  const run = await start();
  const image = join(directory, '装样照片.png');
  await writeFile(image, PNG);
  await application.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: paths,
    })) as typeof dialog.showOpenDialog;
  }, [image]);
  await page.getByRole('button', { name: '添加图片', exact: true }).click();
  await expect.poll(async () => (await snapshot()).attachments.length).toBe(1);
  const before = await snapshot();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const pending = page.locator('.review-table tbody tr', { hasText: 'TA-02' });
  await expect(pending.getByRole('button', { name: '查看图片 TA-02 操作 2', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '查看图片 TA-01 操作 1', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '现场图片' });
  await expect(dialog.getByRole('img', { name: '装样照片.png', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const after = await snapshot();
  expect(after.attachments).toHaveLength(1);
  expect(after.attachments[0].name).toBe('装样照片.png');
  expect(after.attachments[0].runId).toBe(run.id);
  expect(after.events).toEqual(before.events);
  expect(after.runs[0].snapshot).toEqual(run.snapshot);
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].startedAt).toBe(run.startedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
});

test('review can correct an issue without changing its time or the run', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'addEvent',
    experimentId: initial.experiments[0].id,
    itemId: initial.items[0].id,
    runId: run.id,
    eventType: 'issue',
    text: '样品定位偏离',
    category: '装样问题',
  });
  const issue = (await snapshot()).events.find((event) => event.text === '样品定位偏离')!;
  await page.reload();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await page.getByRole('button', { name: '修改问题：样品定位偏离', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修改问题' });
  await expect(dialog.getByLabel('问题内容', { exact: true })).toHaveValue('样品定位偏离');
  await dialog.getByLabel('问题内容', { exact: true }).fill('样品已重新装正');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByText('样品定位偏离', { exact: true })).toBeVisible();
  expect((await snapshot()).events.find((event) => event.id === issue.id)?.text).toBe('样品定位偏离');
  await page.getByRole('button', { name: '修改问题：样品定位偏离', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '修改问题' });
  await editor.getByLabel('问题内容', { exact: true }).fill('   ');
  await expect(editor.getByRole('button', { name: '保存问题', exact: true })).toBeDisabled();
  await editor.getByLabel('问题内容', { exact: true }).fill('样品已重新装正');
  await editor.getByRole('button', { name: '保存问题', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByText('样品已重新装正', { exact: true })).toBeVisible();
  await expect(page.getByText('曾写 样品定位偏离', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '实验概览', exact: true }).click();
  const overview = page.getByRole('dialog', { name: '实验概览' });
  await expect(overview.getByRole('article', { name: '问题：样品已重新装正' })).toContainText(
    '曾写 样品定位偏离',
  );
  await overview.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await page.getByLabel('搜索待测样品', { exact: true }).fill('样品定位偏离');
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toHaveCount(0);
  const after = await snapshot();
  const edited = after.events.find((event) => event.id === issue.id)!;
  expect(edited.text).toBe('样品已重新装正');
  expect(edited.createdAt).toBe(issue.createdAt);
  expect(edited.data.resolvedAt).toBeNull();
  expect(edited.data.category).toBe('装样问题');
  expect(edited.data.previousText).toEqual(['样品定位偏离']);
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].snapshot).toEqual(run.snapshot);
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the live timeline shows and corrects an earlier issue wording', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'addEvent',
    experimentId: initial.experiments[0].id,
    itemId: initial.items[0].id,
    runId: run.id,
    eventType: 'issue',
    text: '样品定位偏离',
    category: '装样问题',
  });
  const issue = (await snapshot()).events.find((event) => event.text === '样品定位偏离')!;
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  const timeline = page.locator('.timeline-panel');
  await expect(timeline).toContainText('样品定位偏离');
  await expect(timeline).not.toContainText('曾写');
  await timeline.getByRole('button', { name: '在时间线修改问题：样品定位偏离', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修改问题' });
  await dialog.getByLabel('问题内容', { exact: true }).fill('样品已重新装正');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect((await snapshot()).events.find((event) => event.id === issue.id)?.text).toBe('样品定位偏离');
  await timeline.getByRole('button', { name: '在时间线修改问题：样品定位偏离', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '修改问题' });
  await editor.getByLabel('问题内容', { exact: true }).fill('样品已重新装正');
  await editor.getByRole('button', { name: '保存问题', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(timeline).toContainText('样品已重新装正');
  await expect(timeline).toContainText('曾写 样品定位偏离');
  await page.getByLabel('搜索待测样品', { exact: true }).fill('样品定位偏离');
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toHaveCount(0);
  const after = await snapshot();
  const edited = after.events.find((event) => event.id === issue.id)!;
  expect(edited.text).toBe('样品已重新装正');
  expect(edited.createdAt).toBe(issue.createdAt);
  expect(edited.data.resolvedAt).toBeNull();
  expect(edited.data.previousText).toEqual(['样品定位偏离']);
  expect(after.runs[0].snapshot).toEqual(run.snapshot);
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
});

test('the live timeline can correct a quick note without changing the record note', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  await page.getByLabel('现场备注', { exact: true }).fill('自由备注保留');
  await expect(page.locator('.save-indicator')).toContainText('已保存到本机');
  await page.getByRole('button', { name: '快速记录：已装样', exact: true }).click();
  const timeline = page.locator('.timeline-panel');
  await expect(timeline).toContainText('已装样');
  const note = (await snapshot()).events.find((event) => event.text === '已装样')!;
  await timeline.getByRole('button', { name: '在时间线修改记录：已装样', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修改时间线记录' });
  await dialog.getByLabel('记录内容', { exact: true }).fill('装样方向已核对');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect((await snapshot()).events.find((event) => event.id === note.id)?.text).toBe('已装样');
  await timeline.getByRole('button', { name: '在时间线修改记录：已装样', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '修改时间线记录' });
  await editor.getByLabel('记录内容', { exact: true }).fill('   ');
  await expect(editor.getByRole('button', { name: '保存记录', exact: true })).toBeDisabled();
  await editor.getByLabel('记录内容', { exact: true }).fill('装样方向已核对');
  await editor.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(timeline).toContainText('装样方向已核对');
  await expect(timeline).toContainText('曾写 已装样');
  await page.getByLabel('搜索待测样品', { exact: true }).fill('已装样');
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toHaveCount(0);
  const after = await snapshot();
  const edited = after.events.find((event) => event.id === note.id)!;
  expect(edited.text).toBe('装样方向已核对');
  expect(edited.createdAt).toBe(note.createdAt);
  expect(edited.data.previousText).toEqual(['已装样']);
  expect(after.runs[0].notes).toBe('自由备注保留');
  expect(after.runs[0].snapshot).toEqual(run.snapshot);
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
});

test('review history shows the earlier timeline wording without rewriting it', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'addEvent',
    experimentId: initial.experiments[0].id,
    itemId: initial.items[0].id,
    runId: run.id,
    eventType: 'note',
    text: '已装样',
  });
  const note = (await snapshot()).events.find((event) => event.text === '已装样')!;
  await command({ type: 'editNote', eventId: note.id, text: '装样方向已核对' });
  await page.reload();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await page
    .locator('.review-table tbody tr', { hasText: 'TA-01' })
    .getByRole('button', { name: '历史', exact: true })
    .click();
  const history = page.getByRole('dialog', { name: '记录与修改历史' });
  await expect(history).toContainText('装样方向已核对');
  await expect(history).toContainText('曾写 已装样');
  await expect(history).not.toContainText('previousText');
  await history.getByRole('button', { name: '关闭对话框', exact: true }).click();
  const after = await snapshot();
  const edited = after.events.find((event) => event.id === note.id)!;
  expect(edited.text).toBe('装样方向已核对');
  expect(edited.createdAt).toBe(note.createdAt);
  expect(edited.data.previousText).toEqual(['已装样']);
  expect(after.runs[0].notes).toBe('');
  expect(after.runs[0].snapshot).toEqual(run.snapshot);
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
});

test('a retest shows an unresolved issue from the original operation', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'addEvent',
    experimentId: initial.experiments[0].id,
    itemId: initial.items[0].id,
    runId: run.id,
    eventType: 'issue',
    text: '样品定位偏离',
  });
  await command({ type: 'saveRun', runId: run.id, notes: '只写备注' });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const finished = (await snapshot()).runs[0];
  await command({ type: 'repeat', itemId: initial.items[0].id });
  const retest = (await snapshot()).items.find((item) => item.repeatOf === initial.items[0].id)!;
  await page.reload();
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  const choice = page.getByRole('button', {
    name: `选择样品 TA-01 操作 ${retest.order + 1}`,
    exact: true,
  });
  await expect(choice).toContainText('原操作未处理问题：样品定位偏离');
  await expect(choice).not.toContainText('只写备注');
  await choice.click();
  const source = page.getByRole('region', { name: '重测来源', exact: true });
  await expect(source).toContainText('原操作未处理问题：样品定位偏离');
  await expect(source).not.toContainText('只写备注');
  await page.getByLabel('搜索待测样品', { exact: true }).fill('样品定位偏离');
  await expect(
    page.getByRole('button', { name: `选择样品 TA-01 操作 ${retest.order + 1}` }),
  ).toHaveCount(0);
  await page.getByLabel('搜索待测样品', { exact: true }).fill('');
  const issue = (await snapshot()).events.find((event) => event.text === '样品定位偏离')!;
  await command({ type: 'resolveIssue', eventId: issue.id });
  await page.reload();
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await expect(
    page.getByRole('button', { name: `选择样品 TA-01 操作 ${retest.order + 1}`, exact: true }),
  ).not.toContainText('原操作未处理问题');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].snapshot).toEqual(finished.snapshot);
  expect(after.runs[0].originalStartedAt).toBe(finished.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(finished.originalEndedAt);
  expect(after.items.find((item) => item.id === retest.id)?.status).toBe('pending');
  expect(after.items.filter((item) => item.repeatOf === initial.items[0].id)).toHaveLength(1);
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the next pending brief names an unresolved issue on a retest', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'addEvent',
    experimentId: initial.experiments[0].id,
    itemId: initial.items[0].id,
    runId: run.id,
    eventType: 'issue',
    text: '样品定位偏离',
  });
  await command({ type: 'saveRun', runId: run.id, notes: '只写备注' });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const finished = (await snapshot()).runs[0];
  for (const item of initial.items.slice(1)) await command({ type: 'skip', itemId: item.id });
  await command({ type: 'repeat', itemId: initial.items[0].id });
  await page.reload();
  const next = page.getByRole('region', { name: '下一项待测', exact: true });
  await expect(next).toContainText('原操作未处理问题：样品定位偏离');
  await expect(next).toContainText('重测自');
  await expect(next).not.toContainText('只写备注');
  await page.locator('h1').click();
  await page.keyboard.press('Control+K');
  const library = page.getByRole('dialog', { name: '全库搜索' });
  await expect(library.getByRole('option', { name: '查看下一项 TA-01', exact: true })).toContainText(
    '原操作未处理问题：样品定位偏离',
  );
  await page.keyboard.press('Escape');
  const issue = (await snapshot()).events.find((event) => event.text === '样品定位偏离')!;
  await command({ type: 'resolveIssue', eventId: issue.id });
  await page.reload();
  await expect(page.getByRole('region', { name: '下一项待测', exact: true })).not.toContainText(
    '原操作未处理问题',
  );
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].snapshot).toEqual(finished.snapshot);
  expect(after.runs[0].originalStartedAt).toBe(finished.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(finished.originalEndedAt);
  expect(after.items.find((item) => item.repeatOf === initial.items[0].id)?.status).toBe('pending');
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the next pending brief opens the original operation without starting the retest', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'addEvent',
    experimentId: initial.experiments[0].id,
    itemId: initial.items[0].id,
    runId: run.id,
    eventType: 'issue',
    text: '样品定位偏离',
  });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const finished = (await snapshot()).runs[0];
  for (const item of initial.items.slice(1)) await command({ type: 'skip', itemId: item.id });
  await command({ type: 'repeat', itemId: initial.items[0].id });
  const retest = (await snapshot()).items.find((item) => item.repeatOf === initial.items[0].id)!;
  await page.reload();
  const next = page.getByRole('region', { name: '下一项待测', exact: true });
  await next.getByRole('button', { name: '查看下一项的原操作 TA-01', exact: true }).click();
  await expect(page.locator('.live-page')).toBeVisible();
  await expect(page.locator('.current-heading')).toContainText('已完成');
  await expect(page.locator('.current-heading')).toContainText('TA-01');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].id).toBe(finished.id);
  expect(after.runs[0].snapshot).toEqual(finished.snapshot);
  expect(after.runs[0].originalStartedAt).toBe(finished.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(finished.originalEndedAt);
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('completed');
  expect(after.items.find((item) => item.id === retest.id)?.status).toBe('pending');
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the latest finished record names its own unresolved issue', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'addEvent',
    experimentId: initial.experiments[0].id,
    itemId: initial.items[0].id,
    runId: run.id,
    eventType: 'issue',
    text: '样品定位偏离',
  });
  await command({ type: 'saveRun', runId: run.id, notes: '只写备注' });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const finished = (await snapshot()).runs[0];
  await page.reload();
  const recent = page.getByRole('region', { name: '最近记录', exact: true });
  await expect(recent).toContainText('未处理问题：样品定位偏离');
  await expect(recent).not.toContainText('只写备注');
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true }).click();
  await expect(page.getByRole('region', { name: '最近记录', exact: true })).toContainText(
    '未处理问题：样品定位偏离',
  );
  await page.getByLabel('搜索待测样品', { exact: true }).fill('样品定位偏离');
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toHaveCount(0);
  const issue = (await snapshot()).events.find((event) => event.text === '样品定位偏离')!;
  await command({ type: 'resolveIssue', eventId: issue.id });
  await page.reload();
  await expect(page.getByRole('region', { name: '最近记录', exact: true })).not.toContainText(
    '未处理问题',
  );
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].snapshot).toEqual(finished.snapshot);
  expect(after.runs[0].originalStartedAt).toBe(finished.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(finished.originalEndedAt);
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('completed');
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the experiment library opens the latest finished record without starting it', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'addEvent',
    experimentId: initial.experiments[0].id,
    itemId: initial.items[0].id,
    runId: run.id,
    eventType: 'issue',
    text: '样品定位偏离',
  });
  await command({ type: 'saveRun', runId: run.id, notes: '只写备注', actual: { scanId: 'SCAN-LAST-LIB' } });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const finished = (await snapshot()).runs[0];
  await page.reload();
  await page.locator('h1').click();
  await page.keyboard.press('Control+K');
  const library = page.getByRole('dialog', { name: '全库搜索' });
  const recent = library.getByRole('option', { name: '查看最近记录 TA-01', exact: true });
  await expect(recent).toContainText('未处理问题：样品定位偏离');
  await expect(recent).toContainText('SCAN-LAST-LIB');
  await expect(recent).toContainText(finished.filename);
  await expect(recent).not.toContainText('只写备注');
  await library.getByRole('combobox', { name: '全库搜索', exact: true }).fill('样品定位偏离');
  await expect(library.getByRole('option', { name: '查看最近记录 TA-01', exact: true })).toHaveCount(0);
  await expect(library.getByText('样品定位偏离')).toHaveCount(0);
  await library.getByRole('combobox', { name: '全库搜索', exact: true }).fill('');
  await library.getByRole('option', { name: '查看最近记录 TA-01', exact: true }).click();
  await expect(page.locator('.live-page')).toBeVisible();
  await expect(page.locator('.current-heading')).toContainText('已完成');
  await expect(page.locator('.current-heading')).toContainText('TA-01');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].snapshot).toEqual(finished.snapshot);
  expect(after.runs[0].originalStartedAt).toBe(finished.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(finished.originalEndedAt);
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('completed');
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('F8 ignores editing, inherited contenteditable, IME, dialogs, repeats and modifiers; ordinary Enter/Space buttons still record', async () => {
  await intercept('observe', 'start');
  await page.getByLabel('搜索待测样品', { exact: true }).focus();
  await page.keyboard.press('F8');
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'field-editable-test';
    host.innerHTML =
      '<input><textarea></textarea><select><option>A</option></select><div contenteditable=""><span>继承编辑</span></div><div contenteditable="plaintext-only"><span>纯文本编辑</span></div>';
    document.body.append(host);
    for (const target of host.querySelectorAll('input, textarea, select, span'))
      target.dispatchEvent(new KeyboardEvent('keydown', { code: 'F8', key: 'F8', bubbles: true }));
    const inherited = host.querySelectorAll('span');
    if (![...inherited].every((node) => node.isContentEditable))
      throw new Error('Browser did not enable inherited editing');
    host.remove();
    for (const options of [
      { repeat: true },
      { ctrlKey: true },
      { altKey: true },
      { shiftKey: true },
      { metaKey: true },
      { isComposing: true },
      { keyCode: 229 },
    ])
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'F8', key: 'F8', bubbles: true, ...options }),
      );
    document.body.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'F8', key: 'F8', bubbles: true }),
    );
    document.body.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });
  await page.getByRole('button', { name: '添加时间线记录', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).focus();
  await page.keyboard.press('F8');
  await page.keyboard.press('Escape');
  expect((await calls()).filter((c) => c.command.type === 'start')).toHaveLength(0);
  expect((await snapshot()).runs).toHaveLength(0);
  await page.getByRole('button', { name: '开始操作', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '完成并切换下一项' })).toBeEnabled();
  await page.evaluate(() =>
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'F8', key: 'F8', repeat: true, bubbles: true }),
    ),
  );
  expect((await snapshot()).items[0].status).toBe('running');
  await page.getByRole('button', { name: '完成并切换下一项' }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.current-heading h2')).toHaveText('TA-02');
  expect((await snapshot()).runs).toHaveLength(1);
  await expect(page.getByRole('button', { name: '开始操作', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '队列与搜索', exact: true }).focus();
  await page.keyboard.press('F8');
  await expect(page.locator('.current-heading')).toContainText('正在操作');
  expect((await snapshot()).runs).toHaveLength(2);
});

test('F8 cannot start during an in-flight command or while another sample or experiment is running', async () => {
  await intercept('observe', 'start');
  await holdCommand('start');
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  await waitHeld();
  await page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true }).click();
  await expect(page.locator('.current-heading h2')).toHaveText('TA-02');
  await page.keyboard.press('F8');
  await releaseCommand();
  await expect(page.locator('.current-heading h2')).toHaveText('TA-01');
  await expect(page.getByRole('button', { name: '完成并切换下一项' })).toBeEnabled();
  expect((await calls()).filter((c) => c.command.type === 'start')).toHaveLength(1);
  await page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始操作', exact: true })).toBeDisabled();
  await expect(page.locator('.current-heading')).toContainText('正在查看');
  await page.getByRole('button', { name: '队列与搜索', exact: true }).focus();
  await page.keyboard.press('F8');
  expect((await calls()).filter((c) => c.command.type === 'start')).toHaveLength(1);
  expect((await snapshot()).runs).toHaveLength(1);

  const other = await command({
    type: 'createExperiment',
    name: '合成演示：另一实验',
    code: 'OTHER',
  });
  const experimentId = other.experimentId!;
  const added = await command({
    type: 'addSamples',
    experimentId,
    patch: { name: '另一实验试样', preparedCount: 1 },
    count: 1,
    prefix: 'OTHER-',
  });
  const sample = added.snapshot.samples.find((s) => s.experimentId === experimentId)!;
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  await page.getByLabel('选择实验', { exact: true }).selectOption(experimentId);
  await expect(page.locator('.current-heading h2')).toHaveText(sample.code);
  await expect(page.getByRole('button', { name: '开始操作', exact: true })).toBeDisabled();
  await expect(page.locator('.running-banner')).toContainText('TA-01');
  await page.getByRole('button', { name: '队列与搜索', exact: true }).focus();
  await page.keyboard.press('F8');
  expect((await calls()).filter((c) => c.command.type === 'start')).toHaveLength(1);
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.items.find((i) => i.sampleId === sample.id)!.status).toBe('pending');
});

test('return-to-running navigation flushes and stays on the viewed sample when saving fails', async () => {
  const run = await start();
  const item = (await snapshot()).items[1];
  await command({
    type: 'times',
    itemId: item.id,
    startedAt: '2026-10-05T08:00:00.000Z',
    endedAt: '2026-10-05T08:01:00.000Z',
  });
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  await page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true }).click();
  const banner = page.getByRole('region', { name: '现场进行中的操作' });
  const clock = recordedClock(run.startedAt, run.offsetMinutes, run.timezone)!;
  await expect(banner).toContainText(run.filename);
  await expect(banner).toContainText(clock.clock);
  await expect(banner).toContainText(clock.zone);
  await banner.getByRole('button', { name: '复制进行中的数据文件夹', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(run.filename);
  await expect(page.locator('.current-heading h2')).toHaveText('TA-02');
  const copied = await snapshot();
  expect(copied.runs).toHaveLength(2);
  expect(copied.runs.find((entry) => entry.id === run.id)?.originalStartedAt).toBe(
    run.originalStartedAt,
  );
  await intercept('before-write', 'saveRun');
  await page.getByLabel('现场备注', { exact: true }).fill('返回进行中操作前仍需保存的文字');
  await page.getByRole('button', { name: '返回当前操作' }).click();
  await expect(page.locator('.save-indicator')).toContainText('保存失败');
  await expect(page.locator('.current-heading h2')).toHaveText('TA-02');
  await expect(page.getByLabel('现场备注', { exact: true })).toHaveValue(
    '返回进行中操作前仍需保存的文字',
  );
  await stopFault();
  await page.getByRole('button', { name: '返回当前操作' }).click();
  await expect(page.locator('.current-heading h2')).toHaveText('TA-01');
  const data = await snapshot();
  expect(data.runs.find((r) => r.itemId === item.id)!.notes).toBe('返回进行中操作前仍需保存的文字');
  expect(data.runs.find((r) => r.id === run.id)!.notes).toBe('');
});

test('next pending uses the whole reordered queue, including earlier and hidden samples, and completion only selects it', async () => {
  await page.getByRole('button', { name: '选择样品 TA-03 操作 3', exact: true }).click();
  await start();
  await page.getByLabel('搜索待测样品', { exact: true }).fill('TA-03');
  await expect(page.locator('.queue-row')).toHaveCount(1);
  await expect(page.locator('.next-pending-indicator')).toContainText('TA-01');
  await page.getByRole('button', { name: '清除搜索待测样品', exact: true }).click();
  await page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true }).click();
  await page.getByRole('button', { name: '向上调整顺序', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '选择样品 TA-02 操作 1', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '选择样品 TA-03 操作 3', exact: true }).click();
  await page.getByLabel('搜索待测样品', { exact: true }).fill('TA-03');
  await page
    .getByRole('group', { name: '队列筛选' })
    .getByRole('button', { name: '已完成', exact: true })
    .click();
  await expect(page.locator('.queue-row')).toHaveCount(0);
  await expect(page.locator('.next-pending-indicator')).toContainText('TA-02');
  await page.getByRole('button', { name: '完成并切换下一项' }).click();
  await expect(page.locator('.current-heading h2')).toHaveText('TA-02');
  await expect(page.getByRole('button', { name: '开始操作', exact: true })).toBeEnabled();
  const data = await snapshot();
  expect(
    data.items.filter((i) => i.status === 'pending').sort((a, b) => a.order - b.order)[0].sampleId,
  ).toBe(data.samples.find((s) => s.code === 'TA-02')!.id);
  expect(data.items.filter((i) => i.status === 'running')).toHaveLength(0);
  expect(data.runs).toHaveLength(1);
});

test('focus retains current controls, notes and header; real 900×700 zoom 1.5 reflows with accessible search, timeline and issues', async ({}, info) => {
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(page.locator('.plan-page')).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await capture(info.outputPath('combined-plan.png'));
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await page.getByRole('button', { name: '专注当前样品', exact: true }).click();
  await expect(page.locator('.live-page')).toHaveClass(/is-focused/);
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(900, 700);
    win.webContents.setZoomFactor(1.5);
  });
  await expect.poll(() => page.evaluate(() => matchMedia('(max-width: 650px)').matches)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator('.current-heading h2')).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: '开始操作', exact: true })).toBeInViewport({
    ratio: 1,
  });
  await capture(info.outputPath('focus-900-start.png'));
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.setZoomFactor(1);
    win.setSize(1440, 940);
  });
  await start();
  expect(
    await page
      .locator('.live-layout')
      .evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length),
  ).toBe(1);
  await expect(page.locator('.queue')).toHaveCount(0);
  await expect(page.locator('.timeline-desktop')).toBeHidden();
  for (const selector of ['.live-notes', '.quick-record-actions', '.operation-actions'])
    await expect(page.locator(selector)).toBeInViewport({ ratio: 1 });
  await page
    .getByLabel('现场备注', { exact: true })
    .fill('合成演示：装样位置待复核，仪器数据待检查。');
  await expect(page.locator('.save-indicator')).toContainText('已保存到本机');
  await capture(info.outputPath('focus-wide.png'));
  await page.getByRole('button', { name: '记录问题', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '数据文件待核对', exact: true })
    .click();
  await page.getByRole('button', { name: '保存问题记录' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveClass(/has-experiment-overview/);
  await page.locator('.overview-open').click();
  const wideOverview = page.getByRole('dialog', { name: '实验概览', exact: true });
  await expect(wideOverview).toBeVisible();
  await expect(wideOverview).toContainText('数据文件引用与操作编号待核对。');
  await expect(page.locator('html')).toHaveClass(/has-experiment-overview/);
  await capture(info.outputPath('combined-overview.png'));
  await wideOverview.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await expect(page.locator('html')).not.toHaveClass(/has-experiment-overview/);
  await expect(page.getByLabel('现场备注', { exact: true })).toHaveValue(
    '合成演示：装样位置待复核，仪器数据待检查。',
  );
  await page.getByRole('button', { name: '退出专注', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await capture(info.outputPath('combined-live.png'));
  await page.getByRole('button', { name: '专注当前样品', exact: true }).click();
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(900, 700);
    win.webContents.setZoomFactor(1.5);
  });
  await expect.poll(() => page.evaluate(() => matchMedia('(max-width: 650px)').matches)).toBe(true);
  expect(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
    ),
  ).toBe(1.5);
  const nativeSize = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getSize(),
  );
  // Keep the observed Windows frame rounding in the evidence; this is a real native size.
  expect(Math.abs(nativeSize[0] - 900)).toBeLessThanOrEqual(2);
  expect(Math.abs(nativeSize[1] - 700)).toBeLessThanOrEqual(2);
  await writeFile(
    info.outputPath('focus-runtime.json'),
    JSON.stringify(
      {
        requestedSize: [900, 700],
        nativeSize,
        zoom: 1.5,
        viewport: await page.evaluate(() => [innerWidth, innerHeight]),
      },
      null,
      2,
    ),
  );
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    .toBe(true);
  await expect(page.locator('.app-header')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.save-indicator')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.overview-open')).toBeInViewport({ ratio: 1 });
  await page.evaluate(() => window.scrollTo(0, 0));
  // These assertions deliberately run at the top, before any control is scrolled into view.
  await expect(page.locator('.current-heading h2')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.finish-button')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.quick-record-bar')).toBeInViewport({ ratio: 1 });
  await capture(info.outputPath('focus-900-top.png'));
  expect(
    await page
      .locator('.finish-button')
      .evaluate((button) => button.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(54);
  await page.getByLabel('现场备注', { exact: true }).fill('专注模式中的记录');
  await expect(page.locator('.current-heading h2')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.finish-button')).toBeInViewport({ ratio: 1 });
  await expect(page.getByLabel('现场备注', { exact: true })).toBeFocused();
  await capture(info.outputPath('focus-900-input.png'));
  await page.locator('.overview-open').click();
  const focusedOverview = page.getByRole('dialog', { name: '实验概览', exact: true });
  await expect(focusedOverview).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/has-experiment-overview/);
  await focusedOverview.getByRole('button', { name: '返回当前操作', exact: true }).click();
  await expect(focusedOverview).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveClass(/has-experiment-overview/);
  await expect(page.locator('.live-page')).toHaveClass(/is-focused/);
  await expect(page.locator('.current-heading h2')).toHaveText('TA-01');
  await expect(page.getByLabel('现场备注', { exact: true })).toHaveValue('专注模式中的记录');
  expect((await snapshot()).runs[0].notes).toBe('专注模式中的记录');
  await expect(page.locator('.finish-button')).toBeInViewport({ ratio: 1 });
  await page.getByText('实际参数与数据文件', { exact: true }).click();
  await page.getByLabel('数据文件引用', { exact: true }).scrollIntoViewIfNeeded();
  await expect(page.locator('.current-heading h2')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.save-indicator')).toBeInViewport({ ratio: 1 });
  await page.getByRole('button', { name: '队列与搜索', exact: true }).click();
  const queue = page.getByRole('dialog', { name: '待测队列与搜索' });
  await queue.getByLabel('搜索待测样品', { exact: true }).fill('TA-03');
  await expect(queue.locator('.queue-row')).toHaveCount(1);
  await queue.getByRole('button', { name: '选择样品 TA-03 操作 3', exact: true }).click();
  await expect(queue).toHaveCount(0);
  await expect(page.locator('.current-heading h2')).toHaveText('TA-03');
  await page.getByRole('button', { name: '返回当前操作' }).click();
  await expect(page.locator('.current-heading h2')).toHaveText('TA-01');
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await page
    .getByRole('dialog', { name: '更多现场操作' })
    .getByRole('button', { name: '时间线', exact: true })
    .click();
  await expect(page.locator('.timeline-drawer')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await page
    .getByRole('dialog', { name: '更多现场操作' })
    .getByRole('button', { name: '未处理问题（1）', exact: true })
    .click();
  const issues = page.getByRole('dialog', { name: '未处理的问题' });
  await expect(issues).toContainText('数据文件引用与操作编号待核对。');
  await expect(issues).toContainText('样品 TA-01');
  await page.keyboard.press('Escape');
  await capture(info.outputPath('focus-900-zoom-1.5.png'));
  await page.getByRole('button', { name: '退出专注', exact: true }).click();
  await expect(page.locator('.live-page')).not.toHaveClass(/is-focused/);
  await page.getByLabel('搜索待测样品', { exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByLabel('搜索待测样品', { exact: true })).toBeInViewport({ ratio: 1 });
  expect((await snapshot()).runs[0].notes).toBe('专注模式中的记录');
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.setZoomFactor(1);
    win.setSize(1440, 940);
  });
  await page.getByRole('button', { name: '完成并切换下一项', exact: true }).click();
  await expect(page.locator('.current-heading h2')).toHaveText('TA-02');
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await expect(page.locator('.review-page')).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await capture(info.outputPath('combined-review.png'));
});

test('Alt+Left and Alt+Right select adjacent operations in full order without starting them', async () => {
  const before = await snapshot();
  expect(before.runs).toHaveLength(0);
  const order = before.items.map((item) => `${item.id}:${item.order}:${item.status}`);
  await page.getByRole('button', { name: '专注当前样品', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.locator('.current-heading h2')).toHaveText('TA-02');

  await page.getByLabel('搜索待测样品', { exact: true }).focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.locator('.current-heading h2')).toHaveText('TA-02');

  await page.getByRole('button', { name: '专注当前样品', exact: true }).click();
  await expect(page.locator('aside.queue')).toHaveCount(0);
  await page.getByRole('button', { name: '退出专注', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.locator('.current-heading h2')).toHaveText('TA-03');

  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '更多现场操作' })).toBeVisible();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.locator('.current-heading h2')).toHaveText('TA-03');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '退出专注', exact: true }).click();
  await page.getByLabel('搜索待测样品', { exact: true }).fill('TA-01');
  await expect(page.locator('.queue-row')).toHaveCount(1);
  await page.getByRole('button', { name: '专注当前样品', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.locator('.current-heading h2')).toHaveText('TA-02');
  await expect(page.locator('.queue-row')).toHaveCount(1);
  await expect(page.locator('.queue-row')).toContainText('TA-01');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.locator('.current-heading h2')).toHaveText('TA-01');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.locator('.current-heading h2')).toHaveText('TA-01');

  const after = await snapshot();
  expect(after.runs).toHaveLength(0);
  expect(after.items.map((item) => `${item.id}:${item.order}:${item.status}`)).toEqual(order);
});

test('plan sample strip opens one operation and prefers a pending retest over the interrupted original', async () => {
  const initial = await snapshot();
  const first = initial.items[0];
  await command({ type: 'start', itemId: first.id });
  await command({ type: 'interrupt', itemId: first.id });
  const interrupted = (await snapshot()).runs[0];
  await command({ type: 'repeat', itemId: first.id });
  const data = await snapshot();
  const retest = data.items.find((item) => item.repeatOf === first.id)!;
  await page.reload();
  await expect(page.locator('.plan-page')).toBeVisible();
  await page.getByRole('button', { name: '展开 Ti-A-热处理' }).click();
  const strip = page.locator('.sample-strip', { hasText: 'TA-01' });
  await expect(page.locator('.sample-expansion-head')).toContainText('中断 1');
  await expect(
    strip.getByRole('button', { name: `查看 TA-01 操作 ${first.order + 1} 已中断`, exact: true }),
  ).toBeVisible();
  await expect(
    strip.getByRole('button', { name: `查看 TA-01 操作 ${retest.order + 1} 待测`, exact: true }),
  ).toBeVisible();
  await strip.getByRole('button', { name: '打开 TA-01 的当前操作', exact: true }).click();
  await expect(page.locator('.current-heading')).toContainText(
    `操作 ${String(retest.order + 1).padStart(2, '0')}`,
  );
  await expect(page.locator('.current-heading')).toContainText('下一步：开始');
  expect((await snapshot()).items.find((item) => item.id === retest.id)?.status).toBe('pending');
  expect((await snapshot()).runs).toHaveLength(1);

  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await page.getByRole('button', { name: '展开 Ti-A-热处理' }).click();
  await page
    .getByRole('button', { name: `查看 TA-01 操作 ${first.order + 1} 已中断`, exact: true })
    .click();
  await expect(page.locator('.current-heading')).toContainText(
    `操作 ${String(first.order + 1).padStart(2, '0')}`,
  );
  await expect(page.locator('.current-heading')).toContainText('已中断');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].originalStartedAt).toBe(interrupted.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(interrupted.originalEndedAt);
  expect(after.runs[0].snapshot.sample.id).toBe(interrupted.snapshot.sample.id);
  expect(after.items.find((item) => item.id === retest.id)?.status).toBe('pending');
  expect(after.items.find((item) => item.id === retest.id)?.sampleId).toBe(first.sampleId);
});

test('review status filter isolates interrupted and skipped operations without changing records', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const finished = (await snapshot()).runs[0];
  await command({ type: 'skip', itemId: initial.items[1].id });
  await command({ type: 'start', itemId: initial.items[2].id });
  await command({ type: 'interrupt', itemId: initial.items[2].id });
  const interrupted = (await snapshot()).runs.find((run) => run.itemId === initial.items[2].id)!;
  await page.reload();
  await expect(page.locator('.plan-page')).toBeVisible();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const rows = page.locator('.review-table tbody tr');
  await expect(rows).toHaveCount(4);
  const status = page.getByLabel('按状态筛选', { exact: true });
  await expect(status).toContainText('已中断（1）');
  await expect(status).toContainText('已跳过（1）');
  await status.selectOption('interrupted');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('TA-03');
  await page.getByLabel('搜索操作记录', { exact: true }).fill('TA-01');
  await expect(page.getByText('没有符合条件的记录')).toBeVisible();
  await page.locator('.review-followup').getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(rows).toHaveCount(4);
  await expect(status).toHaveValue('');
  await status.selectOption('skipped');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('TA-02');
  await rows.getByRole('button', { name: '查看', exact: true }).click();
  await expect(page.locator('.current-heading')).toContainText('TA-02');
  await expect(page.locator('.current-heading')).toContainText('已跳过');
  const after = await snapshot();
  expect(after.runs).toHaveLength(2);
  expect(after.items.find((item) => item.id === initial.items[1].id)?.status).toBe('skipped');
  expect(after.items.find((item) => item.id === initial.items[2].id)?.status).toBe('interrupted');
  expect(after.runs.find((run) => run.id === finished.id)?.originalEndedAt).toBe(
    finished.originalEndedAt,
  );
  expect(after.runs.find((run) => run.id === interrupted.id)?.originalEndedAt).toBe(
    interrupted.originalEndedAt,
  );
  expect(after.runs.find((run) => run.id === interrupted.id)?.snapshot).toEqual(interrupted.snapshot);
});

test('measurement plan status filter selects only the visible pending rows and leaves records unchanged', async () => {
  const initial = await snapshot();
  const order = initial.items.map((item) => `${item.id}:${item.order}`);
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const finished = (await snapshot()).runs[0];
  await command({ type: 'skip', itemId: initial.items[1].id });
  await command({ type: 'start', itemId: initial.items[2].id });
  await command({ type: 'interrupt', itemId: initial.items[2].id });
  const interrupted = (await snapshot()).runs.find((run) => run.itemId === initial.items[2].id)!;
  await page.reload();
  await expect(page.locator('.plan-page')).toBeVisible();
  const planner = page.getByRole('region', { name: '测量计划', exact: true });
  const rows = planner.locator('tbody tr');
  const status = planner.getByLabel('按状态筛选测量', { exact: true });
  await expect(rows).toHaveCount(4);
  await status.selectOption('pending');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('TA-04');
  await planner.getByLabel('搜索测量计划', { exact: true }).fill('TA-01');
  await expect(planner.getByText('没有符合筛选的测量')).toBeVisible();
  await planner.getByLabel('搜索测量计划', { exact: true }).fill('');
  await expect(rows).toHaveCount(1);
  await planner.getByLabel('选择当前全部测量操作', { exact: true }).check();
  await expect(planner).toContainText('已选 1 项');
  await expect(planner.getByRole('button', { name: '批量配置制度', exact: true })).toBeEnabled();
  await status.selectOption('completed');
  await expect(planner).not.toContainText('已选');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('TA-01');
  await planner.getByLabel('选择当前全部测量操作', { exact: true }).check();
  await expect(planner.getByRole('button', { name: '批量配置制度', exact: true })).toBeDisabled();
  await status.selectOption('');
  await expect(rows).toHaveCount(4);
  const after = await snapshot();
  expect(after.runs).toHaveLength(2);
  expect(after.items.map((item) => `${item.id}:${item.order}`)).toEqual(order);
  expect(after.items.find((item) => item.id === initial.items[1].id)?.status).toBe('skipped');
  expect(after.items.find((item) => item.id === initial.items[3].id)?.status).toBe('pending');
  expect(after.runs.find((run) => run.id === finished.id)?.originalEndedAt).toBe(
    finished.originalEndedAt,
  );
  expect(after.runs.find((run) => run.id === interrupted.id)?.originalEndedAt).toBe(
    interrupted.originalEndedAt,
  );
  expect(after.runs.find((run) => run.id === interrupted.id)?.snapshot).toEqual(interrupted.snapshot);
});

test('collapsed plan rows show operation status separately from spare counts', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const finished = (await snapshot()).runs[0];
  await command({ type: 'skip', itemId: initial.items[1].id });
  await command({ type: 'start', itemId: initial.items[2].id });
  await command({ type: 'interrupt', itemId: initial.items[2].id });
  const interrupted = (await snapshot()).runs.find((run) => run.itemId === initial.items[2].id)!;
  await page.reload();
  await expect(page.locator('.plan-page')).toBeVisible();
  const group = page.locator('tr', {
    has: page.getByLabel('Ti-A-热处理 准备数量', { exact: true }),
  });
  await expect(group.locator('.group-operation-status')).toHaveText('完成 1 · 中断 1 · 跳过 1 · 待测 1');
  await expect(group).toContainText('2 备样');
  await expect(group.locator('.sample-operations')).toHaveCount(0);
  const empty = page.locator('tr', {
    has: page.getByLabel('Ti-B-对照 准备数量', { exact: true }),
  });
  await expect(empty).toContainText('3 备样');
  await expect(empty.locator('.group-operation-status')).toHaveCount(0);
  const after = await snapshot();
  expect(after.runs).toHaveLength(2);
  expect(after.groups[0].preparedCount).toBe(initial.groups[0].preparedCount);
  expect(after.groups[1].preparedCount).toBe(initial.groups[1].preparedCount);
  expect(after.runs.find((run) => run.id === finished.id)?.originalEndedAt).toBe(
    finished.originalEndedAt,
  );
  expect(after.runs.find((run) => run.id === interrupted.id)?.snapshot.sample.id).toBe(
    interrupted.snapshot.sample.id,
  );
});

test('queue size uses the start snapshot after the plan thickness changes', async () => {
  const initial = await snapshot();
  const startedRow = page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true });
  await expect(startedRow).toContainText('厚 0.8 mm');
  await expect(startedRow).toContainText('宽 3 mm');
  await expect(startedRow).not.toContainText('核对装样方向');
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'updateGroups',
    ids: [initial.groups[0].id],
    patch: { thickness: '1.2' },
  });
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true })).toContainText(
    '厚 0.8 mm',
  );
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true })).toContainText(
    '厚 1.2 mm',
  );
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.groups[0].thickness).toBe('1.2');
  expect(after.groups[0].preparedCount).toBe(initial.groups[0].preparedCount);
});

test('focus heading keeps the recorded size while the queue is hidden', async () => {
  await page.getByRole('button', { name: '专注当前样品', exact: true }).click();
  await expect(page.locator('aside.queue')).toHaveCount(0);
  const heading = page.locator('.current-heading');
  await expect(heading).toContainText('厚 0.8 mm');
  await expect(heading).toContainText('宽 3 mm');
  await expect(heading).not.toContainText('核对装样方向');
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'updateGroups',
    ids: [initial.groups[0].id],
    patch: { thickness: '1.2' },
  });
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  await page.getByRole('button', { name: '专注当前样品', exact: true }).click();
  await expect(page.locator('aside.queue')).toHaveCount(0);
  await expect(heading).toContainText('厚 0.8 mm');
  await expect(heading.locator('.plan-drift')).toHaveText('当前计划已不同：尺寸 厚 1.2 mm · 宽 3 mm');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.groups[0].thickness).toBe('1.2');
});

test('queue and focus heading show a changed actual size beside the start size', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: run.id,
    actual: { thickness: '1.1' },
  });
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  const row = page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true });
  await expect(row).toContainText('实际 厚 1.1 mm · 宽 3 mm');
  await expect(row).toContainText('计划 厚 0.8 mm · 宽 3 mm');
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true })).toContainText(
    '厚 0.8 mm',
  );
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true })).not.toContainText(
    '实际',
  );
  await page.getByRole('button', { name: '专注当前样品', exact: true }).click();
  const heading = page.locator('.current-heading');
  await expect(heading).toContainText('实际 厚 1.1 mm · 宽 3 mm');
  await expect(heading).toContainText('计划 厚 0.8 mm · 宽 3 mm');
  await expect(heading).not.toContainText('核对装样方向');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.runs[0].actual.thickness).toBe('1.1');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
});

test('queue, review and library search find the actual thickness rather than a later plan edit', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({ type: 'saveRun', runId: run.id, actual: { thickness: '1.1' } });
  await command({
    type: 'updateGroups',
    ids: [initial.groups[0].id],
    patch: { thickness: '9.9' },
  });
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  await page.getByLabel('搜索待测样品', { exact: true }).fill('1.1');
  await expect(page.locator('.queue-row')).toHaveCount(1);
  await expect(page.locator('.queue-row')).toContainText('TA-01');
  await page.getByLabel('搜索待测样品', { exact: true }).fill('核对装样方向');
  await expect(page.getByText('没有符合筛选条件的操作')).toBeVisible();
  await page.getByLabel('搜索待测样品', { exact: true }).fill('9.9');
  await expect(page.locator('.queue-row')).toHaveCount(4);
  await expect(page.locator('.queue-row', { hasText: 'TA-01' })).toContainText('厚 0.8 mm');
  await expect(page.locator('.queue-row', { hasText: 'TA-01' })).toContainText(
    '当前计划已不同：尺寸 厚 9.9 mm · 宽 3 mm',
  );
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await page.getByLabel('搜索操作记录', { exact: true }).fill('1.1');
  await expect(page.locator('.review-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.review-table tbody tr')).toContainText('TA-01');
  await page.getByRole('button', { name: '全库搜索', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '全库搜索' });
  await dialog.getByRole('combobox', { name: '全库搜索', exact: true }).fill('1.1');
  await expect(dialog.getByRole('option')).toContainText('TA-01');
  await expect(dialog.getByRole('option')).toContainText('1.1');
  await page.keyboard.press('Escape');
  const after = await snapshot();
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.runs[0].actual.thickness).toBe('1.1');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.groups[0].thickness).toBe('9.9');
});

test('queue and focus heading keep the start preparation after the plan changes', async () => {
  const initial = await snapshot();
  await command({
    type: 'updateGroups',
    ids: [initial.groups[0].id],
    patch: { composition: 'Ti-24Nb-4Zr-8Sn（wt.%）', heatTreatment: '400 °C × 2 h' },
  });
  await page.reload();
  await expect(page.locator('.plan-page')).toBeVisible();
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  const row = page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true });
  await expect(row).toContainText('成分：Ti-24Nb-4Zr-8Sn（wt.%）');
  await expect(row).toContainText('热处理制度：400 °C × 2 h');
  await expect(row).not.toContainText('核对装样方向');
  await expect(row).not.toContainText('演示材料');
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'updateGroups',
    ids: [initial.groups[0].id],
    patch: { heatTreatment: '后来改成 800 °C' },
  });
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true })).toContainText(
    '400 °C × 2 h',
  );
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true })).toContainText(
    '当前计划已不同：成分：Ti-24Nb-4Zr-8Sn（wt.%） · 热处理制度：后来改成 800 °C',
  );
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true })).toContainText(
    '800 °C',
  );
  await page.getByRole('button', { name: '专注当前样品', exact: true }).click();
  await expect(page.locator('aside.queue')).toHaveCount(0);
  const heading = page.locator('.current-heading');
  await expect(heading).toContainText('热处理制度：400 °C × 2 h');
  await expect(heading.locator('.current-material')).not.toContainText('800 °C');
  await expect(heading.locator('.plan-drift')).toHaveText(
    '当前计划已不同：成分：Ti-24Nb-4Zr-8Sn（wt.%） · 热处理制度：后来改成 800 °C',
  );
  await expect(heading).not.toContainText('核对装样方向');
  await expect(heading).not.toContainText('演示材料');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].snapshot.group.heatTreatment).toBe('400 °C × 2 h');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.groups[0].heatTreatment).toBe('后来改成 800 °C');
  expect(after.groups[0].preparedCount).toBe(initial.groups[0].preparedCount);
});

test('queue duration uses recorded endpoints and does not estimate an open run', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const open = (await snapshot()).runs[0];
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  const running = page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true });
  await expect(running).toContainText('用时 未计入');
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true })).not.toContainText(
    '用时',
  );
  await command({ type: 'finish', itemId: initial.items[0].id });
  const finished = (await snapshot()).runs[0];
  const label = runDurationLabel(finished);
  await page.reload();
  await expect(page.locator('.plan-page')).toBeVisible();
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true })).toContainText(
    `用时 ${label}`,
  );
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true })).not.toContainText(
    '用时',
  );
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].originalStartedAt).toBe(open.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(finished.originalEndedAt);
  expect(after.runs[0].startedAt).toBe(finished.startedAt);
  expect(after.runs[0].endedAt).toBe(finished.endedAt);
});

test('collapsed plan rows sum recorded duration and leave incomplete runs out', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const open = (await snapshot()).runs[0];
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const group = page.locator('tr', {
    has: page.getByLabel('Ti-A-热处理 准备数量', { exact: true }),
  });
  await expect(group.locator('.group-recorded-duration')).toHaveText('1 次未计入');
  await expect(group).toContainText('2 备样');
  const empty = page.locator('tr', {
    has: page.getByLabel('Ti-B-对照 准备数量', { exact: true }),
  });
  await expect(empty.locator('.group-recorded-duration')).toHaveCount(0);
  await page.getByRole('button', { name: '展开 Ti-A-热处理' }).click();
  await expect(page.getByRole('button', { name: '查看 TA-01 操作 1 进行中', exact: true })).toContainText(
    '用时 未计入',
  );
  await command({ type: 'finish', itemId: initial.items[0].id });
  const finished = (await snapshot()).runs[0];
  await page.reload();
  await expect(page.locator('.plan-page')).toBeVisible();
  await expect(group.locator('.group-recorded-duration')).toHaveText(
    `已记录 ${runDurationLabel(finished)}`,
  );
  await page.getByRole('button', { name: '展开 Ti-A-热处理' }).click();
  await expect(page.getByRole('button', { name: '查看 TA-01 操作 1 已完成', exact: true })).toContainText(
    `用时 ${runDurationLabel(finished)}`,
  );
  const after = await snapshot();
  expect(after.runs[0].originalStartedAt).toBe(open.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(finished.originalEndedAt);
  expect(after.groups[0].preparedCount).toBe(initial.groups[0].preparedCount);
  expect(after.groups[1].preparedCount).toBe(initial.groups[1].preparedCount);
});

test('queue uses a sample thickness override and keeps it after the sample changes', async () => {
  const initial = await snapshot();
  const sampleId = initial.items[0].sampleId;
  await command({
    type: 'updateSamples',
    ids: [sampleId],
    parameters: { thickness: '1.5' },
  });
  await page.reload();
  await expect(page.locator('.plan-page')).toBeVisible();
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  const first = page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true });
  const second = page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true });
  await expect(first).toContainText('厚 1.5 mm');
  await expect(first).not.toContainText('核对装样方向');
  await expect(second).toContainText('厚 0.8 mm');
  await expect(second).not.toContainText('1.5');
  await expect(page.locator('.current-heading')).toContainText('厚 1.5 mm');
  await page.getByLabel('搜索待测样品', { exact: true }).fill('1.5');
  await expect(page.locator('.queue-row')).toHaveCount(1);
  await expect(page.locator('.queue-row')).toContainText('TA-01');
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'updateSamples',
    ids: [sampleId],
    parameters: { thickness: '2.2' },
  });
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true })).toContainText(
    '厚 1.5 mm',
  );
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true })).toContainText(
    '当前计划已不同：尺寸 厚 2.2 mm · 宽 3 mm',
  );
  await expect(page.locator('.current-heading')).toContainText('厚 1.5 mm');
  await expect(page.locator('.current-heading .plan-drift')).toHaveText(
    '当前计划已不同：尺寸 厚 2.2 mm · 宽 3 mm',
  );
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await page.getByLabel('搜索操作记录', { exact: true }).fill('1.5');
  await expect(page.locator('.review-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.review-table tbody tr')).toContainText('TA-01');
  await page.getByLabel('搜索操作记录', { exact: true }).fill('2.2');
  await expect(page.locator('.review-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.review-table tbody tr')).toContainText('TA-01');
  await expect(page.locator('.review-table tbody tr')).toContainText('当前计划已不同');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].snapshot.group.thickness).toBe('1.5');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.samples.find((sample) => sample.id === sampleId)?.parameters.thickness).toBe('2.2');
  expect(after.groups[0].thickness).toBe('0.8');
});

test('expanded samples mark only their own differences from the group', async () => {
  const initial = await snapshot();
  const sampleId = initial.items[0].sampleId;
  await command({
    type: 'updateSamples',
    ids: [sampleId],
    parameters: { thickness: '1.5', heatTreatment: '800 °C × 1 h' },
  });
  await page.reload();
  await expect(page.locator('.plan-page')).toBeVisible();
  await page.getByRole('button', { name: '展开 Ti-A-热处理' }).click();
  const first = page.locator('.sample-strip', { hasText: 'TA-01' });
  const second = page.locator('.sample-strip', { hasText: 'TA-02' });
  await expect(first.locator('.sample-override')).toHaveText('本样品 厚 1.5 mm · 热处理制度：800 °C × 1 h');
  await expect(first).not.toContainText('核对装样方向');
  await expect(first).not.toContainText('演示材料');
  await expect(second.locator('.sample-override')).toHaveCount(0);
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'updateSamples',
    ids: [sampleId],
    parameters: { thickness: '2.2' },
  });
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await page.getByRole('button', { name: '展开 Ti-A-热处理' }).click();
  await expect(page.locator('.sample-strip', { hasText: 'TA-01' }).locator('.sample-override')).toContainText(
    '厚 2.2 mm',
  );
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].snapshot.group.thickness).toBe('1.5');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.groups[0].thickness).toBe('0.8');
  expect(after.groups[0].preparedCount).toBe(initial.groups[0].preparedCount);
});

test('measurement plan marks a sample override without rewriting the started record', async () => {
  const initial = await snapshot();
  await command({
    type: 'updateSamples',
    ids: [initial.items[0].sampleId],
    parameters: { thickness: '1.5', heatTreatment: '800 °C × 1 h' },
  });
  await page.reload();
  await expect(page.locator('.plan-page')).toBeVisible();
  const planner = page.getByRole('region', { name: '测量计划', exact: true });
  const first = planner.locator('tbody tr', { hasText: 'TA-01' });
  const second = planner.locator('tbody tr', { hasText: 'TA-02' });
  await expect(first.locator('.sample-override')).toHaveText(
    '本样品 厚 1.5 mm · 热处理制度：800 °C × 1 h',
  );
  await expect(first).not.toContainText('核对装样方向');
  await expect(first).not.toContainText('演示材料');
  await expect(second.locator('.sample-override')).toHaveCount(0);
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'updateSamples',
    ids: [initial.items[0].sampleId],
    parameters: { thickness: '2.2' },
  });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(
    planner.locator('tbody tr', { hasText: 'TA-01' }).locator('.sample-override'),
  ).toContainText('厚 2.2 mm');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].snapshot.group.thickness).toBe('1.5');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.groups[0].thickness).toBe('0.8');
  expect(after.groups[0].preparedCount).toBe(initial.groups[0].preparedCount);
});

test('collapsed groups count samples that differ without listing the detail', async () => {
  const initial = await snapshot();
  await command({
    type: 'updateSamples',
    ids: [initial.items[0].sampleId],
    parameters: { thickness: '1.5', heatTreatment: '800 °C × 1 h' },
  });
  await page.reload();
  await expect(page.locator('.plan-page')).toBeVisible();
  const group = page.locator('tr', {
    has: page.getByLabel('Ti-A-热处理 准备数量', { exact: true }),
  });
  const empty = page.locator('tr', {
    has: page.getByLabel('Ti-B-对照 准备数量', { exact: true }),
  });
  await expect(group.locator('.group-sample-overrides')).toHaveText('1 件不同于本组');
  await expect(group).not.toContainText('800 °C');
  await expect(group).not.toContainText('核对装样方向');
  await expect(empty.locator('.group-sample-overrides')).toHaveCount(0);
  await expect(group).toContainText('2 备样');
  await page.getByRole('button', { name: '展开 Ti-A-热处理' }).click();
  await expect(page.locator('.sample-strip', { hasText: 'TA-01' }).locator('.sample-override')).toContainText(
    '厚 1.5 mm',
  );
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'updateSamples',
    ids: [initial.items[0].sampleId],
    parameters: { thickness: '2.2' },
  });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(group.locator('.group-sample-overrides')).toHaveText('1 件不同于本组');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].snapshot.group.thickness).toBe('1.5');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.groups[0].thickness).toBe('0.8');
  expect(after.groups[0].preparedCount).toBe(initial.groups[0].preparedCount);
});

test('live queue shows when the current plan drifts from the started snapshot', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'updateSamples',
    ids: [initial.items[0].sampleId],
    parameters: { thickness: '1.5' },
  });
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  const started = page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true });
  const pending = page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true });
  await expect(started).toContainText('厚 0.8 mm');
  await expect(started).toContainText('当前计划已不同：尺寸 厚 1.5 mm');
  await expect(started).not.toContainText('核对装样方向');
  await expect(pending).not.toContainText('当前计划已不同');
  await page.getByRole('button', { name: '专注当前样品', exact: true }).click();
  await expect(page.locator('aside.queue')).toHaveCount(0);
  await expect(page.locator('.current-heading')).toContainText('当前计划已不同：尺寸 厚 1.5 mm');
  await expect(page.locator('.current-heading')).toContainText('厚 0.8 mm');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.samples.find((sample) => sample.id === initial.items[0].sampleId)?.parameters.thickness).toBe(
    '1.5',
  );
  expect(after.groups[0].thickness).toBe('0.8');
});

test('collapsed groups count started records whose plan later changed', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'updateGroups',
    ids: [initial.groups[0].id],
    patch: { notes: '只改备注' },
  });
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const group = page.locator('tr', {
    has: page.getByLabel('Ti-A-热处理 准备数量', { exact: true }),
  });
  const empty = page.locator('tr', {
    has: page.getByLabel('Ti-B-对照 准备数量', { exact: true }),
  });
  await expect(group.locator('.group-plan-drift')).toHaveCount(0);
  await command({
    type: 'updateSamples',
    ids: [initial.items[0].sampleId],
    parameters: { thickness: '1.5' },
  });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(group.locator('.group-plan-drift')).toHaveText('1 件开始后计划已变');
  await expect(group).not.toContainText('厚 1.5');
  await expect(empty.locator('.group-plan-drift')).toHaveCount(0);
  await expect(group).toContainText('2 备样');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.groups[0].preparedCount).toBe(initial.groups[0].preparedCount);
  expect(after.groups[0].notes).toBe('只改备注');
});

test('a protocol edited after start is marked as plan drift and can be searched', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'updateGroups',
    ids: [initial.groups[0].id],
    patch: { protocol: '后来改成 450 °C' },
  });
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true })).toContainText(
    '当前计划已不同：实验制度 后来改成 450 °C',
  );
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true })).not.toContainText(
    '当前计划已不同',
  );
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true })).toContainText(
    '实验制度 10 °C/min 升至 375 °C，保温 30 min。',
  );
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true })).not.toContainText(
    '核对装样方向',
  );
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true })).toContainText(
    '实验制度 后来改成 450 °C',
  );
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true })).not.toContainText(
    '375',
  );
  await page.getByRole('button', { name: '复制开始时的实验制度', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(
    '10 °C/min 升至 375 °C，保温 30 min。',
  );
  await expect(page.locator('.current-heading h2')).toHaveText('TA-01');
  await page.getByRole('button', { name: '复制下一项实验制度 TA-02', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('后来改成 450 °C');
  await expect(page.locator('.current-heading h2')).toHaveText('TA-01');
  await page.getByLabel('搜索待测样品', { exact: true }).fill('450');
  await expect(page.locator('.queue-row')).toHaveCount(4);
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true })).toBeVisible();
  await page.getByLabel('搜索待测样品', { exact: true }).fill('375');
  await expect(page.locator('.queue-row')).toHaveCount(1);
  await expect(page.locator('.queue-row')).toContainText('TA-01');
  await page.getByLabel('搜索待测样品', { exact: true }).fill('核对装样方向');
  await expect(page.locator('.queue-row')).toHaveCount(0);
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].snapshot.group.protocol).toBe(run.snapshot.group.protocol);
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.groups[0].protocol).toBe('后来改成 450 °C');
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(page.locator('.plan-page')).toBeVisible();
  await page.getByRole('button', { name: '复制下一项实验制度 TA-02', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('后来改成 450 °C');
  await expect(page.locator('.plan-page')).toBeVisible();
  const planner = page.getByRole('region', { name: '测量计划', exact: true });
  await expect(planner.locator('tbody tr', { hasText: 'TA-01' })).toContainText(
    '实验制度 10 °C/min 升至 375 °C，保温 30 min。',
  );
  await expect(planner.locator('tbody tr', { hasText: 'TA-02' })).toContainText('实验制度 后来改成 450 °C');
  await expect(planner.locator('tbody tr', { hasText: 'TA-02' })).not.toContainText('375');
  await page.getByRole('button', { name: '展开 Ti-A-热处理', exact: true }).click();
  const startedOps = page.getByRole('group', { name: 'TA-01 的操作', exact: true });
  const pendingOps = page.getByRole('group', { name: 'TA-02 的操作', exact: true });
  await expect(startedOps).toContainText('实验制度 10 °C/min 升至 375 °C，保温 30 min。');
  await expect(startedOps).not.toContainText('核对装样方向');
  await expect(pendingOps).toContainText('实验制度 后来改成 450 °C');
  await expect(pendingOps).not.toContainText('375');
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await expect(page.locator('.review-page')).toBeVisible();
  const reviewRows = page.locator('.review-table tbody tr');
  await expect(reviewRows.filter({ hasText: 'TA-01' })).toContainText(
    '实验制度 10 °C/min 升至 375 °C，保温 30 min。',
  );
  await expect(reviewRows.filter({ hasText: 'TA-02' })).toContainText('实验制度 后来改成 450 °C');
  await expect(reviewRows.filter({ hasText: 'TA-02' })).not.toContainText('375');
  await expect(reviewRows.filter({ hasText: 'TA-01' })).not.toContainText('核对装样方向');
  await page.getByLabel('搜索操作记录', { exact: true }).fill('375');
  await expect(reviewRows).toHaveCount(1);
  await expect(reviewRows).toContainText('TA-01');
  await page.getByLabel('搜索操作记录', { exact: true }).fill('后来改成 450');
  await expect(reviewRows.filter({ hasText: 'TA-01' })).toHaveCount(1);
  await expect(reviewRows.filter({ hasText: 'TA-02' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await command({ type: 'finish', itemId: initial.items[0].id });
  await page.reload();
  await expect(page.locator('.plan-page')).toBeVisible();
  await page.getByRole('button', { name: '全库搜索', exact: true }).click();
  const library = page.getByRole('dialog', { name: '全库搜索' });
  await library.getByRole('combobox', { name: '全库搜索', exact: true }).fill('375');
  await expect(library.getByRole('option')).toHaveCount(1);
  await expect(library.getByRole('option')).toContainText('TA-01');
  await expect(library.getByRole('option')).toContainText('10 °C/min 升至 375 °C');
  await library.getByRole('combobox', { name: '全库搜索', exact: true }).fill('核对装样方向');
  await expect(library.getByText('没有匹配的样品或实验')).toBeVisible();
  await page.keyboard.press('Escape');
  const finished = await snapshot();
  expect(finished.runs[0].snapshot.group.protocol).toBe(run.snapshot.group.protocol);
  expect(finished.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(finished.runs[0].endedAt).toBeTruthy();
  expect(finished.groups[0].protocol).toBe('后来改成 450 °C');
});

test('the plan-changed queue filter hides other rows and keeps the real next pending', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'updateSamples',
    ids: [initial.items[0].sampleId],
    parameters: { thickness: '1.5' },
  });
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  const filters = page.getByRole('group', { name: '队列筛选' });
  await filters.getByRole('button', { name: '计划已变', exact: true }).click();
  await expect(page.locator('.queue-row')).toHaveCount(1);
  await expect(page.locator('.queue-row')).toContainText('TA-01');
  await expect(page.getByRole('region', { name: '现场下一项' })).toContainText('TA-02');
  await filters.getByRole('button', { name: '全部', exact: true }).click();
  await expect(page.locator('.queue-row')).toHaveCount(4);
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.items.filter((item) => item.status === 'running')).toHaveLength(1);
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
});

test('the plan drift count opens the earliest changed record without starting another', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  await command({ type: 'start', itemId: initial.items[1].id });
  const before = await snapshot();
  const firstRun = before.runs.find((run) => run.itemId === initial.items[0].id)!;
  const secondRun = before.runs.find((run) => run.itemId === initial.items[1].id)!;
  await command({
    type: 'updateGroups',
    ids: [initial.groups[0].id],
    patch: { thickness: '1.6' },
  });
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await page.getByRole('button', { name: '查看开始后计划已变的操作', exact: true }).click();
  await expect(page.locator('.live-page')).toBeVisible();
  await expect(page.locator('.current-heading')).toContainText('TA-01');
  await expect(page.locator('.current-heading')).toContainText('正在查看');
  await expect(page.locator('.current-heading')).toContainText('当前计划已不同');
  const after = await snapshot();
  expect(after.runs).toHaveLength(2);
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('completed');
  expect(after.items.find((item) => item.id === initial.items[1].id)?.status).toBe('running');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(2);
  expect(after.runs.find((run) => run.id === firstRun.id)?.snapshot.group.thickness).toBe('0.8');
  expect(after.runs.find((run) => run.id === secondRun.id)?.snapshot.group.thickness).toBe('0.8');
  expect(after.runs.find((run) => run.id === firstRun.id)?.originalStartedAt).toBe(
    firstRun.originalStartedAt,
  );
  expect(after.runs.find((run) => run.id === secondRun.id)?.originalStartedAt).toBe(
    secondRun.originalStartedAt,
  );
  expect(after.groups[0].thickness).toBe('1.6');
});

test('the live page opens the earliest incomplete record without starting the next sample', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  await command({ type: 'start', itemId: initial.items[1].id });
  const before = await snapshot();
  const finished = before.runs.find((run) => run.itemId === initial.items[0].id)!;
  const running = before.runs.find((run) => run.itemId === initial.items[1].id)!;
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  await expect(page.locator('.current-heading')).toContainText('TA-02');
  const gap = page.getByRole('region', { name: '现场先核对' });
  await expect(gap).toContainText('TA-01');
  await expect(gap).toContainText('文件未关联');
  await expect(gap).not.toContainText('时间不完整');
  await expect(gap).not.toContainText('TA-03');
  await expect(gap).not.toContainText('核对装样方向');
  await gap.getByRole('button', { name: '查看待核对 TA-01', exact: true }).click();
  await expect(page.locator('.current-heading')).toContainText('TA-01');
  await expect(page.locator('.current-heading')).toContainText('正在查看');
  await expect(page.getByRole('region', { name: '现场先核对' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '现场下一项' })).toContainText('TA-03');
  const after = await snapshot();
  expect(after.runs).toHaveLength(2);
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('completed');
  expect(after.items.find((item) => item.id === initial.items[1].id)?.status).toBe('running');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(2);
  expect(after.runs.find((run) => run.id === finished.id)?.originalStartedAt).toBe(
    finished.originalStartedAt,
  );
  expect(after.runs.find((run) => run.id === finished.id)?.originalEndedAt).toBe(
    finished.originalEndedAt,
  );
  expect(after.runs.find((run) => run.id === running.id)?.originalStartedAt).toBe(
    running.originalStartedAt,
  );
  expect(after.runs.find((run) => run.id === running.id)?.endedAt).toBeNull();
  expect(after.runs.find((run) => run.id === finished.id)?.snapshot.group.thickness).toBe('0.8');
});

test('heading gaps open the issue list or the file form without writing a record', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'addEvent',
    experimentId: initial.experiments[0].id,
    itemId: initial.items[0].id,
    runId: run.id,
    eventType: 'issue',
    text: '装样方向待复核',
    category: '样品',
  });
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toContainText(
    '未处理问题',
  );
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2' })).not.toContainText(
    '未处理问题',
  );
  const gaps = page.getByRole('list', { name: '待核对' });
  await gaps.getByRole('button', { name: '未处理问题', exact: true }).click();
  const issues = page.getByRole('dialog', { name: '未处理的问题' });
  await expect(issues).toContainText('装样方向待复核');
  await expect(page.locator('#live-actual-files')).not.toHaveAttribute('open', '');
  await issues.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await gaps.getByRole('button', { name: '文件未关联', exact: true }).click();
  await expect(page.locator('#live-actual-files')).toHaveAttribute('open', '');
  await expect(page.getByRole('dialog', { name: '未处理的问题' })).toHaveCount(0);
  await expect(page.locator('#live-actual-files')).toContainText('参数默认沿用计划');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.runs[0].actual.filename || '').toBe('');
  expect(after.events.filter((event) => event.type === 'issue' && !event.data.resolvedAt)).toHaveLength(
    1,
  );
  expect(after.items.filter((item) => item.status === 'running')).toHaveLength(1);
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
});

test('the overview copies the running folder and stays on the same record', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  await page.getByRole('button', { name: '实验概览', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '实验概览', exact: true });
  const running = modal.getByRole('region', { name: '全库进行中的操作', exact: true });
  await expect(running).toContainText(run.filename);
  await running.getByRole('button', { name: '在概览中复制进行中的数据文件夹', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(run.filename);
  await expect(modal).toBeVisible();
  await expect(page.locator('.live-page')).toBeVisible();
  await expect(page.locator('.current-heading')).toContainText('TA-01');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].filename).toBe(run.filename);
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.items.filter((item) => item.status === 'running')).toHaveLength(1);
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
});

test('the overview opens a record whose actual plan differs without starting it', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: run.id,
    notes: '只写备注',
    actual: { filename: 'beam.tif' },
  });
  await command({
    type: 'updateGroups',
    ids: [initial.groups[0].id],
    patch: { thickness: '9.9' },
  });
  await page.reload();
  await page.getByRole('button', { name: '实验概览', exact: true }).click();
  const hidden = page.getByRole('dialog', { name: '实验概览', exact: true });
  await expect(hidden.getByRole('region', { name: '实际与开始时不同', exact: true })).toHaveCount(0);
  await hidden.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await command({
    type: 'saveRun',
    runId: run.id,
    actual: { thickness: '1.1', thicknessUnit: 'mm' },
  });
  await page.reload();
  await page.getByRole('button', { name: '实验概览', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '实验概览', exact: true });
  const list = modal.getByRole('list', { name: '实际与开始时不同的操作', exact: true });
  await expect(list).toContainText('TA-01');
  await expect(list).toContainText('1.1 mm');
  await expect(list).toContainText('0.8 mm');
  await expect(list).not.toContainText('只写备注');
  await expect(list).not.toContainText('beam.tif');
  await expect(list).not.toContainText('9.9');
  await expect(list).not.toContainText('TA-02');
  await list.getByRole('button', { name: '打开实际已改 TA-01 操作 1', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.locator('.live-page')).toBeVisible();
  await expect(page.locator('.current-heading')).toContainText('TA-01');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actual.thickness).toBe('1.1');
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(run.originalEndedAt);
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('completed');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('review records a scan id on the existing run and leaves the times unchanged', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const before = await snapshot();
  const run = before.runs[0];
  await page.reload();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const row = page.locator('.review-table tbody tr', { hasText: 'TA-01' });
  await expect(row.locator('td').nth(4)).toContainText('未关联');
  await expect(
    page.locator('.review-table tbody tr', { hasText: 'TA-02' }).locator('td').nth(4),
  ).toHaveText('尚未开始');
  await row.getByRole('button', { name: '填写文件 TA-01 操作 1', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '填写数据文件' });
  await dialog.getByRole('button', { name: '保存文件关联', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('至少填写文件名、扫描编号或文件引用。');
  await dialog.getByLabel('扫描编号', { exact: true }).fill('SCAN-REVIEW-1');
  await dialog.getByRole('button', { name: '保存文件关联', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toContainText('SCAN-REVIEW-1');
  await expect(row).not.toContainText('未关联');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actual.scanId).toBe('SCAN-REVIEW-1');
  expect(String(after.runs[0].actual.filename || '')).toBe('');
  expect(after.runs[0].startedAt).toBe(run.startedAt);
  expect(after.runs[0].endedAt).toBe(run.endedAt);
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(run.originalEndedAt);
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('completed');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
});

test('the recent record opens its file form without starting the next sample', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const finished = (await snapshot()).runs[0];
  await page.reload();
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await expect(page.locator('.current-heading')).toContainText('TA-02');
  const recent = page.getByRole('region', { name: '最近记录' });
  await expect(recent).toContainText('最近完成');
  await expect(recent).toContainText('TA-01');
  await recent.getByRole('button', { name: '填写最近记录的文件 TA-01', exact: true }).click();
  await expect(page.locator('.current-heading')).toContainText('TA-01');
  await expect(page.locator('.current-heading')).toContainText('已完成');
  await expect(page.locator('#live-actual-files')).toHaveAttribute('open', '');
  await expect(page.getByRole('region', { name: '最近记录' })).toHaveCount(0);
  let after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(String(after.runs[0].actual.scanId || '')).toBe('');
  expect(String(after.runs[0].actual.filename || '')).toBe('');
  expect(after.runs[0].originalStartedAt).toBe(finished.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(finished.originalEndedAt);
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.items.find((item) => item.id === initial.items[1].id)?.status).toBe('pending');
  await command({
    type: 'saveRun',
    runId: finished.id,
    actual: { scanId: 'SCAN-RECENT-1' },
  });
  await page.reload();
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true }).click();
  const filled = page.getByRole('region', { name: '最近记录' });
  await expect(filled).toContainText('扫描 SCAN-RECENT-1');
  await expect(
    filled.getByRole('button', { name: '填写最近记录的文件 TA-01', exact: true }),
  ).toHaveCount(0);
  await filled.getByRole('button', { name: '查看最近记录 TA-01', exact: true }).click();
  await expect(page.locator('.current-heading')).toContainText('TA-01');
  await expect(page.locator('#live-actual-files')).not.toHaveAttribute('open', '');
  after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actual.scanId).toBe('SCAN-RECENT-1');
  expect(after.runs[0].originalStartedAt).toBe(finished.originalStartedAt);
  expect(after.items.find((item) => item.id === initial.items[1].id)?.status).toBe('pending');
});

test('a written reason is kept with skip or interrupt and stays out of search', async () => {
  const initial = await snapshot();
  const first = initial.items.slice().sort((a, b) => a.order - b.order)[0];
  await page.getByRole('button', { name: '写原因后跳过', exact: true }).click();
  const skipDialog = page.getByRole('dialog', { name: '写原因后跳过' });
  await expect(skipDialog.getByRole('button', { name: '确认跳过', exact: true })).toBeDisabled();
  await skipDialog.getByLabel('原因', { exact: true }).fill('样品未送达');
  await skipDialog.getByRole('button', { name: '确认跳过', exact: true }).click();
  await expect(skipDialog).toHaveCount(0);
  await expect(page.locator('.current-heading')).toContainText('已跳过');
  await expect(page.locator('.current-heading')).toContainText('原因：样品未送达');
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toContainText(
    '原因：样品未送达',
  );
  await page.getByLabel('搜索待测样品', { exact: true }).fill('样品未送达');
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toHaveCount(0);
  await page.getByRole('button', { name: '清除搜索待测样品', exact: true }).click();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await expect(page.locator('.review-table tbody tr', { hasText: 'TA-01' })).toContainText(
    '原因：样品未送达',
  );
  let data = await snapshot();
  expect(data.runs).toHaveLength(0);
  expect(data.items.find((item) => item.id === first.id)?.status).toBe('skipped');
  expect(data.events.some((event) => event.text === '跳过操作：样品未送达')).toBe(true);
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await page.getByRole('button', { name: '恢复到待测队列', exact: true }).click();
  await expect(page.locator('.current-heading')).not.toContainText('样品未送达');
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await expect(page.locator('.current-heading')).toContainText('已跳过');
  await expect(page.locator('.current-heading')).not.toContainText('原因：');
  await page.getByRole('button', { name: '恢复到待测队列', exact: true }).click();
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  await expect(page.getByRole('button', { name: '完成并切换下一项' })).toBeVisible();
  const started = await snapshot();
  const run = started.runs[0];
  await page.getByRole('button', { name: '写原因后中断', exact: true }).click();
  const interruptDialog = page.getByRole('dialog', { name: '写原因后中断' });
  await interruptDialog.getByLabel('原因', { exact: true }).fill('光束中断');
  await interruptDialog.getByRole('button', { name: '确认中断', exact: true }).click();
  await expect(page.locator('.current-heading')).toContainText('TA-01');
  await expect(page.locator('.current-heading')).toContainText('已中断');
  await expect(page.locator('.current-heading')).toContainText('原因：光束中断');
  await expect(page.getByRole('region', { name: '现场下一项' })).toContainText('TA-02');
  data = await snapshot();
  expect(data.runs).toHaveLength(1);
  expect(data.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(data.runs[0].startedAt).toBe(run.startedAt);
  expect(data.runs[0].endedAt).not.toBeNull();
  expect(data.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(data.items.find((item) => item.id === first.id)?.status).toBe('interrupted');
  expect(data.items.filter((item) => item.status === 'pending')).toHaveLength(3);
  expect(data.events.some((event) => event.text === '中断操作：光束中断')).toBe(true);
});

test('the plan strip restores a skipped operation and leaves the running record alone', async () => {
  const initial = await snapshot();
  await command({ type: 'skip', itemId: initial.items[0].id, reason: '样品未送达' });
  await command({ type: 'start', itemId: initial.items[1].id });
  const running = (await snapshot()).runs[0];
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await page.getByRole('button', { name: '展开 Ti-A-热处理', exact: true }).click();
  const skipped = page.getByRole('group', { name: 'TA-01 的操作' });
  await expect(
    skipped.getByRole('button', { name: '查看 TA-01 操作 1 已跳过', exact: true }),
  ).toContainText('原因：样品未送达');
  await expect(page.getByRole('button', { name: '恢复 TA-02 操作 2', exact: true })).toHaveCount(0);
  await skipped.getByRole('button', { name: '恢复 TA-01 操作 1', exact: true }).click();
  await expect(page.locator('.plan-page')).toBeVisible();
  await expect(
    skipped.getByRole('button', { name: '查看 TA-01 操作 1 待测', exact: true }),
  ).toBeVisible();
  await expect(skipped.getByRole('button', { name: '恢复 TA-01 操作 1', exact: true })).toHaveCount(
    0,
  );
  await expect(skipped).not.toContainText('样品未送达');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('pending');
  expect(after.items.find((item) => item.id === initial.items[1].id)?.status).toBe('running');
  expect(after.runs[0].originalStartedAt).toBe(running.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
});

test('the plan strip schedules one retest and leaves the finished record unchanged', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  await command({ type: 'start', itemId: initial.items[1].id });
  const before = await snapshot();
  const finished = before.runs.find((run) => run.itemId === initial.items[0].id)!;
  const running = before.runs.find((run) => run.itemId === initial.items[1].id)!;
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await page.getByRole('button', { name: '展开 Ti-A-热处理', exact: true }).click();
  const finishedStrip = page.getByRole('group', { name: 'TA-01 的操作' });
  await expect(page.getByRole('button', { name: '安排重测 TA-02 操作 2', exact: true })).toHaveCount(
    0,
  );
  await finishedStrip.getByRole('button', { name: '安排重测 TA-01 操作 1', exact: true }).click();
  await expect(page.locator('.plan-page')).toBeVisible();
  await expect(finishedStrip.getByRole('button', { name: /查看 TA-01 操作 \d+ 待测/ })).toBeVisible();
  await finishedStrip.getByRole('button', { name: '安排重测 TA-01 操作 1', exact: true }).click();
  await expect(finishedStrip.getByRole('button', { name: /查看 TA-01 操作/ })).toHaveCount(2);
  const after = await snapshot();
  const retests = after.items.filter((item) => item.repeatOf === initial.items[0].id);
  expect(retests).toHaveLength(1);
  expect(retests[0].status).toBe('pending');
  expect(retests[0].sampleId).toBe(initial.items[0].sampleId);
  expect(after.samples).toHaveLength(initial.samples.length);
  expect(after.runs).toHaveLength(2);
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('completed');
  expect(after.items.find((item) => item.id === initial.items[1].id)?.status).toBe('running');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
  const finishedAfter = after.runs.find((run) => run.id === finished.id)!;
  expect(finishedAfter.originalStartedAt).toBe(finished.originalStartedAt);
  expect(finishedAfter.originalEndedAt).toBe(finished.originalEndedAt);
  expect(finishedAfter.snapshot.group.thickness).toBe('0.8');
  expect(finishedAfter.snapshot.sample.id).toBe(finished.snapshot.sample.id);
  const runningAfter = after.runs.find((run) => run.id === running.id)!;
  expect(runningAfter.originalStartedAt).toBe(running.originalStartedAt);
  expect(runningAfter.endedAt).toBeNull();
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the next pending brief names a retest and does not start it', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const finished = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: finished.id,
    actual: { scanId: 'SCAN-NEXT-1' },
  });
  await command({ type: 'skip', itemId: initial.items[1].id });
  await command({ type: 'skip', itemId: initial.items[2].id });
  await command({ type: 'skip', itemId: initial.items[3].id });
  await command({ type: 'repeat', itemId: initial.items[0].id });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const planNext = page.getByRole('region', { name: '下一项待测' });
  await expect(planNext).toContainText('重测自 TA-01');
  await expect(planNext).toContainText('SCAN-NEXT-1');
  await expect(planNext).toContainText(finished.filename);
  await expect(planNext).not.toContainText('核对装样方向');
  await page.keyboard.press('Control+K');
  const library = page.getByRole('dialog', { name: '全库搜索' });
  const libraryNext = library.getByRole('option', { name: '查看下一项 TA-01', exact: true });
  await expect(libraryNext).toContainText('重测自 TA-01');
  await expect(libraryNext).toContainText('SCAN-NEXT-1');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true }).click();
  const liveNext = page.getByRole('region', { name: '现场下一项' });
  await expect(liveNext).toContainText('重测自 TA-01');
  await expect(liveNext).toContainText('SCAN-NEXT-1');
  await expect(liveNext).not.toContainText('核对装样方向');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].originalStartedAt).toBe(finished.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(finished.originalEndedAt);
  expect(after.runs[0].actual.scanId).toBe('SCAN-NEXT-1');
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.samples).toHaveLength(initial.samples.length);
  expect(after.items.filter((item) => item.repeatOf === initial.items[0].id)).toHaveLength(1);
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(1);
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('completed');
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('review can edit a saved note without changing the recorded times', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await page.reload();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const row = page.locator('.review-table tbody tr', { hasText: 'TA-01' });
  const pending = page.locator('.review-table tbody tr', { hasText: 'TA-02' });
  await expect(pending.getByRole('button', { name: '修改备注 TA-02 操作 2', exact: true })).toHaveCount(
    0,
  );
  await row.getByRole('button', { name: '修改备注 TA-01 操作 1', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修改现场备注' });
  await dialog.getByLabel('现场备注', { exact: true }).fill('先取消的文字');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await snapshot()).runs[0].notes).toBe('');
  await row.getByRole('button', { name: '修改备注 TA-01 操作 1', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '修改现场备注' });
  await editor.getByLabel('现场备注', { exact: true }).fill('回看补记装样复核');
  await editor.getByRole('button', { name: '保存备注', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(row).toContainText('回看补记装样复核');
  await page.getByLabel('搜索操作记录', { exact: true }).fill('回看补记装样复核');
  await expect(page.locator('.review-table tbody tr', { hasText: 'TA-01' })).toHaveCount(1);
  await expect(page.locator('.review-table tbody tr', { hasText: 'TA-02' })).toHaveCount(0);
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await page.getByLabel('搜索待测样品', { exact: true }).fill('回看补记装样复核');
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toHaveCount(0);
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].notes).toBe('回看补记装样复核');
  expect(after.runs[0].startedAt).toBe(run.startedAt);
  expect(after.runs[0].endedAt).toBe(run.endedAt);
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(run.originalEndedAt);
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
});

test('review can correct a saved scan id without changing the recorded times', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({ type: 'saveRun', runId: run.id, actual: { scanId: 'SCAN-OLD' } });
  await page.reload();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const row = page.locator('.review-table tbody tr', { hasText: 'TA-01' });
  const pending = page.locator('.review-table tbody tr', { hasText: 'TA-02' });
  await expect(row).toContainText('SCAN-OLD');
  await expect(pending.getByRole('button', { name: '修改文件 TA-02 操作 2', exact: true })).toHaveCount(
    0,
  );
  await row.getByRole('button', { name: '修改文件 TA-01 操作 1', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修改数据文件' });
  await dialog.getByLabel('扫描编号', { exact: true }).fill('');
  await dialog.getByRole('button', { name: '保存文件关联', exact: true }).click();
  await expect(dialog).toContainText('至少填写文件名、扫描编号或文件引用。');
  expect((await snapshot()).runs[0].actual.scanId).toBe('SCAN-OLD');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await row.getByRole('button', { name: '修改文件 TA-01 操作 1', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '修改数据文件' });
  await editor.getByLabel('扫描编号', { exact: true }).fill('SCAN-NEW');
  await editor.getByRole('button', { name: '保存文件关联', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(row).toContainText('SCAN-NEW');
  await expect(row).not.toContainText('SCAN-OLD');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actual.scanId).toBe('SCAN-NEW');
  expect(after.runs[0].startedAt).toBe(run.startedAt);
  expect(after.runs[0].endedAt).toBe(run.endedAt);
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(run.originalEndedAt);
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('completed');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
});

test('the measurement plan keeps the recorded size after the plan thickness changes', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: run.id,
    actual: { thickness: '1.1', thicknessUnit: 'mm' },
  });
  await command({
    type: 'updateGroups',
    ids: [initial.groups[0].id],
    patch: { thickness: '9.9', notes: '只改备注' },
  });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const planner = page.getByRole('region', { name: '测量计划', exact: true });
  const started = planner.locator('tbody tr', { hasText: 'TA-01' });
  const pending = planner.locator('tbody tr', { hasText: 'TA-02' });
  await expect(started.locator('.measurement-size')).toContainText('实际');
  await expect(started.locator('.measurement-size')).toContainText('厚 1.1 mm');
  await expect(started.locator('.measurement-size')).toContainText('计划');
  await expect(started.locator('.measurement-size')).toContainText('厚 0.8 mm');
  await expect(started.locator('.measurement-size')).not.toContainText('9.9');
  await expect(started.locator('.measurement-drift')).toContainText('9.9');
  await expect(started).not.toContainText('只改备注');
  await expect(started).not.toContainText('核对装样方向');
  await expect(started).not.toContainText('演示材料');
  await expect(pending.locator('.measurement-size')).toContainText('厚 9.9');
  await expect(pending.locator('.measurement-size')).not.toContainText('实际');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actual.thickness).toBe('1.1');
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('running');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
  expect(after.groups[0].preparedCount).toBe(6);
});

test('the measurement plan restores a skipped row and keeps the running record', async () => {
  const initial = await snapshot();
  await command({ type: 'skip', itemId: initial.items[0].id, reason: '样品未送达' });
  await command({ type: 'start', itemId: initial.items[1].id });
  const running = (await snapshot()).runs[0];
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const planner = page.getByRole('region', { name: '测量计划', exact: true });
  await planner.getByLabel('按状态筛选测量', { exact: true }).selectOption('skipped');
  const row = planner.locator('tbody tr', { hasText: 'TA-01' });
  await expect(row).toContainText('原因：样品未送达');
  await planner.getByLabel('搜索测量计划', { exact: true }).fill('样品未送达');
  await expect(planner.getByText('没有符合筛选的测量')).toBeVisible();
  await planner.getByLabel('搜索测量计划', { exact: true }).fill('');
  await expect(planner.getByRole('button', { name: '恢复测量 TA-02 操作 2', exact: true })).toHaveCount(
    0,
  );
  await row.getByRole('button', { name: '恢复测量 TA-01 操作 1', exact: true }).click();
  await expect(page.locator('.plan-page')).toBeVisible();
  await expect(planner.getByText('没有符合筛选的测量')).toBeVisible();
  await planner.getByLabel('按状态筛选测量', { exact: true }).selectOption('');
  const restored = planner.locator('tbody tr', { hasText: 'TA-01' });
  await expect(restored).not.toContainText('样品未送达');
  await expect(restored.getByRole('button', { name: '恢复测量 TA-01 操作 1', exact: true })).toHaveCount(
    0,
  );
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('pending');
  expect(after.items.find((item) => item.id === initial.items[1].id)?.status).toBe('running');
  expect(after.runs[0].originalStartedAt).toBe(running.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('review schedules one retest and leaves the finished record unchanged', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  await command({ type: 'start', itemId: initial.items[1].id });
  const before = await snapshot();
  const finished = before.runs.find((run) => run.itemId === initial.items[0].id)!;
  const running = before.runs.find((run) => run.itemId === initial.items[1].id)!;
  await page.reload();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await expect(page.locator('.review-page')).toBeVisible();
  await expect(
    page.locator('.review-table tbody tr', { hasText: 'TA-02' }).getByRole('button', {
      name: '安排重测 TA-02 操作 2',
      exact: true,
    }),
  ).toHaveCount(0);
  const schedule = page.getByRole('button', { name: '安排重测 TA-01 操作 1', exact: true });
  await schedule.click();
  await expect(page.locator('.review-page')).toBeVisible();
  await expect(page.locator('.review-table tbody tr', { hasText: '重测自 TA-01' })).toHaveCount(1);
  await schedule.click();
  await expect(page.locator('.review-table tbody tr', { hasText: '重测自 TA-01' })).toHaveCount(1);
  const after = await snapshot();
  const retests = after.items.filter((item) => item.repeatOf === initial.items[0].id);
  expect(retests).toHaveLength(1);
  expect(retests[0].status).toBe('pending');
  expect(retests[0].sampleId).toBe(initial.items[0].sampleId);
  expect(after.samples).toHaveLength(initial.samples.length);
  expect(after.runs).toHaveLength(2);
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('completed');
  expect(after.items.find((item) => item.id === initial.items[1].id)?.status).toBe('running');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
  const finishedAfter = after.runs.find((run) => run.id === finished.id)!;
  expect(finishedAfter.originalStartedAt).toBe(finished.originalStartedAt);
  expect(finishedAfter.originalEndedAt).toBe(finished.originalEndedAt);
  expect(finishedAfter.snapshot.group.thickness).toBe('0.8');
  expect(finishedAfter.snapshot.sample.id).toBe(finished.snapshot.sample.id);
  const runningAfter = after.runs.find((run) => run.id === running.id)!;
  expect(runningAfter.originalStartedAt).toBe(running.originalStartedAt);
  expect(runningAfter.endedAt).toBeNull();
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the measurement plan marks a protocol changed after start and ignores notes', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'updateGroups',
    ids: [initial.groups[0].id],
    patch: { protocol: '保温改为 45 min', notes: '只改备注' },
  });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const planner = page.getByRole('region', { name: '测量计划', exact: true });
  const started = planner.locator('tbody tr', { hasText: 'TA-01' });
  const pending = planner.locator('tbody tr', { hasText: 'TA-02' });
  await expect(started.locator('.measurement-drift')).toContainText('当前计划已不同');
  await expect(started.locator('.measurement-drift')).toContainText('保温改为 45 min');
  await expect(started).not.toContainText('只改备注');
  await expect(started).not.toContainText('核对装样方向');
  await expect(started).not.toContainText('演示材料');
  await expect(pending.locator('.measurement-drift')).toHaveCount(0);
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].snapshot.group.protocol).toContain('375');
  expect(after.runs[0].snapshot.group.protocol).not.toContain('45 min');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.groups[0].protocol).toBe('保温改为 45 min');
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('running');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
});

test('the measurement plan filter keeps only rows whose plan changed after start', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'updateGroups',
    ids: [initial.groups[0].id],
    patch: { notes: '只改备注' },
  });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const planner = page.getByRole('region', { name: '测量计划', exact: true });
  await expect(planner.getByRole('button', { name: '计划已变', exact: true })).toHaveCount(0);
  await command({
    type: 'updateGroups',
    ids: [initial.groups[0].id],
    patch: { protocol: '保温改为 45 min' },
  });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await planner.getByRole('button', { name: '计划已变', exact: true }).click();
  await expect(planner.locator('tbody tr')).toHaveCount(1);
  await expect(planner.locator('tbody tr')).toContainText('TA-01');
  await expect(planner.locator('tbody tr')).toContainText('当前计划已不同');
  await expect(planner).not.toContainText('只改备注');
  await planner.getByLabel('按状态筛选测量', { exact: true }).selectOption('pending');
  await expect(planner.getByText('没有符合筛选的测量')).toBeVisible();
  await planner.getByLabel('按状态筛选测量', { exact: true }).selectOption('');
  await expect(planner.locator('tbody tr')).toHaveCount(1);
  await planner.getByRole('button', { name: '计划已变', exact: true }).click();
  await expect(planner.locator('tbody tr')).toHaveCount(4);
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].snapshot.group.protocol).toContain('375');
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.groups[0].protocol).toBe('保温改为 45 min');
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('running');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
});

test('the measurement plan keeps only rows whose recorded plan differs', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({ type: 'saveRun', runId: run.id, notes: '只写备注' });
  await command({
    type: 'updateGroups',
    ids: [initial.groups[0].id],
    patch: { protocol: '保温改为 45 min' },
  });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const planner = page.getByRole('region', { name: '测量计划', exact: true });
  await expect(planner.getByRole('button', { name: '计划已变', exact: true })).toBeVisible();
  await expect(planner.getByRole('button', { name: '实际已改', exact: true })).toHaveCount(0);
  await expect(planner).not.toContainText('只写备注');
  await command({
    type: 'saveRun',
    runId: run.id,
    actual: { protocol: '现场改为 20 min' },
  });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await planner.getByRole('button', { name: '实际已改', exact: true }).click();
  await expect(planner.locator('tbody tr')).toHaveCount(1);
  await expect(planner.locator('tbody tr')).toContainText('TA-01');
  await expect(planner.locator('tbody tr')).toContainText('实际制度');
  await planner.getByRole('button', { name: '计划已变', exact: true }).click();
  await expect(planner.locator('tbody tr')).toHaveCount(1);
  await planner.getByLabel('按状态筛选测量', { exact: true }).selectOption('pending');
  await expect(planner.getByText('没有符合筛选的测量')).toBeVisible();
  await planner.getByLabel('按状态筛选测量', { exact: true }).selectOption('');
  await planner.getByRole('button', { name: '实际已改', exact: true }).click();
  await planner.getByRole('button', { name: '计划已变', exact: true }).click();
  await expect(planner.locator('tbody tr')).toHaveCount(4);
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actual.protocol).toBe('现场改为 20 min');
  expect(after.runs[0].snapshot.group.protocol).toContain('375');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.groups[0].protocol).toBe('保温改为 45 min');
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('running');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
});

test('the measurement plan shows an actual protocol without rewriting the start snapshot', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: run.id,
    actual: { protocol: '现场改为 20 min' },
  });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const planner = page.getByRole('region', { name: '测量计划', exact: true });
  const started = planner.locator('tbody tr', { hasText: 'TA-01' });
  const pending = planner.locator('tbody tr', { hasText: 'TA-02' });
  await expect(started.locator('.measurement-actual-protocol')).toContainText('实际制度');
  await expect(started.locator('.measurement-actual-protocol')).toContainText('现场改为 20 min');
  await expect(started).toContainText('375');
  await expect(started.locator('.measurement-drift')).toHaveCount(0);
  await expect(started).not.toContainText('核对装样方向');
  await expect(started).not.toContainText('演示材料');
  await expect(pending.locator('.measurement-actual-protocol')).toHaveCount(0);
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actual.protocol).toBe('现场改为 20 min');
  expect(after.runs[0].snapshot.group.protocol).toContain('375');
  expect(after.runs[0].snapshot.group.protocol).not.toContain('20 min');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.groups[0].protocol).toContain('375');
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('running');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
});

test('search finds a started sample by the protocol recorded after start', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: run.id,
    actual: { protocol: '现场改为 20 min' },
  });
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  await page.getByLabel('搜索待测样品', { exact: true }).fill('现场改为 20 min');
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2' })).toHaveCount(0);
  await page.getByLabel('搜索待测样品', { exact: true }).fill('核对装样方向');
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toHaveCount(0);
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const planner = page.getByRole('region', { name: '测量计划', exact: true });
  await planner.getByLabel('搜索测量计划', { exact: true }).fill('现场改为 20 min');
  await expect(planner.locator('tbody tr')).toHaveCount(1);
  await expect(planner.locator('tbody tr')).toContainText('TA-01');
  const planning = page.locator('.planning-card');
  await planning.getByLabel('搜索样品组', { exact: true }).fill('现场改为 20 min');
  await expect(planning.locator('.toolbar-title')).toContainText('1 /');
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await page.getByLabel('搜索操作记录', { exact: true }).fill('现场改为 20 min');
  await expect(page.locator('.review-table tbody tr', { hasText: 'TA-01' })).toHaveCount(1);
  await expect(page.locator('.review-table tbody tr', { hasText: 'TA-02' })).toHaveCount(0);
  await page.locator('h1').click();
  await page.keyboard.press('Control+K');
  const library = page.getByRole('dialog', { name: '全库搜索' });
  await library.getByRole('combobox', { name: '全库搜索', exact: true }).fill('现场改为 20 min');
  await expect(library.getByRole('option', { name: /TA-01/ })).toContainText('实际制度');
  await library.getByRole('combobox', { name: '全库搜索', exact: true }).fill('核对装样方向');
  await expect(library.getByText('没有匹配的样品或实验')).toBeVisible();
  await page.keyboard.press('Escape');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actual.protocol).toBe('现场改为 20 min');
  expect(after.runs[0].snapshot.group.protocol).toContain('375');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('running');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
});

test('search finds a started sample by the preparation recorded after start', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: run.id,
    notes: '只写备注',
    actual: { preparation: '试剂批次 K-9', composition: '秘密组分' },
    actualSample: { name: '现场试样甲' },
  });
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  await page.getByLabel('搜索待测样品', { exact: true }).fill('试剂批次 K-9');
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2' })).toHaveCount(0);
  await page.getByLabel('搜索待测样品', { exact: true }).fill('现场试样甲');
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2' })).toHaveCount(0);
  await page.getByLabel('搜索待测样品', { exact: true }).fill('只写备注');
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toHaveCount(0);
  await page.getByLabel('搜索待测样品', { exact: true }).fill('秘密组分');
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toHaveCount(0);
  await page.getByLabel('搜索待测样品', { exact: true }).fill('演示材料');
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1' })).toHaveCount(0);
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await page.getByLabel('搜索操作记录', { exact: true }).fill('试剂批次 K-9');
  await expect(page.locator('.review-table tbody tr', { hasText: 'TA-01' })).toHaveCount(1);
  await expect(page.locator('.review-table tbody tr', { hasText: 'TA-02' })).toHaveCount(0);
  await page.getByLabel('搜索操作记录', { exact: true }).fill('秘密组分');
  await expect(page.locator('.review-table tbody tr')).toHaveCount(0);
  await page.locator('h1').click();
  await page.keyboard.press('Control+K');
  const library = page.getByRole('dialog', { name: '全库搜索' });
  await library.getByRole('combobox', { name: '全库搜索', exact: true }).fill('试剂批次 K-9');
  await expect(library.getByRole('option', { name: /TA-01/ })).toContainText('制备');
  await library.getByRole('combobox', { name: '全库搜索', exact: true }).fill('演示材料');
  await expect(library.getByText('没有匹配的样品或实验')).toBeVisible();
  await page.keyboard.press('Escape');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actual.preparation).toBe('试剂批次 K-9');
  expect(after.runs[0].actualSample?.name).toBe('现场试样甲');
  expect(after.runs[0].snapshot.group.preparation).toBe('Ti-A / 制备批次 A');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('running');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
});

test('the queue and review show the recorded preparation beside the start preparation', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: run.id,
    notes: '只写备注',
    actual: { preparation: '试剂批次 K-9', composition: '秘密组分' },
    actualSample: { name: '现场试样甲' },
  });
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  const row = page.getByRole('button', { name: '选择样品 TA-01 操作 1' });
  await expect(row).toContainText('制备/试剂：Ti-A / 制备批次 A → 试剂批次 K-9');
  await expect(row).toContainText('样品名：');
  await expect(row).toContainText('现场试样甲');
  await expect(row).not.toContainText('只写备注');
  await expect(row).not.toContainText('秘密组分');
  await expect(row).not.toContainText('演示材料');
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2' })).not.toContainText(
    '试剂批次 K-9',
  );
  await expect(page.locator('.current-heading')).toContainText('试剂批次 K-9');
  await expect(page.locator('.current-heading')).toContainText('现场试样甲');
  await expect(page.locator('.current-heading')).not.toContainText('只写备注');
  await expect(page.locator('.current-heading')).not.toContainText('当前计划已不同');
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const planner = page.getByRole('region', { name: '测量计划', exact: true });
  const started = planner.locator('tbody tr', { hasText: 'TA-01' });
  await expect(started.locator('.measurement-recorded-plan')).toContainText('试剂批次 K-9');
  await expect(started.locator('.measurement-recorded-plan')).not.toContainText('秘密组分');
  await expect(planner.locator('tbody tr', { hasText: 'TA-02' }).locator('.measurement-recorded-plan')).toHaveCount(0);
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const review = page.locator('.review-table tbody tr', { hasText: 'TA-01' });
  await expect(review.locator('.review-recorded-plan')).toContainText('试剂批次 K-9');
  await expect(review.locator('.review-recorded-plan')).toContainText('现场试样甲');
  await expect(review.locator('.review-recorded-plan')).not.toContainText('只写备注');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actual.preparation).toBe('试剂批次 K-9');
  expect(after.runs[0].snapshot.group.preparation).toBe('Ti-A / 制备批次 A');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('running');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
});

test('review can correct the actual preparation without changing the start snapshot', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({ type: 'saveRun', runId: run.id, notes: '只写备注' });
  await page.reload();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const row = page.locator('.review-table tbody tr', { hasText: 'TA-01' });
  const pending = page.locator('.review-table tbody tr', { hasText: 'TA-02' });
  await expect(
    pending.getByRole('button', { name: '修改实际制备 TA-02 操作 2', exact: true }),
  ).toHaveCount(0);
  await row.getByRole('button', { name: '修改实际制备 TA-01 操作 1', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修改实际制备' });
  await expect(dialog.getByLabel('实际样品名', { exact: true })).toHaveValue('Ti-A 拉伸试样');
  await expect(dialog.getByLabel('实际制备或试剂', { exact: true })).toHaveValue('Ti-A / 制备批次 A');
  await expect(dialog.getByLabel('实际实验方式', { exact: true })).toHaveValue('In situ');
  await dialog.getByLabel('实际样品名', { exact: true }).fill('现场试样甲');
  await dialog.getByLabel('实际实验方式', { exact: true }).selectOption('Ex situ');
  await dialog.getByLabel('实际制备或试剂', { exact: true }).fill('试剂批次 K-9');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await snapshot()).runs[0].actual.preparation).toBe('Ti-A / 制备批次 A');
  await row.getByRole('button', { name: '修改实际制备 TA-01 操作 1', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '修改实际制备' });
  await editor.getByLabel('实际样品名', { exact: true }).fill('现场试样甲');
  await editor.getByLabel('实际实验方式', { exact: true }).selectOption('Ex situ');
  await editor.getByLabel('实际制备或试剂', { exact: true }).fill('试剂批次 K-9');
  await editor.getByRole('button', { name: '保存实际制备', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(row.locator('.review-recorded-plan')).toContainText('试剂批次 K-9');
  await expect(row.locator('.review-recorded-plan')).toContainText('现场试样甲');
  await expect(row.locator('.review-recorded-plan')).toContainText('非原位');
  await expect(row.locator('.review-recorded-plan')).not.toContainText('只写备注');
  await expect(row.locator('.review-recorded-plan')).not.toContainText('演示材料');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actual.preparation).toBe('试剂批次 K-9');
  expect(after.runs[0].actual.mode).toBe('Ex situ');
  expect(after.runs[0].actualSample?.name).toBe('现场试样甲');
  expect(after.runs[0].actual.thickness).toBe('0.8');
  expect(after.runs[0].actual.composition).toBe('演示材料');
  expect(after.runs[0].notes).toBe('只写备注');
  expect(after.runs[0].snapshot.group.preparation).toBe('Ti-A / 制备批次 A');
  expect(after.runs[0].snapshot.group.mode).toBe('In situ');
  expect(after.runs[0].snapshot.group.name).toBe('Ti-A 拉伸试样');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(run.originalEndedAt);
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('completed');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the experiment list counts records whose actual plan differs', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: run.id,
    notes: '只写备注',
    actual: { filename: 'beam.tif' },
  });
  await command({
    type: 'updateGroups',
    ids: [initial.groups[0].id],
    patch: { thickness: '9.9' },
  });
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  await expect(page.getByLabel('选择实验', { exact: true })).not.toContainText('实际已改');
  await command({
    type: 'saveRun',
    runId: run.id,
    actual: { preparation: '试剂批次 K-9' },
  });
  await page.reload();
  await expect(page.getByLabel('选择实验', { exact: true })).toContainText('实际已改 1');
  await page.locator('h1').click();
  await page.keyboard.press('Control+K');
  const library = page.getByRole('dialog', { name: '全库搜索' });
  await expect(library.getByRole('option', { name: /同步辐射实验/ }).first()).toContainText('实际已改 1');
  await page.keyboard.press('Escape');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actual.preparation).toBe('试剂批次 K-9');
  expect(after.runs[0].snapshot.group.preparation).toBe('Ti-A / 制备批次 A');
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the queue and review show the recorded protocol beside the start protocol', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: run.id,
    actual: { protocol: '现场改为 20 min' },
  });
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  const row = page.getByRole('button', { name: '选择样品 TA-01 操作 1' });
  await expect(row).toContainText('实际制度 现场改为 20 min');
  await expect(row).toContainText('开始时');
  await expect(row).toContainText('375');
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2' })).not.toContainText(
    '实际制度',
  );
  await expect(page.locator('.current-heading')).toContainText('实际制度 现场改为 20 min');
  await expect(page.locator('.current-heading')).not.toContainText('核对装样方向');
  await expect(page.locator('.current-heading')).not.toContainText('当前计划已不同');
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const reviewRow = page.locator('.review-table tbody tr', { hasText: 'TA-01' });
  await expect(reviewRow.locator('.review-actual-protocol')).toContainText('现场改为 20 min');
  await expect(reviewRow.locator('.review-actual-protocol')).toContainText('375');
  await expect(
    page.locator('.review-table tbody tr', { hasText: 'TA-02' }).locator('.review-actual-protocol'),
  ).toHaveCount(0);
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actual.protocol).toBe('现场改为 20 min');
  expect(after.runs[0].snapshot.group.protocol).toContain('375');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('running');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
});

test('the measurement plan shows recorded duration and does not estimate an open run', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const planner = page.getByRole('region', { name: '测量计划', exact: true });
  const openRow = planner.locator('tbody tr', { hasText: 'TA-01' });
  const pending = planner.locator('tbody tr', { hasText: 'TA-02' });
  await expect(openRow.locator('.measurement-duration')).toHaveText('用时 未计入');
  await expect(pending.locator('.measurement-duration')).toHaveCount(0);
  await expect(openRow).not.toContainText('核对装样方向');
  await command({
    type: 'times',
    itemId: initial.items[0].id,
    startedAt: '2026-10-14T01:00:00.000Z',
    endedAt: '2026-10-14T01:05:00.000Z',
    reason: '核对用时',
  });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '测量计划', exact: true }).locator('tbody tr', { hasText: 'TA-01' }).locator('.measurement-duration'),
  ).toHaveText('用时 5 分 00 秒');
  await expect(
    page.getByRole('region', { name: '测量计划', exact: true }).locator('tbody tr', { hasText: 'TA-02' }).locator('.measurement-duration'),
  ).toHaveCount(0);
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].originalStartedAt).toBe(started.originalStartedAt);
  expect(after.runs[0].startedAt).toBe('2026-10-14T01:00:00.000Z');
  expect(after.runs[0].endedAt).toBe('2026-10-14T01:05:00.000Z');
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('completed');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the experiment library shows recorded duration and incomplete runs separately', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  await command({
    type: 'times',
    itemId: initial.items[0].id,
    startedAt: '2026-10-14T01:00:00.000Z',
    endedAt: '2026-10-14T01:05:00.000Z',
    reason: '核对用时',
  });
  await command({ type: 'start', itemId: initial.items[1].id });
  await page.reload();
  await page.locator('h1').click();
  await page.keyboard.press('Control+K');
  const library = page.getByRole('dialog', { name: '全库搜索' });
  const counts = library.locator('.library-counts');
  await expect(counts).toContainText('已记录 5 分 00 秒');
  await expect(counts).toContainText('未计入 1 次');
  await expect(counts).not.toContainText('核对装样方向');
  await page.keyboard.press('Escape');
  const after = await snapshot();
  expect(after.runs).toHaveLength(2);
  const finished = after.runs.find((run) => run.id === started.id)!;
  expect(finished.originalStartedAt).toBe(started.originalStartedAt);
  expect(finished.snapshot.group.thickness).toBe('0.8');
  expect(after.runs.find((run) => run.itemId === initial.items[1].id)?.endedAt).toBeNull();
  expect(after.items.find((item) => item.id === initial.items[1].id)?.status).toBe('running');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(2);
  expect(after.samples).toHaveLength(initial.samples.length);
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the plan page shows the latest finished record and opens it without starting another', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  await command({
    type: 'times',
    itemId: initial.items[0].id,
    startedAt: '2026-10-14T01:00:00.000Z',
    endedAt: '2026-10-14T01:05:00.000Z',
    reason: '核对用时',
  });
  await command({
    type: 'saveRun',
    runId: started.id,
    actual: { scanId: 'SCAN-LAST-1' },
  });
  await command({ type: 'start', itemId: initial.items[1].id });
  const finishedBefore = (await snapshot()).runs.find((run) => run.id === started.id)!;
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const recent = page.getByRole('region', { name: '最近记录' });
  await expect(recent).toContainText('最近完成');
  await expect(recent).toContainText('TA-01');
  await expect(recent).toContainText('用时 5 分 00 秒');
  await expect(recent).toContainText('扫描 SCAN-LAST-1');
  await expect(recent).toContainText(started.filename);
  await expect(recent).not.toContainText('核对装样方向');
  await recent.getByRole('button', { name: '查看最近记录 TA-01', exact: true }).click();
  await expect(page.locator('.live-page')).toBeVisible();
  await expect(page.locator('.current-heading')).toContainText('TA-01');
  await expect(page.locator('.current-heading')).toContainText('正在查看');
  const after = await snapshot();
  expect(after.runs).toHaveLength(2);
  const finished = after.runs.find((run) => run.id === started.id)!;
  expect(finished.originalStartedAt).toBe(started.originalStartedAt);
  expect(finished.originalEndedAt).toBe(finishedBefore.originalEndedAt);
  expect(finished.actual.scanId).toBe('SCAN-LAST-1');
  expect(finished.snapshot.group.thickness).toBe('0.8');
  expect(after.runs.find((run) => run.itemId === initial.items[1].id)?.endedAt).toBeNull();
  expect(after.items.find((item) => item.id === initial.items[1].id)?.status).toBe('running');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(2);
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the plan page copies the latest finished folder and stays on the plan', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  await command({
    type: 'times',
    itemId: initial.items[0].id,
    startedAt: '2026-10-14T01:00:00.000Z',
    endedAt: '2026-10-14T01:05:00.000Z',
    reason: '核对用时',
  });
  await command({ type: 'start', itemId: initial.items[1].id });
  const before = await snapshot();
  const finishedBefore = before.runs.find((run) => run.id === started.id)!;
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const recent = page.getByRole('region', { name: '最近记录' });
  await recent.getByRole('button', { name: '复制最近记录文件夹 TA-01', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(started.filename);
  await expect(page.locator('.plan-page')).toBeVisible();
  await expect(page.locator('.live-page')).toHaveCount(0);
  const after = await snapshot();
  const finished = after.runs.find((run) => run.id === started.id)!;
  expect(finished.filename).toBe(started.filename);
  expect(finished.originalStartedAt).toBe(started.originalStartedAt);
  expect(finished.originalEndedAt).toBe(finishedBefore.originalEndedAt);
  expect(finished.snapshot.group.thickness).toBe('0.8');
  expect(after.runs.find((run) => run.itemId === initial.items[1].id)?.endedAt).toBeNull();
  expect(after.items.find((item) => item.id === initial.items[1].id)?.status).toBe('running');
  expect(after.runs).toHaveLength(2);
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(2);
});

test('the latest scan can be copied from the plan, live page and overview without writing', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  await command({
    type: 'times',
    itemId: initial.items[0].id,
    startedAt: '2026-10-14T01:00:00.000Z',
    endedAt: '2026-10-14T01:05:00.000Z',
    reason: '核对用时',
  });
  await command({
    type: 'saveRun',
    runId: started.id,
    notes: '只写备注',
    actual: { scanId: 'SCAN-LAST-1' },
  });
  await command({ type: 'finish', itemId: initial.items[0].id });
  await command({ type: 'start', itemId: initial.items[1].id });
  const before = await snapshot();
  const finishedBefore = before.runs.find((run) => run.id === started.id)!;
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const recent = page.getByRole('region', { name: '最近记录', exact: true });
  await expect(recent).toContainText('扫描 SCAN-LAST-1');
  await expect(recent).not.toContainText('只写备注');
  await recent.getByRole('button', { name: '复制最近记录扫描编号 TA-01', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('SCAN-LAST-1');
  await expect(page.locator('.plan-page')).toBeVisible();
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  const liveRecent = page.getByRole('region', { name: '最近记录', exact: true });
  await liveRecent.getByRole('button', { name: '复制最近记录扫描编号 TA-01', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('SCAN-LAST-1');
  await expect(page.locator('.current-heading')).toContainText('TA-02');
  await expect(page.locator('.current-heading')).toContainText('进行中');
  await page.getByRole('button', { name: '实验概览', exact: true }).click();
  const overview = page.getByRole('dialog', { name: '实验概览', exact: true });
  const overviewRecent = overview.getByRole('region', { name: '最近记录', exact: true });
  await expect(overviewRecent).toContainText('最近完成');
  await expect(overviewRecent).toContainText('TA-01');
  await expect(overviewRecent).toContainText('SCAN-LAST-1');
  await expect(overviewRecent).toContainText(started.filename);
  await expect(overviewRecent).not.toContainText('只写备注');
  await overviewRecent.getByRole('button', { name: '复制最近记录扫描编号 TA-01', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('SCAN-LAST-1');
  await expect(overview).toBeVisible();
  await overviewRecent.getByRole('button', { name: '打开最近记录 TA-01', exact: true }).click();
  await expect(page.locator('.live-page')).toBeVisible();
  await expect(page.locator('.current-heading')).toContainText('正在查看');
  await expect(page.locator('.current-heading')).toContainText('TA-01');
  await command({ type: 'saveRun', runId: started.id, actual: { scanId: 'beam/scan' } });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '复制最近记录扫描编号 TA-01', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '实验概览', exact: true }).click();
  await expect(
    page
      .getByRole('dialog', { name: '实验概览', exact: true })
      .getByRole('button', { name: '复制最近记录扫描编号 TA-01', exact: true }),
  ).toHaveCount(0);
  const after = await snapshot();
  const finished = after.runs.find((run) => run.id === started.id)!;
  expect(finished.actual.scanId).toBe('beam/scan');
  expect(finished.filename).toBe(started.filename);
  expect(finished.originalStartedAt).toBe(started.originalStartedAt);
  expect(finished.originalEndedAt).toBe(finishedBefore.originalEndedAt);
  expect(finished.snapshot.group.thickness).toBe('0.8');
  expect(finished.notes).toBe('只写备注');
  expect(after.runs.find((run) => run.itemId === initial.items[1].id)?.endedAt).toBeNull();
  expect(after.items.find((item) => item.id === initial.items[1].id)?.status).toBe('running');
  expect(after.runs).toHaveLength(2);
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(2);
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('review and the live heading name only the latest finished operation', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'addEvent',
    experimentId: initial.experiments[0].id,
    itemId: initial.items[0].id,
    runId: run.id,
    eventType: 'issue',
    text: '样品定位偏离',
  });
  await command({ type: 'saveRun', runId: run.id, notes: '只写备注' });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const finished = (await snapshot()).runs[0];
  await page.reload();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const finishedRow = page.locator('.review-table tbody tr', { hasText: 'TA-01' });
  const pendingRow = page.locator('.review-table tbody tr', { hasText: 'TA-02' });
  await expect(finishedRow.locator('.review-latest')).toHaveText('最近完成');
  await expect(pendingRow.locator('.review-latest')).toHaveCount(0);
  await expect(finishedRow.locator('.review-latest')).not.toContainText('只写备注');
  await expect(finishedRow.locator('.review-latest')).not.toContainText('样品定位偏离');
  await page.getByLabel('搜索操作记录', { exact: true }).fill('最近完成');
  await expect(finishedRow).toBeVisible();
  await expect(pendingRow).toHaveCount(0);
  await page.getByLabel('搜索操作记录', { exact: true }).fill('样品定位偏离');
  await expect(page.locator('.review-table tbody tr', { hasText: 'TA-01' })).toHaveCount(0);
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true }).click();
  await expect(page.locator('.current-heading')).toContainText('最近完成');
  await expect(page.locator('.current-heading')).not.toContainText('只写备注');
  await expect(page.locator('.current-heading')).not.toContainText('样品定位偏离');
  await page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true }).click();
  await expect(page.locator('.current-heading')).not.toContainText('最近完成');
  await page.getByLabel('搜索待测样品', { exact: true }).fill('最近完成');
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true })).toHaveCount(0);
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].notes).toBe('只写备注');
  expect(after.runs[0].snapshot).toEqual(finished.snapshot);
  expect(after.runs[0].originalStartedAt).toBe(finished.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(finished.originalEndedAt);
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('completed');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the latest record shows the end clock saved with that run', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  await command({ type: 'finish', itemId: initial.items[0].id });
  const completed = (await snapshot()).runs[0];
  await command({
    type: 'times',
    itemId: initial.items[0].id,
    startedAt: '2026-10-14T01:00:00.000Z',
    endedAt: '2026-10-14T01:05:00.000Z',
    reason: '核对用时',
  });
  const finished = (await snapshot()).runs[0];
  const clock = recordedClock(finished.endedAt, finished.offsetMinutes, finished.timezone);
  expect(clock).toBeTruthy();
  const label = `结束 ${clock!.clock} ${clock!.zone}`;
  await page.reload();
  const recent = page.getByRole('region', { name: '最近记录', exact: true });
  await expect(recent).toContainText(label);
  await expect(recent).toContainText('用时 5 分 00 秒');
  await expect(recent).not.toContainText('核对装样方向');
  await page.locator('h1').click();
  await page.keyboard.press('Control+K');
  const library = page.getByRole('dialog', { name: '全库搜索' });
  await expect(library.getByRole('option', { name: '查看最近记录 TA-01', exact: true })).toContainText(
    label,
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true }).click();
  await expect(page.getByRole('region', { name: '最近记录', exact: true })).toContainText(label);
  await page.getByLabel('搜索待测样品', { exact: true }).fill(clock!.clock);
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '实验概览', exact: true }).click();
  await expect(
    page
      .getByRole('dialog', { name: '实验概览', exact: true })
      .getByRole('region', { name: '最近记录', exact: true }),
  ).toContainText(label);
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].endedAt).toBe(finished.endedAt);
  expect(after.runs[0].originalStartedAt).toBe(started.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(completed.originalEndedAt);
  expect(after.runs[0].offsetMinutes).toBe(finished.offsetMinutes);
  expect(after.runs[0].timezone).toBe(finished.timezone);
  expect(after.runs[0].snapshot).toEqual(finished.snapshot);
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('completed');
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('finished queue and measurement rows show the saved end clock', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  await command({ type: 'finish', itemId: initial.items[0].id });
  const completed = (await snapshot()).runs[0];
  await command({
    type: 'times',
    itemId: initial.items[0].id,
    startedAt: '2026-10-14T01:00:00.000Z',
    endedAt: '2026-10-14T01:05:00.000Z',
    reason: '核对用时',
  });
  await command({ type: 'start', itemId: initial.items[1].id });
  const finished = (await snapshot()).runs.find((run) => run.id === started.id)!;
  const clock = recordedClock(finished.endedAt, finished.offsetMinutes, finished.timezone);
  expect(clock).toBeTruthy();
  const label = `结束 ${clock!.clock} ${clock!.zone}`;
  await page.reload();
  const finishedChoice = page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true });
  const runningChoice = page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true });
  await expect(finishedChoice).toContainText(label);
  await expect(runningChoice).not.toContainText(clock!.clock);
  await page.getByLabel('搜索待测样品', { exact: true }).fill(clock!.clock);
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await page.getByRole('button', { name: '展开 Ti-A-热处理' }).click();
  await expect(page.getByRole('button', { name: '查看 TA-01 操作 1 已完成', exact: true })).toContainText(
    label,
  );
  await expect(
    page.getByRole('button', { name: '查看 TA-02 操作 2 进行中', exact: true }),
  ).not.toContainText(clock!.clock);
  const planner = page.getByRole('region', { name: '测量计划', exact: true });
  await expect(planner.locator('tr', { hasText: 'TA-01' })).toContainText(label);
  await expect(planner.locator('tr', { hasText: 'TA-02' })).not.toContainText(clock!.clock);
  await planner.getByLabel('搜索测量计划', { exact: true }).fill(clock!.clock);
  await expect(planner.locator('tr', { hasText: 'TA-01' })).toHaveCount(0);
  const after = await snapshot();
  const kept = after.runs.find((run) => run.id === started.id)!;
  expect(kept.endedAt).toBe(finished.endedAt);
  expect(kept.originalStartedAt).toBe(started.originalStartedAt);
  expect(kept.originalEndedAt).toBe(completed.originalEndedAt);
  expect(kept.snapshot.group.thickness).toBe('0.8');
  expect(after.runs.find((run) => run.itemId === initial.items[1].id)?.endedAt).toBeNull();
  expect(after.items.find((item) => item.id === initial.items[1].id)?.status).toBe('running');
  expect(after.runs).toHaveLength(2);
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('focus mode keeps the saved end clock on the current finished sample', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  await command({ type: 'finish', itemId: initial.items[0].id });
  const completed = (await snapshot()).runs[0];
  await command({
    type: 'times',
    itemId: initial.items[0].id,
    startedAt: '2026-10-14T01:00:00.000Z',
    endedAt: '2026-10-14T01:05:00.000Z',
    reason: '核对用时',
  });
  const finished = (await snapshot()).runs[0];
  const clock = recordedClock(finished.endedAt, finished.offsetMinutes, finished.timezone);
  expect(clock).toBeTruthy();
  const label = `结束 ${clock!.clock} ${clock!.zone}`;
  await page.reload();
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await expect(page.locator('.current-heading')).not.toContainText(clock!.clock);
  await page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true }).click();
  await page.getByRole('button', { name: '专注当前样品', exact: true }).click();
  await expect(page.locator('.queue')).toHaveCount(0);
  await expect(page.locator('.current-heading')).toContainText(label);
  await expect(page.locator('.current-heading')).toContainText('最近完成');
  await expect(page.locator('.current-heading')).not.toContainText('核对装样方向');
  await page.getByRole('button', { name: '队列与搜索', exact: true }).click();
  const queue = page.getByRole('dialog', { name: '待测队列与搜索' });
  await queue.getByLabel('搜索待测样品', { exact: true }).fill(clock!.clock);
  await expect(queue.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true })).toHaveCount(
    0,
  );
  await queue.getByLabel('搜索待测样品', { exact: true }).fill('');
  await queue.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true }).click();
  await expect(page.locator('.current-heading')).not.toContainText(clock!.clock);
  await expect(page.locator('.live-page')).toHaveClass(/is-focused/);
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].endedAt).toBe(finished.endedAt);
  expect(after.runs[0].originalStartedAt).toBe(started.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(completed.originalEndedAt);
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('completed');
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the live page and overview copy the latest folder without leaving the current sample', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  await command({ type: 'finish', itemId: initial.items[0].id });
  const completed = (await snapshot()).runs[0];
  await command({ type: 'start', itemId: initial.items[1].id });
  await page.reload();
  const recent = page.getByRole('region', { name: '最近记录', exact: true });
  await recent.getByRole('button', { name: '复制最近记录文件夹 TA-01', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(started.filename);
  await expect(page.locator('.current-heading')).toContainText('TA-02');
  await expect(page.locator('.current-heading')).toContainText('进行中');
  await page.getByRole('button', { name: '实验概览', exact: true }).click();
  const overview = page.getByRole('dialog', { name: '实验概览', exact: true });
  await overview.getByRole('button', { name: '复制最近记录文件夹 TA-01', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(started.filename);
  await expect(overview).toBeVisible();
  const after = await snapshot();
  const kept = after.runs.find((run) => run.id === started.id)!;
  expect(kept.filename).toBe(started.filename);
  expect(kept.originalStartedAt).toBe(started.originalStartedAt);
  expect(kept.originalEndedAt).toBe(completed.originalEndedAt);
  expect(kept.snapshot.group.thickness).toBe('0.8');
  expect(after.runs.find((run) => run.itemId === initial.items[1].id)?.endedAt).toBeNull();
  expect(after.items.find((item) => item.id === initial.items[1].id)?.status).toBe('running');
  expect(after.runs).toHaveLength(2);
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('a running operation shows its saved start clock and not an end clock', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  const clock = recordedClock(started.startedAt, started.offsetMinutes, started.timezone);
  expect(clock).toBeTruthy();
  const label = `开始 ${clock!.clock} ${clock!.zone}`;
  await page.reload();
  const runningChoice = page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true });
  await expect(runningChoice).toContainText(label);
  await expect(runningChoice).toContainText('用时 未计入');
  await expect(runningChoice).not.toContainText('结束 ');
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true })).not.toContainText(
    clock!.clock,
  );
  await page.getByLabel('搜索待测样品', { exact: true }).fill(clock!.clock);
  await expect(page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await page.getByRole('button', { name: '展开 Ti-A-热处理' }).click();
  await expect(page.getByRole('button', { name: '查看 TA-01 操作 1 进行中', exact: true })).toContainText(
    label,
  );
  await expect(
    page.getByRole('button', { name: '查看 TA-01 操作 1 进行中', exact: true }),
  ).not.toContainText('结束 ');
  const planner = page.getByRole('region', { name: '测量计划', exact: true });
  await expect(planner.locator('tr', { hasText: 'TA-01' })).toContainText(label);
  await expect(planner.locator('tr', { hasText: 'TA-01' })).not.toContainText('结束 ');
  await planner.getByLabel('搜索测量计划', { exact: true }).fill(clock!.clock);
  await expect(planner.locator('tr', { hasText: 'TA-01' })).toHaveCount(0);
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].startedAt).toBe(started.startedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.runs[0].originalStartedAt).toBe(started.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBeNull();
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('running');
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('focus mode keeps the saved start clock in the current status line', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  const clock = recordedClock(started.startedAt, started.offsetMinutes, started.timezone);
  expect(clock).toBeTruthy();
  const label = `开始 ${clock!.clock} ${clock!.zone}`;
  await page.reload();
  await page.getByRole('button', { name: '专注当前样品', exact: true }).click();
  await expect(page.locator('.queue')).toHaveCount(0);
  await expect(page.locator('.current-heading')).toContainText('进行中');
  await expect(page.locator('.current-heading')).toContainText(label);
  await expect(page.locator('.current-heading')).not.toContainText('结束 ');
  await page.getByRole('button', { name: '队列与搜索', exact: true }).click();
  const queue = page.getByRole('dialog', { name: '待测队列与搜索' });
  await queue.getByLabel('搜索待测样品', { exact: true }).fill(clock!.clock);
  await expect(queue.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true })).toHaveCount(
    0,
  );
  await queue.getByLabel('搜索待测样品', { exact: true }).fill('');
  await queue.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true }).click();
  await expect(page.locator('.current-heading')).not.toContainText(clock!.clock);
  await expect(page.locator('.live-page')).toHaveClass(/is-focused/);
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].startedAt).toBe(started.startedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.runs[0].originalStartedAt).toBe(started.originalStartedAt);
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('running');
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('review shows the saved timezone under the start clock', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  const clock = recordedClock(started.startedAt, started.offsetMinutes, started.timezone);
  expect(clock).toBeTruthy();
  await page.reload();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const runningRow = page.locator('.review-table tbody tr', { hasText: 'TA-01' });
  const pendingRow = page.locator('.review-table tbody tr', { hasText: 'TA-02' });
  await expect(runningRow.locator('.review-clock-zone')).toHaveText(clock!.zone);
  await expect(runningRow).toContainText('未计入');
  await expect(pendingRow.locator('.review-clock-zone')).toHaveCount(0);
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].startedAt).toBe(started.startedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.runs[0].originalStartedAt).toBe(started.originalStartedAt);
  expect(after.runs[0].timezone).toBe(started.timezone);
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('running');
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the queue and measurement plan show a saved file name and not the file reference', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: started.id,
    notes: '只写备注',
    actual: { filename: 'frame-001.cbf', files: 'E:\\raw\\hidden.cbf' },
  });
  await page.reload();
  const choice = page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true });
  await expect(choice).toContainText('文件 frame-001.cbf');
  await expect(choice).not.toContainText('hidden.cbf');
  await expect(choice).not.toContainText('只写备注');
  await expect(page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true })).not.toContainText(
    'frame-001.cbf',
  );
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await page.getByRole('button', { name: '展开 Ti-A-热处理' }).click();
  await expect(page.getByRole('button', { name: '查看 TA-01 操作 1 进行中', exact: true })).toContainText(
    '文件 frame-001.cbf',
  );
  await expect(
    page.getByRole('button', { name: '查看 TA-02 操作 2 待测', exact: true }),
  ).not.toContainText('frame-001.cbf');
  const planner = page.getByRole('region', { name: '测量计划', exact: true });
  await expect(planner.locator('tr', { hasText: 'TA-01' })).toContainText('文件 frame-001.cbf');
  await expect(planner.locator('tr', { hasText: 'TA-01' })).not.toContainText('hidden.cbf');
  await expect(planner.locator('tr', { hasText: 'TA-02' })).not.toContainText('frame-001.cbf');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actual.filename).toBe('frame-001.cbf');
  expect(after.runs[0].actual.files).toBe('E:\\raw\\hidden.cbf');
  expect(after.runs[0].notes).toBe('只写备注');
  expect(after.runs[0].originalStartedAt).toBe(started.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('running');
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('focus mode keeps the saved file name in the current status line', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: started.id,
    notes: '只写备注',
    actual: { filename: 'frame-001.cbf', files: 'E:\\raw\\hidden.cbf' },
  });
  await page.reload();
  await page.getByRole('button', { name: '专注当前样品', exact: true }).click();
  await expect(page.locator('.queue')).toHaveCount(0);
  await expect(page.locator('.current-heading')).toContainText('文件 frame-001.cbf');
  await expect(page.locator('.current-heading')).not.toContainText('hidden.cbf');
  await expect(page.locator('.current-heading')).not.toContainText('只写备注');
  await page.getByRole('button', { name: '队列与搜索', exact: true }).click();
  const queue = page.getByRole('dialog', { name: '待测队列与搜索' });
  await queue.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true }).click();
  await expect(page.locator('.current-heading')).not.toContainText('frame-001.cbf');
  await expect(page.locator('.live-page')).toHaveClass(/is-focused/);
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actual.filename).toBe('frame-001.cbf');
  expect(after.runs[0].actual.files).toBe('E:\\raw\\hidden.cbf');
  expect(after.runs[0].notes).toBe('只写备注');
  expect(after.runs[0].originalStartedAt).toBe(started.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('running');
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the latest record names its saved file and not the file reference', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: started.id,
    notes: '只写备注',
    actual: { filename: 'frame-001.cbf', files: 'E:\\raw\\hidden.cbf' },
  });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const finished = (await snapshot()).runs[0];
  await command({ type: 'start', itemId: initial.items[1].id });
  await page.reload();
  const recent = page.getByRole('region', { name: '最近记录', exact: true });
  await expect(recent).toContainText('文件 frame-001.cbf');
  await expect(recent).not.toContainText('hidden.cbf');
  await expect(recent).not.toContainText('只写备注');
  await expect(page.locator('.current-heading')).not.toContainText('frame-001.cbf');
  await page.locator('h1').click();
  await page.keyboard.press('Control+K');
  const library = page.getByRole('dialog', { name: '全库搜索' });
  await expect(library.getByRole('option', { name: '查看最近记录 TA-01', exact: true })).toContainText(
    '文件 frame-001.cbf',
  );
  await expect(library.getByRole('option', { name: '查看最近记录 TA-01', exact: true })).not.toContainText(
    'hidden.cbf',
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '实验概览', exact: true }).click();
  const overview = page.getByRole('dialog', { name: '实验概览', exact: true });
  await expect(overview.getByRole('region', { name: '最近记录', exact: true })).toContainText(
    '文件 frame-001.cbf',
  );
  await expect(overview.getByRole('region', { name: '最近记录', exact: true })).not.toContainText(
    'hidden.cbf',
  );
  const after = await snapshot();
  const kept = after.runs.find((run) => run.id === started.id)!;
  expect(kept.actual.filename).toBe('frame-001.cbf');
  expect(kept.actual.files).toBe('E:\\raw\\hidden.cbf');
  expect(kept.notes).toBe('只写备注');
  expect(kept.originalStartedAt).toBe(started.originalStartedAt);
  expect(kept.originalEndedAt).toBe(finished.originalEndedAt);
  expect(kept.snapshot.group.thickness).toBe('0.8');
  expect(after.runs.find((run) => run.itemId === initial.items[1].id)?.endedAt).toBeNull();
  expect(after.items.find((item) => item.id === initial.items[1].id)?.status).toBe('running');
  expect(after.runs).toHaveLength(2);
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the latest actual file name can be copied without leaving the current sample', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: started.id,
    notes: '只写备注',
    actual: { filename: 'frame-001.cbf', files: 'E:\\raw\\hidden.cbf' },
  });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const finished = (await snapshot()).runs[0];
  await command({ type: 'start', itemId: initial.items[1].id });
  await page.reload();
  const recent = page.getByRole('region', { name: '最近记录', exact: true });
  await recent.getByRole('button', { name: '复制最近记录文件名 TA-01', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('frame-001.cbf');
  await expect(page.locator('.current-heading')).toContainText('TA-02');
  await expect(page.locator('.current-heading')).toContainText('进行中');
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await page
    .getByRole('region', { name: '最近记录', exact: true })
    .getByRole('button', { name: '复制最近记录文件名 TA-01', exact: true })
    .click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('frame-001.cbf');
  await expect(page.locator('.plan-page')).toBeVisible();
  await page.getByRole('button', { name: '实验概览', exact: true }).click();
  const overview = page.getByRole('dialog', { name: '实验概览', exact: true });
  await overview.getByRole('button', { name: '复制最近记录文件名 TA-01', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('frame-001.cbf');
  await expect(overview).toBeVisible();
  await page.keyboard.press('Escape');
  await command({
    type: 'saveRun',
    runId: started.id,
    actual: { filename: 'E:\\raw\\hidden.cbf' },
  });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '复制最近记录文件名 TA-01', exact: true }),
  ).toHaveCount(0);
  const after = await snapshot();
  const kept = after.runs.find((run) => run.id === started.id)!;
  expect(kept.actual.filename).toBe('E:\\raw\\hidden.cbf');
  expect(kept.actual.files).toBe('E:\\raw\\hidden.cbf');
  expect(kept.notes).toBe('只写备注');
  expect(kept.originalStartedAt).toBe(started.originalStartedAt);
  expect(kept.originalEndedAt).toBe(finished.originalEndedAt);
  expect(kept.snapshot.group.thickness).toBe('0.8');
  expect(after.runs.find((run) => run.itemId === initial.items[1].id)?.endedAt).toBeNull();
  expect(after.items.find((item) => item.id === initial.items[1].id)?.status).toBe('running');
  expect(after.runs).toHaveLength(2);
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the running operation shows and copies its saved file name from another sample', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: started.id,
    notes: '只写备注',
    actual: { filename: 'frame-001.cbf', files: 'E:\\raw\\hidden.cbf' },
  });
  await page.reload();
  await page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true }).click();
  const banner = page.getByRole('region', { name: '现场进行中的操作', exact: true });
  await expect(banner).toContainText('文件 frame-001.cbf');
  await expect(banner).not.toContainText('hidden.cbf');
  await expect(banner).not.toContainText('只写备注');
  await banner.getByRole('button', { name: '复制进行中的实际文件名', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('frame-001.cbf');
  await expect(page.locator('.current-heading')).toContainText('TA-02');
  await page.getByRole('button', { name: '实验概览', exact: true }).click();
  const overview = page.getByRole('dialog', { name: '实验概览', exact: true });
  await expect(overview.getByRole('region', { name: '全库进行中的操作', exact: true })).toContainText(
    '文件 frame-001.cbf',
  );
  await overview.getByRole('button', { name: '在概览中复制进行中的实际文件名', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('frame-001.cbf');
  await expect(overview).toBeVisible();
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actual.filename).toBe('frame-001.cbf');
  expect(after.runs[0].actual.files).toBe('E:\\raw\\hidden.cbf');
  expect(after.runs[0].notes).toBe('只写备注');
  expect(after.runs[0].originalStartedAt).toBe(started.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('running');
  expect(after.items.find((item) => item.id === initial.items[1].id)?.status).toBe('pending');
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the plan and review bars copy the running file name without returning to live', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: started.id,
    notes: '只写备注',
    actual: { filename: 'frame-001.cbf', files: 'E:\\raw\\hidden.cbf' },
  });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const planBar = page.getByRole('region', { name: '进行中的操作', exact: true });
  await expect(planBar).toContainText('文件 frame-001.cbf');
  await expect(planBar).not.toContainText('hidden.cbf');
  await expect(planBar).not.toContainText('只写备注');
  await planBar.getByRole('button', { name: '复制进行中的实际文件名', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('frame-001.cbf');
  await expect(page.locator('.plan-page')).toBeVisible();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const reviewBar = page.getByRole('region', { name: '进行中的操作', exact: true });
  await expect(reviewBar).toContainText('文件 frame-001.cbf');
  await reviewBar.getByRole('button', { name: '复制进行中的实际文件名', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('frame-001.cbf');
  await expect(page.locator('.review-page')).toBeVisible();
  await expect(page.locator('.live-page')).toHaveCount(0);
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actual.filename).toBe('frame-001.cbf');
  expect(after.runs[0].actual.files).toBe('E:\\raw\\hidden.cbf');
  expect(after.runs[0].notes).toBe('只写备注');
  expect(after.runs[0].originalStartedAt).toBe(started.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('running');
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('a running scan id can be copied from the plan, review, live and overview', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: started.id,
    notes: '只写备注',
    actual: { scanId: 'SCAN-RUN-1', files: 'E:\\raw\\hidden.cbf' },
  });
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const planBar = page.getByRole('region', { name: '进行中的操作', exact: true });
  await expect(planBar).toContainText('扫描 SCAN-RUN-1');
  await expect(planBar).not.toContainText('hidden.cbf');
  await expect(planBar).not.toContainText('只写备注');
  await planBar.getByRole('button', { name: '复制进行中的扫描编号', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('SCAN-RUN-1');
  await expect(page.locator('.plan-page')).toBeVisible();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await page
    .getByRole('region', { name: '进行中的操作', exact: true })
    .getByRole('button', { name: '复制进行中的扫描编号', exact: true })
    .click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('SCAN-RUN-1');
  await expect(page.locator('.review-page')).toBeVisible();
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true }).click();
  const banner = page.getByRole('region', { name: '现场进行中的操作', exact: true });
  await expect(banner).toContainText('扫描 SCAN-RUN-1');
  await expect(banner).not.toContainText('只写备注');
  await banner.getByRole('button', { name: '复制进行中的扫描编号', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('SCAN-RUN-1');
  await expect(page.locator('.current-heading')).toContainText('TA-02');
  await page.getByRole('button', { name: '实验概览', exact: true }).click();
  const overview = page.getByRole('dialog', { name: '实验概览', exact: true });
  await expect(overview.getByRole('region', { name: '全库进行中的操作', exact: true })).toContainText(
    '扫描 SCAN-RUN-1',
  );
  await overview.getByRole('button', { name: '在概览中复制进行中的扫描编号', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('SCAN-RUN-1');
  await expect(overview).toBeVisible();
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actual.scanId).toBe('SCAN-RUN-1');
  expect(after.runs[0].actual.files).toBe('E:\\raw\\hidden.cbf');
  expect(after.runs[0].notes).toBe('只写备注');
  expect(after.runs[0].originalStartedAt).toBe(started.originalStartedAt);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('running');
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the experiment library names the running operation without estimating its duration', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: started.id,
    notes: '只写备注',
    actual: { scanId: 'SCAN-RUN-1', filename: 'frame-001.cbf', files: 'E:\\raw\\hidden.cbf' },
  });
  await page.reload();
  await page.locator('h1').click();
  await page.keyboard.press('Control+K');
  const library = page.getByRole('dialog', { name: '全库搜索' });
  const running = library.getByRole('option', { name: '返回进行中 TA-01', exact: true });
  await expect(running).toContainText('用时未计入');
  await expect(running).toContainText('扫描 SCAN-RUN-1');
  await expect(running).toContainText('文件 frame-001.cbf');
  await expect(running).toContainText(started.filename);
  await expect(running).not.toContainText('hidden.cbf');
  await expect(running).not.toContainText('只写备注');
  await expect(running).not.toContainText('结束 ');
  await running.click();
  await expect(page.locator('.live-page')).toBeVisible();
  await expect(page.locator('.current-heading')).toContainText('TA-01');
  await expect(page.locator('.current-heading')).toContainText('正在操作');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.runs[0].originalStartedAt).toBe(started.originalStartedAt);
  expect(after.runs[0].actual.scanId).toBe('SCAN-RUN-1');
  expect(after.runs[0].actual.filename).toBe('frame-001.cbf');
  expect(after.runs[0].actual.files).toBe('E:\\raw\\hidden.cbf');
  expect(after.runs[0].notes).toBe('只写备注');
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('running');
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('search opens the running operation when the duration is still uncounted', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  await command({
    type: 'saveRun',
    runId: started.id,
    notes: '只写备注',
    actual: { scanId: 'SCAN-RUN-1', files: 'E:\\raw\\hidden.cbf' },
  });
  await page.reload();
  await page.locator('h1').click();
  await page.keyboard.press('Control+K');
  const library = page.getByRole('dialog', { name: '全库搜索' });
  await library.getByRole('combobox', { name: '全库搜索', exact: true }).fill('用时未计入');
  const hit = library.getByRole('option').filter({ hasText: '用时未计入' });
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText('TA-01');
  await expect(hit).toContainText('扫描 SCAN-RUN-1');
  await expect(hit).not.toContainText('只写备注');
  await expect(hit).not.toContainText('hidden.cbf');
  await library.getByRole('combobox', { name: '全库搜索', exact: true }).fill('只写备注');
  await expect(library.getByRole('option').filter({ hasText: '用时未计入' })).toHaveCount(0);
  await library.getByRole('combobox', { name: '全库搜索', exact: true }).fill('用时未计入');
  await library.getByRole('option').filter({ hasText: '用时未计入' }).click();
  await expect(page.locator('.live-page')).toBeVisible();
  await expect(page.locator('.current-heading')).toContainText('正在操作');
  await expect(page.locator('.current-heading')).toContainText('TA-01');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].endedAt).toBeNull();
  expect(after.runs[0].originalStartedAt).toBe(started.originalStartedAt);
  expect(after.runs[0].actual.scanId).toBe('SCAN-RUN-1');
  expect(after.runs[0].notes).toBe('只写备注');
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('running');
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('the plan page schedules one retest from the latest finished record', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const started = (await snapshot()).runs[0];
  await command({
    type: 'times',
    itemId: initial.items[0].id,
    startedAt: '2026-10-14T01:00:00.000Z',
    endedAt: '2026-10-14T01:05:00.000Z',
    reason: '核对用时',
  });
  await command({ type: 'start', itemId: initial.items[1].id });
  const before = await snapshot();
  const finishedBefore = before.runs.find((run) => run.id === started.id)!;
  await page.reload();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  const recent = page.getByRole('region', { name: '最近记录' });
  const schedule = recent.getByRole('button', { name: '安排最近记录的重测 TA-01', exact: true });
  await schedule.click();
  await expect(page.locator('.plan-page')).toBeVisible();
  await page.getByRole('button', { name: '展开 Ti-A-热处理', exact: true }).click();
  await expect(page.getByRole('group', { name: 'TA-01 的操作' }).getByRole('button', { name: /查看 TA-01 操作 \d+ 待测/ })).toBeVisible();
  await schedule.click();
  await expect(page.getByRole('group', { name: 'TA-01 的操作' }).getByRole('button', { name: /查看 TA-01 操作/ })).toHaveCount(2);
  const after = await snapshot();
  const retests = after.items.filter((item) => item.repeatOf === initial.items[0].id);
  expect(retests).toHaveLength(1);
  expect(retests[0].status).toBe('pending');
  expect(retests[0].sampleId).toBe(initial.items[0].sampleId);
  expect(after.samples).toHaveLength(initial.samples.length);
  expect(after.runs).toHaveLength(2);
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('completed');
  expect(after.items.find((item) => item.id === initial.items[1].id)?.status).toBe('running');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
  const finished = after.runs.find((run) => run.id === started.id)!;
  expect(finished.originalStartedAt).toBe(started.originalStartedAt);
  expect(finished.originalEndedAt).toBe(finishedBefore.originalEndedAt);
  expect(finished.snapshot.group.thickness).toBe('0.8');
  expect(after.runs.find((run) => run.itemId === initial.items[1].id)?.endedAt).toBeNull();
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('review can correct the actual thickness without changing the start snapshot', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await page.reload();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const row = page.locator('.review-table tbody tr', { hasText: 'TA-01' });
  const pending = page.locator('.review-table tbody tr', { hasText: 'TA-02' });
  await expect(
    pending.getByRole('button', { name: '修改实际尺寸 TA-02 操作 2', exact: true }),
  ).toHaveCount(0);
  await row.getByRole('button', { name: '修改实际尺寸 TA-01 操作 1', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修改实际尺寸' });
  await expect(dialog.getByLabel('实际厚度', { exact: true })).toHaveValue('0.8');
  await dialog.getByLabel('实际厚度', { exact: true }).fill('1.1');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await snapshot()).runs[0].actual.thickness).toBe('0.8');
  await row.getByRole('button', { name: '修改实际尺寸 TA-01 操作 1', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '修改实际尺寸' });
  await editor.getByLabel('实际厚度', { exact: true }).fill('1.1');
  await editor.getByLabel('厚度单位', { exact: true }).fill('mm');
  await editor.getByRole('button', { name: '保存实际尺寸', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(row.getByRole('list', { name: 'TA-01 与开始时计划不同' })).toContainText('1.1 mm');
  await expect(row.getByRole('list', { name: 'TA-01 与开始时计划不同' })).toContainText('0.8 mm');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actual.thickness).toBe('1.1');
  expect(after.runs[0].actual.thicknessUnit).toBe('mm');
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.runs[0].startedAt).toBe(run.startedAt);
  expect(after.runs[0].endedAt).toBe(run.endedAt);
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(run.originalEndedAt);
  expect(after.items.find((item) => item.id === initial.items[0].id)?.status).toBe('completed');
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('review can correct the actual width and leaves the height blank', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await page.reload();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const row = page.locator('.review-table tbody tr', { hasText: 'TA-01' });
  await row.getByRole('button', { name: '修改实际尺寸 TA-01 操作 1', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修改实际尺寸' });
  await expect(dialog.getByLabel('实际宽度', { exact: true })).toHaveValue('3');
  await expect(dialog.getByLabel('实际高度', { exact: true })).toHaveValue('');
  await dialog.getByLabel('实际宽度', { exact: true }).fill('2.5');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect((await snapshot()).runs[0].actualSample?.width).toBe('3');
  await row.getByRole('button', { name: '修改实际尺寸 TA-01 操作 1', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '修改实际尺寸' });
  await editor.getByLabel('实际宽度', { exact: true }).fill('2.5');
  await editor.getByRole('button', { name: '保存实际尺寸', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(row.getByRole('list', { name: 'TA-01 与开始时计划不同' })).toContainText('2.5 mm');
  await expect(row.getByRole('list', { name: 'TA-01 与开始时计划不同' })).toContainText('3 mm');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actualSample?.width).toBe('2.5');
  expect(after.runs[0].actualSample?.height).toBe('');
  expect(after.runs[0].snapshot.group.width).toBe('3');
  expect(after.runs[0].snapshot.group.height).toBe('');
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(run.originalEndedAt);
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('review keeps only records whose actual plan differs from the start', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  await command({ type: 'finish', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({ type: 'saveRun', runId: run.id, notes: '只写备注', actual: { filename: 'beam.tif' } });
  await command({
    type: 'updateGroups',
    ids: [initial.groups[0].id],
    patch: { thickness: '9.9' },
  });
  await page.reload();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await expect(page.getByRole('button', { name: '实际已改', exact: true })).toHaveCount(0);
  await expect(page.locator('.review-table tbody tr', { hasText: 'TA-01' })).toContainText('当前计划已不同');
  await command({
    type: 'saveRun',
    runId: run.id,
    actual: { thickness: '1.1', thicknessUnit: 'mm' },
  });
  await page.reload();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await page.getByRole('button', { name: '实际已改', exact: true }).click();
  await expect(page.locator('.review-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.review-table tbody tr')).toContainText('TA-01');
  await expect(page.locator('.review-table tbody tr')).toContainText('1.1 mm');
  await expect(page.locator('.review-table')).not.toContainText('TA-02');
  await page.getByLabel('按状态筛选', { exact: true }).selectOption('pending');
  await expect(page.getByText('没有符合条件的记录')).toBeVisible();
  await page.getByLabel('按状态筛选', { exact: true }).selectOption('');
  await expect(page.locator('.review-table tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: '实际已改', exact: true }).click();
  await expect(page.locator('.review-table tbody tr')).toHaveCount(4);
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].actual.thickness).toBe('1.1');
  expect(after.runs[0].actual.filename).toBe('beam.tif');
  expect(after.runs[0].notes).toBe('只写备注');
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].originalEndedAt).toBe(run.originalEndedAt);
  expect(after.items.filter((item) => item.status === 'pending')).toHaveLength(3);
  expect(after.groups.find((group) => group.id === initial.groups[0].id)?.preparedCount).toBe(6);
});

test('search finds a started sample by the thickness changed after start', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'updateGroups',
    ids: [initial.groups[0].id],
    patch: { notes: '只改备注' },
  });
  await command({
    type: 'updateSamples',
    ids: [initial.items[0].sampleId],
    parameters: { thickness: '1.5' },
  });
  await page.reload();
  await expect(page.locator('.live-page')).toBeVisible();
  await page.getByLabel('搜索待测样品', { exact: true }).fill('1.5');
  await expect(page.locator('.queue-row')).toHaveCount(1);
  await expect(page.locator('.queue-row')).toContainText('TA-01');
  await page.getByLabel('搜索待测样品', { exact: true }).fill('只改备注');
  await expect(page.getByText('没有符合筛选条件的操作')).toBeVisible();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await page.getByLabel('搜索操作记录', { exact: true }).fill('1.5');
  await expect(page.locator('.review-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.review-table tbody tr')).toContainText('TA-01');
  await page.getByRole('button', { name: '全库搜索', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '全库搜索' });
  await dialog.getByRole('combobox', { name: '全库搜索', exact: true }).fill('1.5');
  await expect(dialog.getByRole('option')).toContainText('TA-01');
  await expect(dialog.getByRole('option')).toContainText('当前计划已不同');
  await page.keyboard.press('Escape');
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
});

test('review shows plan drift for the started sample only', async () => {
  const initial = await snapshot();
  await command({ type: 'start', itemId: initial.items[0].id });
  const run = (await snapshot()).runs[0];
  await command({
    type: 'updateSamples',
    ids: [initial.items[0].sampleId],
    parameters: { thickness: '1.5' },
  });
  await page.reload();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const started = page.locator('.review-table tbody tr', { hasText: 'TA-01' });
  const pending = page.locator('.review-table tbody tr', { hasText: 'TA-02' });
  await expect(started.locator('.review-plan-drift')).toHaveText('当前计划已不同：尺寸 厚 1.5 mm · 宽 3 mm');
  await expect(pending.locator('.review-plan-drift')).toHaveCount(0);
  const after = await snapshot();
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].snapshot.group.thickness).toBe('0.8');
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
});
