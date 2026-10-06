import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Command, Snapshot } from '../src/shared/model.js';
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
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
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
