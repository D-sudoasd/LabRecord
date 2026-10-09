import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, readdir, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { PNG } from './helpers.js';
import type { Snapshot, Command } from '../src/shared/model.js';

const require = createRequire(import.meta.url);
async function launch(directory: string) {
  const env = { ...process.env, LABRECORD_TEST_MODE: '1', LABRECORD_TEST_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({
    executablePath: process.env.LABRECORD_EXECUTABLE || require('electron'),
    args: process.env.LABRECORD_EXECUTABLE ? [] : [process.cwd()],
    env,
  });
  const page = await application.firstWindow();
  await expect(page.locator('.loading-screen')).toHaveCount(0);
  await expect(page.locator('.app-header')).toBeVisible();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
  return { application, page };
}
async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const result = await window.labrecord.snapshot();
    if (!result.ok) throw new Error(result.error);
    return result.data;
  });
}
async function command(page: Page, input: Command) {
  return page.evaluate(async (command) => {
    const reply = await window.labrecord.command(command, crypto.randomUUID());
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  }, input);
}
async function nativeFiles(
  application: ElectronApplication,
  paths: { open?: string[]; save?: string; response?: number },
) {
  await application.evaluate(({ dialog }, paths) => {
    if (paths.open)
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: paths.open!,
      })) as typeof dialog.showOpenDialog;
    if (paths.save)
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: paths.save,
      })) as typeof dialog.showSaveDialog;
    if (paths.response !== undefined)
      dialog.showMessageBox = (async () => ({
        response: paths.response!,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
  }, paths);
}
async function capture(application: ElectronApplication, path: string) {
  await (
    await application.firstWindow()
  ).evaluate(
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
let directory: string, application: ElectronApplication, page: Page;
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'labrecord-ui-'));
  ({ application, page } = await launch(directory));
});
test.afterEach(async () => {
  if (application?.process()?.exitCode === null) await application.close();
  if (
    !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
    !directory.split(sep).pop()?.startsWith('labrecord-ui-')
  )
    throw new Error('Unexpected test directory');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('Windows desktop: plan → notes/problem/image → finish → export → complete backup and restore', async ({}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const runtime = await application.evaluate(({ app, screen }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    electron: process.versions.electron,
    node: process.versions.node,
    sqlite: process.versions.sqlite,
    platform: process.platform,
    arch: process.arch,
    displayScale: screen.getPrimaryDisplay().scaleFactor,
  }));
  await writeFile(info.outputPath('runtime.json'), JSON.stringify(runtime, null, 2));
  await application.evaluate(({ shell }) => {
    shell.openPath = async (path) => {
      (globalThis as any).lastHelpPath = path;
      return '';
    };
  });
  await page.getByRole('button', { name: '打开使用说明' }).click();
  const helpPath = await application.evaluate(() => (globalThis as any).lastHelpPath as string);
  expect(await readFile(helpPath, 'utf8')).toContain('LabRecord 使用说明');
  await page.context().setOffline(true);
  await capture(application, info.outputPath('welcome.png'));
  await page.getByRole('button', { name: '载入演示实验' }).click();
  await expect(page.getByRole('heading', { name: '实验前，把样品安排好' })).toBeVisible();
  await expect(page.locator('tr', { hasText: 'Ti-A-热处理' }).locator('.count-cell')).toContainText(
    '2 备样',
  );
  await capture(application, info.outputPath('planning.png'));
  await page.getByRole('button', { name: '进入现场记录' }).click();
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  await expect(page.getByRole('button', { name: '完成并切换下一项' })).toBeVisible();
  const notesBox = await page.getByLabel('现场备注', { exact: true }).boundingBox();
  expect(notesBox!.y + notesBox!.height).toBeLessThanOrEqual(
    await page.evaluate(() => innerHeight),
  );
  const quickActions = await page.getByRole('group', { name: '现场快速记录' }).boundingBox();
  expect(quickActions!.y + quickActions!.height).toBeLessThanOrEqual(
    await page.evaluate(() => innerHeight),
  );
  await page.getByLabel('现场备注', { exact: true }).fill('试样对中后信号稳定；尺寸复核完成。');
  await expect(page.locator('.save-indicator')).toContainText('已保存到本机');
  await page.getByRole('button', { name: '记录问题', exact: true }).click();
  await page.getByLabel('发生了什么？').fill('装样方向需要重新确认。已调整夹具。');
  await page.getByLabel('发生了什么？').press('Control+Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const image = join(directory, '装样照片.png');
  await writeFile(image, PNG);
  await nativeFiles(application, { open: [image] });
  await page.getByRole('button', { name: '添加图片' }).click();
  await expect(page.getByRole('img', { name: '装样照片.png' })).toBeVisible();
  await expect
    .poll(async () =>
      page
        .getByRole('img', { name: '装样照片.png' })
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(1);
  await page.evaluate(() => window.scrollTo(0, 0));
  await capture(application, info.outputPath('live.png'));
  await page.getByRole('button', { name: '完成并切换下一项' }).click();
  await expect(page.locator('.current-heading h2')).toHaveText('TA-02');
  await expect(page.getByRole('button', { name: '开始操作', exact: true })).toBeEnabled();
  let data = await snapshot(page);
  expect(data.runs).toHaveLength(1);
  expect(data.items[1].status).toBe('pending');
  expect(data.runs[0].notes).toContain('尺寸复核');
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  for (const [format, name] of [
    ['xlsx', '导出 Excel'],
    ['csv', 'CSV'],
    ['json', 'JSON'],
  ]) {
    const output = join(directory, `实验记录.${format}`);
    await nativeFiles(application, { save: output });
    await page.getByRole('button', { name, exact: true }).click();
    await expect
      .poll(async () => {
        try {
          return (await readFile(output)).length;
        } catch {
          return 0;
        }
      })
      .toBeGreaterThan(0);
  }
  const exported = JSON.parse(await readFile(join(directory, '实验记录.json'), 'utf8'));
  expect(exported.schemaVersion).toBe(1);
  expect(exported.attachments).toHaveLength(1);
  await capture(application, info.outputPath('review.png'));
  await page.getByRole('button', { name: '打开设置' }).click();
  await page.getByRole('button', { name: '保存与备份', exact: true }).click();
  const backup = join(directory, '完整备份.labrecord');
  await nativeFiles(application, { save: backup });
  await page.getByRole('button', { name: '备份全部数据与附件' }).click();
  await expect
    .poll(async () => {
      try {
        return (await readFile(backup)).length;
      } catch {
        return 0;
      }
    })
    .toBeGreaterThan(0);
  await command(page, { type: 'createExperiment', code: 'AFTER-BACKUP', name: '备份之后的实验' });
  await nativeFiles(application, { open: [backup], response: 0 });
  await page.getByRole('button', { name: '恢复完整备份' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  data = await snapshot(page);
  expect(data.experiments).toHaveLength(1);
  expect(data.attachments).toHaveLength(1);
  expect(data.runs[0].notes).toContain('尺寸复核');
  expect(
    (await readdir(join(directory, 'backups'))).some((n) => n.startsWith('before-restore-')),
  ).toBe(true);
  const bytes = await readFile(join(directory, 'workspace', data.attachments[0].relativePath));
  expect(bytes.equals(PNG)).toBe(true);
  expect(errors).toEqual([]);
});

test('UI paste mapping imports legacy flags, null times and original states without scheduling tests', async () => {
  await page.getByRole('button', { name: '新建第一个实验' }).click();
  await page.getByLabel('实验名称 *').fill('材料实验');
  await page.getByLabel('实验编号 *').fill('0001');
  await page.getByRole('button', { name: '创建实验', exact: true }).click();
  await page.getByRole('button', { name: '粘贴多行' }).click();
  await page
    .getByLabel('表格文本')
    .fill(
      '已完成\t样品状态\t数量\tIn situ/Ex situ\t实验时间\t优先级\t厚度\t备注\n1\tTi-demo-375C-aged\t6\t\t\tP0\t\t旧表原文\n0\tTi-demo-reference\t1\t\t\tP0\t\t',
    );
  await page.getByRole('button', { name: '预览并映射字段' }).click();
  await expect(page.getByLabel('映射 准备数量')).toHaveValue('2');
  await page.getByRole('button', { name: '确认导入规划' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const data = await snapshot(page);
  expect(data.runs).toHaveLength(0);
  expect(data.items).toHaveLength(0);
  expect(data.groups[0].state).toBe('Ti-demo-375C-aged');
  expect(data.groups[0].legacyTime).toBe('');
  await page
    .locator('tr', { hasText: 'Ti-demo-375C-aged' })
    .getByRole('button', { name: '安排测试' })
    .click();
  await page.getByLabel('本次加入待测队列的数量 *').fill('4');
  await page.getByLabel('样品编号前缀').fill('NO-');
  await page.getByRole('button', { name: '加入待测队列' }).click();
  await expect(
    page.locator('tr', { hasText: 'Ti-demo-375C-aged' }).locator('.count-cell'),
  ).toContainText('2 备样');
});

test('unfinished operation and immediate note flush survive normal close and abrupt exit', async () => {
  await page.getByRole('button', { name: '载入演示实验' }).click();
  await page.getByRole('button', { name: '进入现场记录' }).click();
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  await page.getByLabel('现场备注', { exact: true }).fill('关闭前刚刚输入');
  await application.close();
  ({ application, page } = await launch(directory));
  await expect(page.getByRole('heading', { name: '专注当前样品' })).toBeVisible();
  await expect(page.getByLabel('现场备注', { exact: true })).toHaveValue('关闭前刚刚输入');
  expect((await snapshot(page)).runs[0].endedAt).toBeNull();
  const actualMainPid = await application.evaluate(() => process.pid);
  const exited = new Promise((resolveExit) => application.process().once('exit', resolveExit));
  process.kill(actualMainPid);
  await exited;
  ({ application, page } = await launch(directory));
  await expect(page.getByRole('button', { name: '完成并切换下一项' })).toBeVisible();
  expect((await snapshot(page)).runs[0].originalEndedAt).toBeNull();
});

test('failed save retains input, shows failure and can retry through the desktop boundary', async () => {
  await page.getByRole('button', { name: '载入演示实验' }).click();
  await page.getByRole('button', { name: '进入现场记录' }).click();
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  await application.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => unknown> }
    )._invokeHandlers;
    const original = handlers.get('command');
    if (!original) throw new Error('Original IPC handler unavailable');
    ipcMain.removeHandler('command');
    ipcMain.handle('command', (...args) =>
      args[1]?.type === 'saveRun'
        ? { ok: false, error: '测试模拟：磁盘写入失败' }
        : original(...args),
    );
    (globalThis as any).restoreSaveHandler = () => {
      ipcMain.removeHandler('command');
      ipcMain.handle('command', original);
    };
  });
  await page.getByLabel('现场备注', { exact: true }).fill('未保存的中文记录');
  await expect(page.locator('.save-indicator')).toContainText('保存失败');
  await expect(page.getByLabel('现场备注', { exact: true })).toHaveValue('未保存的中文记录');
  expect((await snapshot(page)).runs[0].notes).toBe('');
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await expect(page.getByRole('heading', { name: '专注当前样品' })).toBeVisible();
  await page.keyboard.press('Control+1');
  await expect(page.getByRole('heading', { name: '专注当前样品' })).toBeVisible();
  await application.evaluate(() => (globalThis as any).restoreSaveHandler());
  await page.locator('.save-indicator').getByRole('button', { name: '重试' }).click();
  await expect(page.locator('.save-indicator')).toContainText('已保存到本机');
  expect((await snapshot(page)).runs[0].notes).toBe('未保存的中文记录');
});

test('workspace shortcuts, quantity guidance and clear search keep the workflow predictable', async ({}, info) => {
  await page.getByRole('button', { name: '载入演示实验' }).click();
  await expect(page.getByRole('button', { name: '现场记录', exact: true })).toBeEnabled();
  await page.keyboard.press('Control+2');
  await expect(page.getByRole('button', { name: '现场记录', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  await page.getByLabel('现场备注', { exact: true }).fill('切换页面前立即保留的观察记录');
  await page.keyboard.press('Control+1');
  await expect(page.getByRole('heading', { name: '实验前，把样品安排好' })).toBeVisible();
  expect((await snapshot(page)).runs[0].notes).toBe('切换页面前立即保留的观察记录');

  await page.keyboard.press('Alt+n');
  const modal = page.getByRole('dialog');
  await page.keyboard.press('Control+3');
  await expect(modal).toBeVisible();
  await modal.getByLabel('样品统称 *', { exact: true }).fill('演示：尺寸核对试样');
  await modal.getByLabel('准备数量', { exact: true }).fill('6');
  await modal.getByLabel('计划测试数量', { exact: true }).fill('7');
  await expect(modal.getByRole('button', { name: '添加并安排测试', exact: true })).toBeDisabled();
  await expect(modal.locator('.quantity-hint')).toContainText('不超过准备数量');
  await page.keyboard.press('Control+Enter');
  expect((await snapshot(page)).groups).toHaveLength(2);
  await modal.getByLabel('计划测试数量', { exact: true }).fill('4');
  await expect(modal.getByRole('button', { name: '添加并安排测试', exact: true })).toBeEnabled();
  await expect(modal.getByLabel('样品数量预览')).toContainText('6准备4计划测试2备样');
  await modal.getByLabel('准备数量', { exact: true }).fill('');
  await expect(modal.getByLabel('样品数量预览')).toContainText('—准备4计划测试—备样');
  await modal.getByLabel('准备数量', { exact: true }).fill('6');
  await modal.getByLabel('计划测试数量', { exact: true }).fill('0');
  await expect(modal.getByRole('button', { name: '添加为备样', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '新增样品', exact: true })).toBeFocused();

  await page.getByLabel('搜索样品组', { exact: true }).fill('不存在的样品');
  await expect(page.getByRole('heading', { name: '没有找到样品' })).toBeVisible();
  await page.getByRole('button', { name: '清除搜索样品组', exact: true }).click();
  await expect(page.getByLabel('搜索样品组', { exact: true })).toBeFocused();
  await expect(page.locator('.plan-table tbody > tr')).toHaveCount(2);
  await page.keyboard.press('Control+2');
  await page.getByLabel('搜索待测样品', { exact: true }).fill('TA-03');
  await expect(page.locator('.queue-row')).toHaveCount(1);
  await page.getByRole('button', { name: '清除搜索待测样品', exact: true }).click();
  await expect(page.locator('.queue-row')).toHaveCount(4);
  await expect(page.getByLabel('搜索待测样品', { exact: true })).toBeFocused();

  const contrast = await page.evaluate(() => {
    const luminance = (color: string) => {
      const rgb = color
        .match(/\d+(?:\.\d+)?/g)!
        .slice(0, 3)
        .map(Number)
        .map((v) => {
          v /= 255;
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    return ['.finish-button', '.status-pill.running', '.save-indicator'].map((selector) => {
      const style = getComputedStyle(document.querySelector(selector)!);
      const a = luminance(style.color),
        b = luminance(style.backgroundColor);
      return { selector, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
    });
  });
  for (const pair of contrast) expect(pair.ratio, pair.selector).toBeGreaterThanOrEqual(4.5);
  await writeFile(info.outputPath('ui-contrast.json'), JSON.stringify(contrast, null, 2));
  await page.keyboard.press('Control+3');
  await expect(page.getByRole('heading', { name: '回看实验，把记录带走' })).toBeVisible();
  await page.getByLabel('搜索操作记录', { exact: true }).fill('TA-01');
  await expect(page.locator('.review-table tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: '清除搜索操作记录', exact: true }).click();
  await expect(page.locator('.review-table tbody tr')).toHaveCount(4);
});

test('operation duration uses recorded timestamps across midnight, corrections and restart', async () => {
  await page.getByRole('button', { name: '载入演示实验' }).click();
  const item = (await snapshot(page)).items[0];
  await command(page, {
    type: 'times',
    itemId: item.id,
    startedAt: '2026-10-05T15:59:00.000Z',
    endedAt: '2026-10-06T16:02:00.000Z',
    reason: '合成跨日时段',
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: '实验前，把样品安排好' })).toBeVisible();
  await page.keyboard.press('Control+2');
  await page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true }).click();
  await expect(page.getByLabel('本次操作用时', { exact: true })).toHaveText('24:03:00');
  await expect(page.getByRole('progressbar', { name: '完成进度' })).toHaveAttribute('value', '1');
  await command(page, {
    type: 'times',
    itemId: item.id,
    startedAt: '2026-10-05T15:59:00.000Z',
    endedAt: '2026-10-05T16:02:00.000Z',
    reason: '合成时间修正',
  });
  await application.close();
  ({ application, page } = await launch(directory));
  await page.keyboard.press('Control+2');
  await page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true }).click();
  await expect(page.getByLabel('本次操作用时', { exact: true })).toHaveText('00:03:00');
  expect((await snapshot(page)).events.filter((event) => event.type === 'correction')).toHaveLength(
    2,
  );
  await page.getByRole('button', { name: '选择样品 TA-02 操作 2', exact: true }).click();
  await expect(page.getByLabel('本次操作用时', { exact: true })).toHaveText('—');
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  await expect(page.getByLabel('本次操作用时', { exact: true })).toHaveText(/00:00:0[1-9]/, {
    timeout: 4000,
  });
  const recorded = (await snapshot(page)).runs.find((run) => run.itemId !== item.id)!;
  await application.close();
  ({ application, page } = await launch(directory));
  await page.keyboard.press('Control+2');
  await expect(page.locator('.current-heading')).toContainText('TA-02');
  await expect(page.getByLabel('本次操作用时', { exact: true })).not.toHaveText('—');
  expect((await snapshot(page)).runs.find((run) => run.id === recorded.id)!.endedAt).toBeNull();
});

test('keyboard operation, small window and display zoom keep current controls usable', async ({}, info) => {
  await page.getByRole('button', { name: '载入演示实验' }).click();
  await expect(page.getByRole('button', { name: '现场记录', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '现场记录', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '专注当前样品' })).toBeVisible();
  for (const [width, height, zoom] of [
    [1366, 768, 1],
    [1100, 800, 1.25],
    [900, 700, 1],
    [900, 700, 1.5],
  ]) {
    await application.evaluate(
      ({ BrowserWindow }, settings) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setSize(settings.width, settings.height);
        win.webContents.setZoomFactor(settings.zoom);
      },
      { width, height, zoom },
    );
    await expect(page.getByRole('button', { name: '开始操作', exact: true })).toBeVisible();
    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(horizontalOverflow).toBe(false);
    for (const selector of ['.experiment-switcher select', '.cloud-open', '.save-indicator']) {
      const bounds = await page.locator(selector).boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
    }
    await page.getByRole('button', { name: '开始操作', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: '开始操作', exact: true })).toBeInViewport({
      ratio: 1,
    });
    await capture(application, info.outputPath(`live-${width}-${zoom}.png`));
  }
  await page.getByRole('button', { name: '时间线', exact: true }).click();
  await expect(page.locator('.timeline-drawer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.timeline-drawer')).toHaveCount(0);
  await page.getByRole('button', { name: '开始操作', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '完成并切换下一项' })).toBeVisible();
  const config = await application.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      sandbox: prefs.sandbox,
      nodeIntegration: prefs.nodeIntegration,
      contextIsolation: prefs.contextIsolation,
    };
  });
  expect(config).toEqual({ sandbox: true, nodeIntegration: false, contextIsolation: true });
  expect(await page.evaluate(() => typeof (window as any).require)).toBe('undefined');
});

test('live UI: double click, spare activation, remeasurement, skip, interruption and time correction', async () => {
  await page.getByRole('button', { name: '载入演示实验' }).click();
  await page.getByRole('button', { name: '进入现场记录' }).click();
  await page.getByRole('button', { name: '开始操作', exact: true }).dblclick();
  await expect(page.getByRole('button', { name: '完成并切换下一项' })).toBeEnabled();
  expect((await snapshot(page)).runs).toHaveLength(1);
  expect((await snapshot(page)).items[0].status).toBe('running');
  await page.getByRole('button', { name: '完成并切换下一项' }).click();
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.getByRole('button', { name: '选择样品 TA-03 操作 3', exact: true }).click();
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  await page.getByRole('button', { name: '中断', exact: true }).click();
  await page.getByRole('button', { name: '启用备样', exact: true }).click();
  await page.getByRole('button', { name: /Ti-A-热处理.*备样 2/ }).click();
  await page.getByLabel('样品编号前缀').fill('TA-');
  await page.getByRole('button', { name: '加入待测队列' }).click();
  await page.getByRole('button', { name: '选择样品 TA-01 操作 1', exact: true }).click();
  await page.getByRole('button', { name: '安排重测', exact: true }).click();
  let data = await snapshot(page);
  expect(data.samples).toHaveLength(5);
  expect(data.items).toHaveLength(6);
  expect(data.items.filter((i) => i.status === 'skipped')).toHaveLength(1);
  expect(data.items.filter((i) => i.status === 'interrupted')).toHaveLength(1);
  expect(data.items.at(-1)!.repeatOf).toBe(data.items[0].id);
  await expect(page.locator('.compact-heading')).toContainText('完成 1/6');
  await page.getByRole('button', { name: '补录时间', exact: true }).click();
  await page.getByLabel('开始时间', { exact: true }).fill('2026-10-05T23:59');
  await page.getByLabel('结束时间', { exact: true }).fill('2026-10-06T00:02');
  await page.getByLabel('修改说明（可选）').fill('演示：按现场日志补录');
  await page.getByRole('button', { name: '保存时间记录' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  data = await snapshot(page);
  const manual = data.runs.at(-1)!;
  expect(Date.parse(manual.endedAt!) - Date.parse(manual.startedAt!)).toBe(180000);
  expect(manual.originalStartedAt).toBeNull();
  await page.getByRole('button', { name: '修正时间', exact: true }).click();
  await page.getByLabel('结束时间', { exact: true }).fill('2026-10-06T00:03');
  await page.getByRole('button', { name: '保存时间记录' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await snapshot(page)).events.filter((e) => e.type === 'correction')).toHaveLength(2);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const status = await page.locator('.save-indicator').boundingBox();
  expect(status!.y).toBeGreaterThanOrEqual(0);
  expect(status!.y).toBeLessThan(80);
});

test('quick entry and dimensions → real PDF/HTML report; compact plan and cloud controls', async ({}, info) => {
  const created = await command(page, {
    type: 'createExperiment',
    code: 'FAST-001',
    name: 'Ti2448 样品记录',
  });
  await page.reload();
  await expect(page.getByRole('button', { name: '实验规划', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await page.keyboard.press('Alt+n');
  const modal = page.getByRole('dialog');
  await modal.getByLabel('样品统称 *', { exact: true }).fill('Ti2448 拉伸试样');
  await modal.getByLabel('样品状态', { exact: true }).fill('400C-aged');
  await modal.getByLabel('准备数量', { exact: true }).fill('6');
  await modal.getByLabel('计划测试数量', { exact: true }).fill('4');
  await modal.getByLabel('厚度', { exact: true }).fill('0.8');
  await modal.getByLabel('宽度', { exact: true }).fill('3.0');
  await page.screenshot({ path: info.outputPath('quick-add.png') });
  await modal.getByRole('button', { name: '保存并继续添加', exact: true }).click();
  await expect(modal.getByLabel('样品统称 *', { exact: true })).toHaveValue('');
  await expect(modal.getByLabel('宽度', { exact: true })).toHaveValue('3.0');
  await modal.getByLabel('样品统称 *', { exact: true }).fill('参考样品 B');
  await modal.getByLabel('准备数量', { exact: true }).fill('1');
  await modal.getByLabel('计划测试数量', { exact: true }).fill('1');
  await modal.getByRole('button', { name: '添加并安排测试', exact: true }).click();
  await expect(modal).toHaveCount(0);
  const data = await snapshot(page);
  expect(data.samples.map((s) => s.code)).toEqual(['S01', 'S02', 'S03', 'S04', 'S05']);
  expect(data.groups[0].height).toBe('');
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(900, 700),
  );
  await expect
    .poll(() =>
      page
        .locator('.plan-table')
        .evaluate((table) => table.scrollWidth <= table.parentElement!.clientWidth + 1),
    )
    .toBe(true);
  await page.screenshot({ path: info.outputPath('planning-small.png') });
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 940),
  );
  await page.getByRole('button', { name: '进入现场记录' }).click();
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  await page.getByLabel('现场备注', { exact: true }).fill('试样对中后稳定，实际宽度 2.95 mm。');
  await expect(page.locator('.save-indicator')).toContainText('已保存到本机');
  const run = (await snapshot(page)).runs[0];
  await command(page, { type: 'saveRun', runId: run.id, actualSample: { width: '2.95' } });
  const image = join(directory, '现场照片.png');
  await writeFile(image, PNG);
  await nativeFiles(application, { open: [image] });
  await page.getByRole('button', { name: '添加图片' }).click();
  await page.getByRole('button', { name: '完成并切换下一项' }).click();
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await nativeFiles(application, { open: [directory] });
  await page.getByRole('button', { name: '导出实验报告', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('报告已保存', { timeout: 20000 });
  const folder = (await readdir(directory)).find((name) => name.startsWith('FAST-001-实验报告-'))!;
  expect(folder).toBeTruthy();
  const report = join(directory, folder);
  const pdf = await readFile(join(report, 'report.pdf'));
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.length).toBeGreaterThan(5000);
  const html = await readFile(join(report, 'report.html'), 'utf8');
  expect(html).toContain('Ti2448 拉伸试样');
  expect(html).toContain('2.95 mm');
  expect(html).toContain('data:image/png;base64,');
  const json = JSON.parse(await readFile(join(report, 'records.json'), 'utf8'));
  expect(json.experiments[0].id).toBe(created.experimentId);
  expect(json.runs[0].actualSample.width).toBe('2.95');
  expect(json.runs[0].endedAt).toBeTruthy();
  await cp(report, info.outputPath('example-report'), { recursive: true });
  for (const item of (await snapshot(page)).items.filter((item: any) => item.status === 'pending'))
    await command(page, { type: 'skip', itemId: item.id });
  await page.reload();
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await expect(page.getByRole('button', { name: '导出本次报告', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '云同步', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'GitHub 私人仓库同步' })).toBeVisible();
  await expect(page.getByLabel('私人仓库', { exact: true })).toBeVisible();
  await expect(page.getByLabel('私人仓库', { exact: true })).toHaveValue('');
  await page.keyboard.press('Escape');
});

test('report archive status and preference controls remain usable with offline failures', async ({}, info) => {
  await page.getByRole('button', { name: '载入演示实验' }).click();
  await application.evaluate(({ ipcMain }) => {
    const status = {
      repository: 'demo/research-records',
      account: 'demo',
      connected: true,
      githubCliAvailable: false,
      lastSyncedAt: null,
      reportArchiveEnabled: true,
    };
    const replace = (channel: string, action: (...args: any[]) => unknown) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, ...args) => ({ ok: true, data: action(...args) }));
    };
    replace('cloud-status', () => status);
    replace('report-archive-preference', (enabled) => {
      status.reportArchiveEnabled = enabled;
      return status;
    });
    replace('report-jobs', () => [
      {
        id: '00000000-0000-4000-8000-000000000001',
        experimentId: '00000000-0000-4000-8000-000000000002',
        experimentName: '合成演示实验',
        code: 'DEMO-1',
        generatedAt: '2026-10-06T08:00:00.000Z',
        repository: status.repository,
        prefix: 'labrecord',
        localPath: '(synthetic report)',
        state: 'failed',
        error: '离线，恢复联网后可重试',
      },
    ]);
    replace('cloud-reports', () => []);
  });
  await page.getByRole('button', { name: '云同步', exact: true }).click();
  const preference = page.getByRole('checkbox', { name: '生成报告后保存到私人库' });
  await expect(preference).toBeChecked();
  await expect(page.locator('.report-job')).toContainText('本机已保存 · 上传失败');
  await preference.uncheck();
  await expect(preference).not.toBeChecked();
  await preference.check();
  await expect(preference).toBeChecked();
  await page.getByRole('button', { name: '刷新云端报告', exact: true }).click();
  await expect(page.getByText('云端暂无报告。生成报告后会出现在这里。')).toBeVisible();
  await page.screenshot({ path: info.outputPath('report-cloud.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  await page.getByLabel('现场备注', { exact: true }).fill('离线上传失败后继续记录');
  await expect(page.locator('.save-indicator')).toContainText('已保存到本机');
  await page.getByRole('button', { name: '完成并切换下一项' }).click();
  expect((await snapshot(page)).runs[0].notes).toBe('离线上传失败后继续记录');
});

test('in-situ protocol is visible on the live page and stays at the text written before start', async () => {
  await page.getByRole('button', { name: '载入演示实验' }).click();
  await page.getByRole('button', { name: '展开 Ti-A-热处理' }).click();
  const planProtocol = page.getByLabel('Ti-A-热处理 实验制度');
  await planProtocol.fill('升温 5 °C/min，至 400 °C 保温 20 min');
  await planProtocol.blur();
  await expect(page.locator('.save-indicator')).toContainText('已保存到本机');
  await page.getByRole('button', { name: '进入现场记录' }).click();
  await expect(page.getByRole('textbox', { name: '实验制度', exact: true })).toHaveValue(
    '升温 5 °C/min，至 400 °C 保温 20 min',
  );
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  await expect(page.locator('.protocol-card')).toContainText('开始时的实验制度');
  await expect(page.locator('.protocol-card')).toContainText(
    '升温 5 °C/min，至 400 °C 保温 20 min',
  );
  const started = (await snapshot(page)).runs[0];
  await page.keyboard.press('Control+1');
  await page.getByRole('button', { name: '展开 Ti-A-热处理' }).click();
  const revised = page.getByLabel('Ti-A-热处理 实验制度');
  await revised.fill('后来改成 450 °C');
  await revised.blur();
  await expect(page.locator('.save-indicator')).toContainText('已保存到本机');
  await page.keyboard.press('Control+2');
  await expect(page.locator('.protocol-card')).toContainText(
    '升温 5 °C/min，至 400 °C 保温 20 min',
  );
  await expect(page.locator('.protocol-card')).not.toContainText('450 °C');
  const after = (await snapshot(page)).runs[0];
  expect(after.snapshot).toEqual(started.snapshot);
  expect(after.originalStartedAt).toBe(started.originalStartedAt);
  expect(after.snapshot.group.protocol).toBe('升温 5 °C/min，至 400 °C 保温 20 min');
});

test('arranging one state can name each specimen and give it a different in-situ protocol', async () => {
  await page.getByRole('button', { name: '载入演示实验' }).click();
  await page
    .locator('tr', { hasText: 'Ti-A-热处理' })
    .first()
    .getByRole('button', { name: '安排测试', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '安排待测样品', exact: true });
  await dialog.getByLabel('本次加入待测队列的数量 *', { exact: true }).fill('2');
  await dialog.getByLabel('样品编号前缀', { exact: true }).fill('TA-');
  await expect(dialog.getByText('TA-05', { exact: true })).toBeVisible();
  await dialog.getByLabel('TA-05 样品名', { exact: true }).fill('时效试样甲');
  await dialog.getByLabel('TA-06 样品名', { exact: true }).fill('时效试样乙');
  await dialog.getByLabel('TA-05 实验制度', { exact: true }).fill('升温 2 °C/min，至 300 °C');
  await dialog.getByLabel('TA-06 实验制度', { exact: true }).fill('升温 10 °C/min，至 450 °C');
  await dialog.getByRole('button', { name: '加入待测队列', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '进入现场记录' }).click();
  await page.getByRole('button', { name: '选择样品 TA-05 操作 5', exact: true }).click();
  await expect(page.locator('.current-heading h2')).toHaveText('时效试样甲');
  await expect(page.locator('.current-heading')).toContainText('TA-05');
  await expect(page.getByRole('textbox', { name: '实验制度', exact: true })).toHaveValue(
    '升温 2 °C/min，至 300 °C',
  );
  await page.getByRole('button', { name: '选择样品 TA-06 操作 6', exact: true }).click();
  await expect(page.locator('.current-heading h2')).toHaveText('时效试样乙');
  await expect(page.getByRole('textbox', { name: '实验制度', exact: true })).toHaveValue(
    '升温 10 °C/min，至 450 °C',
  );
  await page.getByRole('button', { name: '选择样品 TA-05 操作 5', exact: true }).click();
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  const started = (await snapshot(page)).runs[0];
  expect(started.snapshot.sample.parameters.name).toBe('时效试样甲');
  expect(started.snapshot.group.protocol).toBe('升温 2 °C/min，至 300 °C');
  await page.keyboard.press('Control+1');
  await page.getByRole('button', { name: '展开 Ti-A-热处理' }).click();
  const renamed = page.getByLabel('TA-05 样品名', { exact: true });
  await renamed.fill('后来改名');
  await renamed.blur();
  await expect(page.locator('.save-indicator')).toContainText('已保存到本机');
  await page.keyboard.press('Control+2');
  await expect(page.locator('.current-heading h2')).toHaveText('时效试样甲');
  const after = (await snapshot(page)).runs[0];
  expect(after.snapshot).toEqual(started.snapshot);
  expect(after.originalStartedAt).toBe(started.originalStartedAt);
  await command(page, { type: 'updateSamples', ids: [started.sampleId], code: 'LATER-CODE' });
  await page.reload();
  await expect(page.locator('.current-heading')).toContainText('TA-05');
  await expect(page.locator('.current-heading')).not.toContainText('LATER-CODE');
  await expect(
    page.getByRole('button', { name: '选择样品 TA-05 操作 5', exact: true }),
  ).toBeVisible();
});

test('offline beamtime: preview and copy folder names, schedule multiple regimes on one sample and keep independent snapshots', async ({}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.context().setOffline(true);
  await page.getByRole('button', { name: '新建第一个实验', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('实验名称 *').fill('同步辐射多制度验收');
  await dialog.getByLabel('实验编号 *').fill('P212-202610');
  await dialog.getByRole('button', { name: '创建实验', exact: true }).click();
  // Verify explicit advanced/legacy templates independently of the concise default.
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('规则', { exact: true })
    .fill('{experiment}_{material}_{state}_{sample}_{mode}_{regime}_{batch}_{run:03}');
  await page.getByRole('dialog').getByRole('button', { name: '保存实验设置', exact: true }).click();
  await page.getByRole('button', { name: '新增样品', exact: true }).first().click();
  dialog = page.getByRole('dialog', { name: '添加样品', exact: true });
  await dialog.getByLabel('样品统称 *', { exact: true }).fill('拉伸试样');
  await dialog.getByLabel('材料短名（用于命名，可选）', { exact: true }).fill('Ti2448');
  await dialog.getByLabel('样品状态', { exact: true }).fill('400C-aged');
  await dialog.getByLabel('准备数量', { exact: true }).fill('3');
  await dialog.getByLabel('计划测试数量', { exact: true }).fill('1');
  await dialog.getByLabel('实验方式', { exact: true }).selectOption('In situ');
  await dialog.getByLabel('实验制度', { exact: true }).fill('0–2% 循环 10 次；RT');
  await dialog.getByLabel('测量技术', { exact: true }).fill('SXRD');
  await dialog.getByLabel('制度类型 / 命名短码', { exact: true }).fill('cyclic');
  await dialog.getByLabel('测量批次 / 条件短码', { exact: true }).fill('B01');
  const preview = 'P212-202610_Ti2448_400C-aged_S01_IS_cyclic_B01_001';
  await expect(dialog.getByLabel('快速添加名称预览')).toContainText(preview);
  await dialog.getByRole('button', { name: '添加并安排测试', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const planner = page.getByRole('region', { name: '测量计划', exact: true });
  await planner.locator('tbody tr').first().getByRole('checkbox').check();
  await expect(planner).toContainText('已选 1 项');
  await planner.getByLabel('搜索测量计划', { exact: true }).fill('不存在的测量');
  await expect(planner.getByRole('button', { name: '同样品追加制度', exact: true })).toBeDisabled();
  await planner.getByLabel('搜索测量计划', { exact: true }).fill('');
  const rows = planner.locator('tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(preview);
  const clipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await rows.first().getByRole('button', { name: '复制测量名称 1', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await application.evaluate(({ clipboard }) => clipboard.readText())) === preview,
      )
      .toBe(true);
  } finally {
    await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipboard);
  }
  await rows.first().getByRole('button', { name: '追加制度', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '同一样品追加制度', exact: true });
  await expect(dialog.getByLabel('测量技术', { exact: true })).toHaveValue('SXRD');
  await dialog.getByLabel('实验方式', { exact: true }).selectOption('Ex situ');
  await dialog.getByLabel('制度类型 / 命名短码', { exact: true }).fill('rotation');
  await dialog.getByLabel('测量批次 / 条件短码', { exact: true }).fill('B02');
  await dialog
    .getByLabel('本次制度与条件', { exact: true })
    .fill('-90° 至 90°，每 5° 一步，0.2 s 曝光');
  await dialog.getByLabel('每项追加次数', { exact: true }).fill('2');
  await expect(dialog.getByLabel('测量名称预览').locator('code')).toHaveCount(2);
  await dialog.getByRole('button', { name: '追加测量计划', exact: true }).click();
  await expect(rows).toHaveCount(3);
  let data = await snapshot(page);
  expect(data.samples).toHaveLength(1);
  expect(data.groups[0].preparedCount).toBe(3);
  expect(new Set(data.items.map((item) => item.sampleId)).size).toBe(1);
  expect(data.items.filter((item) => item.repeatOf)).toHaveLength(0);
  expect(data.items[0].measurement!.regime).toBe('cyclic');
  expect(data.items[2].measurement!.regime).toBe('rotation');
  const name = data.items[2].plannedName!;
  await rows.nth(1).getByRole('checkbox').check();
  await rows.nth(2).getByRole('checkbox').check();
  await planner.getByRole('button', { name: '批量配置制度', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '配置测量制度与命名', exact: true });
  await dialog.getByLabel('测量批次 / 条件短码', { exact: true }).fill('RT');
  await dialog.getByRole('button', { name: '保存测量配置', exact: true }).click();
  data = await snapshot(page);
  expect(data.items[0].measurement!.batch).toBe('B01');
  expect(data.items[1].measurement!.batch).toBe('RT');
  expect(data.items[2].plannedName).not.toBe(name);
  const reserved = data.items[2].plannedName!;
  await capture(application, info.outputPath('multi-regime-planning.png'));
  await rows.nth(2).getByRole('button', { name: '现场查看', exact: true }).click();
  await expect(page.locator('.filename-card code')).toHaveText(reserved);
  await expect(page.locator('.measurement-current-summary')).toContainText('旋转扫描');
  await expect(page.getByLabel('实验制度', { exact: true })).toHaveValue(
    '-90° 至 90°，每 5° 一步，0.2 s 曝光',
  );
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  const started = (await snapshot(page)).runs[0];
  expect(started.filename).toBe(reserved);
  expect(started.number).toBe(1);
  expect(started.snapshot.measurement!.mode).toBe('Ex situ');
  expect(started.snapshot.measurement!.regime).toBe('rotation');
  await capture(application, info.outputPath('rotation-live.png'));
  await page.getByRole('button', { name: '完成并切换下一项' }).click();
  await page.getByRole('button', { name: '选择样品 S01 操作 3', exact: true }).click();
  await page.getByRole('button', { name: '安排重测', exact: true }).click();
  data = await snapshot(page);
  expect(data.samples).toHaveLength(1);
  expect(data.items).toHaveLength(4);
  expect(data.items[3].repeatOf).toBe(data.items[2].id);
  expect(data.items[3].measurement!.regime).toBe('rotation');
  expect(data.runs[0]).toEqual(
    started.endedAt
      ? started
      : {
          ...started,
          endedAt: data.runs[0].endedAt,
          originalEndedAt: data.runs[0].originalEndedAt,
        },
  );
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  await page.getByLabel('搜索操作记录', { exact: true }).fill('rotation');
  await expect(page.locator('.review-table tbody tr')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('measurement configuration retries a lost reply with the same request and survives narrow Windows layout', async ({}, info) => {
  await page.getByRole('button', { name: '载入演示实验', exact: true }).click();
  const first = (await snapshot(page)).items[0];
  const row = page
    .getByRole('region', { name: '测量计划', exact: true })
    .locator('tbody tr')
    .first();
  await row.getByRole('button', { name: '追加制度', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '同一样品追加制度', exact: true });
  await dialog.getByLabel('制度类型 / 命名短码', { exact: true }).fill('step');
  await dialog.getByLabel('测量批次 / 条件短码', { exact: true }).fill('300K');
  await dialog.getByLabel('本次制度与条件', { exact: true }).fill('每级保载 30 s');
  await application.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => unknown> }
    )._invokeHandlers;
    const original = handlers.get('command')!;
    let lose = true;
    ipcMain.removeHandler('command');
    ipcMain.handle('command', async (...args) => {
      const reply = await original(...args);
      if (args[1]?.type === 'scheduleMeasurements' && lose) {
        lose = false;
        return { ok: false, error: '测试模拟：操作已经保存，响应丢失' };
      }
      return reply;
    });
  });
  await dialog.getByRole('button', { name: '追加测量计划', exact: true }).click();
  await expect(dialog).toContainText('响应丢失');
  await expect(dialog.getByLabel('本次制度与条件', { exact: true })).toBeDisabled();
  expect((await snapshot(page)).items).toHaveLength(5);
  await dialog.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const data = await snapshot(page);
  expect(data.items).toHaveLength(5);
  expect(data.items[4].sampleId).toBe(first.sampleId);
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(900, 700);
    window.webContents.setZoomFactor(1.5);
  });
  await page
    .getByRole('region', { name: '测量计划', exact: true })
    .locator('tbody tr')
    .last()
    .getByRole('button', { name: '配置制度', exact: true })
    .click();
  const config = page.getByRole('dialog', { name: '配置测量制度与命名', exact: true });
  await expect(config.getByLabel('制度类型 / 命名短码', { exact: true })).toHaveValue('step');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await config.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await capture(application, info.outputPath('measurement-small.png'));
  await page.keyboard.press('Escape');
  await expect(config).toHaveCount(0);
});

test('historical naming rules and typed experiment settings are reusable; measurement presets work across experiments', async () => {
  await page.getByRole('button', { name: '载入演示实验', exact: true }).click();
  const initial = await snapshot(page);
  const source = initial.experiments[0];
  const first = initial.items[0];
  const planner = page.getByRole('region', { name: '测量计划', exact: true });
  await planner
    .locator('tbody tr')
    .first()
    .getByRole('button', { name: '配置制度', exact: true })
    .click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('测量技术', { exact: true }).fill('SXRD');
  await dialog.getByLabel('制度类型 / 命名短码', { exact: true }).fill('monotonic');
  await dialog.getByLabel('测量批次 / 条件短码', { exact: true }).fill('RT');
  await dialog.getByLabel('本次制度与条件', { exact: true }).fill('恒应变速率 1e-3 s⁻¹');
  await dialog.getByRole('button', { name: '保存测量配置', exact: true }).click();
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  dialog = page.getByRole('dialog');
  const pattern = '{material}_{regime}_{batch}_{run:03}';
  await dialog.getByLabel('规则', { exact: true }).fill(pattern);
  await dialog.getByRole('button', { name: '保存实验设置', exact: true }).click();
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('复用历史命名规则', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '简洁编号', exact: true }).click();
  await dialog.getByLabel('复用历史命名规则', { exact: true }).selectOption(pattern);
  await expect(dialog.getByLabel('规则', { exact: true })).toHaveValue(pattern);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '新建实验', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('实验名称 *').fill('下一次机时');
  await dialog.getByLabel('实验编号 *').fill('NEXT-BEAMTIME');
  await dialog.getByLabel('复用已有实验设置（可选）', { exact: true }).selectOption(source.id);
  await dialog.getByRole('button', { name: '创建实验', exact: true }).click();
  const next = (await snapshot(page)).experiments.at(-1)!;
  expect(next.namingPattern).toBe(pattern);
  expect(next.fields).toEqual(source.fields);
  await page.getByRole('button', { name: '新增样品', exact: true }).first().click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('样品统称 *', { exact: true }).fill('下一批合金');
  await dialog.getByRole('button', { name: '添加并安排测试', exact: true }).click();
  await planner
    .locator('tbody tr')
    .first()
    .getByRole('button', { name: '配置制度', exact: true })
    .click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('复用历史测量配置', { exact: true }).selectOption(first.id);
  await expect(dialog.getByLabel('制度类型 / 命名短码', { exact: true })).toHaveValue('monotonic');
  await expect(dialog.getByLabel('本次制度与条件', { exact: true })).toHaveValue(
    '恒应变速率 1e-3 s⁻¹',
  );
  await dialog.getByRole('button', { name: '保存测量配置', exact: true }).click();
  const data = await snapshot(page);
  const item = data.items.find((item) => item.experimentId === next.id)!;
  expect(item.measurement!.technique).toBe('SXRD');
  expect(item.plannedName).toContain('_monotonic_RT_');
  expect(data.samples.find((sample) => sample.id === item.sampleId)!.id).not.toBe(first.sampleId);
});

test('quick sample addition retries a committed request once instead of duplicating physical samples', async () => {
  await page.getByRole('button', { name: '载入演示实验', exact: true }).click();
  const before = await snapshot(page);
  await page.getByRole('button', { name: '新增样品', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('样品统称 *', { exact: true }).fill('快速添加响应丢失验收');
  await application.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => unknown> }
    )._invokeHandlers;
    const original = handlers.get('command')!;
    let lose = true;
    ipcMain.removeHandler('command');
    ipcMain.handle('command', async (...args) => {
      const reply = await original(...args);
      if (args[1]?.type === 'addSamples' && lose) {
        lose = false;
        return { ok: false, error: '测试模拟：样品已保存，响应丢失' };
      }
      return reply;
    });
  });
  await dialog.getByRole('button', { name: '添加并安排测试', exact: true }).click();
  await expect(dialog).toContainText('响应丢失');
  await expect(dialog.getByLabel('样品统称 *', { exact: true })).toBeDisabled();
  expect((await snapshot(page)).samples).toHaveLength(before.samples.length + 1);
  await dialog.getByRole('button', { name: '重试添加', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const after = await snapshot(page);
  expect(after.samples).toHaveLength(before.samples.length + 1);
  expect(after.groups).toHaveLength(before.groups.length + 1);
  expect(after.items).toHaveLength(before.items.length + 1);
});

test('experiment creation and specimen arrangement recover committed replies, while rejected duplicate codes remain editable', async () => {
  await application.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => unknown> }
    )._invokeHandlers;
    const original = handlers.get('command')!;
    const lost = new Set<string>();
    ipcMain.removeHandler('command');
    ipcMain.handle('command', async (...args) => {
      const reply = await original(...args);
      const type = args[1]?.type;
      if (reply?.ok && ['createExperiment', 'arrange'].includes(type) && !lost.has(type)) {
        lost.add(type);
        return { ok: false, error: '测试模拟：已经提交，响应丢失' };
      }
      return reply;
    });
  });
  await page.getByRole('button', { name: '新建第一个实验', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('实验名称 *').fill('首次机时');
  await dialog.getByLabel('实验编号 *').fill('BT-ONE');
  await dialog.getByRole('button', { name: '创建实验', exact: true }).click();
  await expect(dialog).toContainText('响应丢失');
  await expect(dialog.getByLabel('实验名称 *')).toBeDisabled();
  expect((await snapshot(page)).experiments).toHaveLength(1);
  await dialog.getByRole('button', { name: '重试创建', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await snapshot(page)).experiments).toHaveLength(1);
  await page.getByRole('button', { name: '新建实验', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('实验名称 *').fill('第二次机时');
  await dialog.getByLabel('实验编号 *').fill('BT-ONE');
  await dialog.getByRole('button', { name: '创建实验', exact: true }).click();
  await expect(dialog).toContainText('实验编号已经存在');
  await expect(dialog.getByLabel('实验名称 *')).toBeEnabled();
  await dialog.getByLabel('实验编号 *').fill('BT-TWO');
  await dialog.getByRole('button', { name: '创建实验', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await snapshot(page)).experiments).toHaveLength(2);
  await page.getByRole('button', { name: '新增样品', exact: true }).first().click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('样品统称 *', { exact: true }).fill('备用组');
  await dialog.getByLabel('准备数量', { exact: true }).fill('2');
  await dialog.getByLabel('计划测试数量', { exact: true }).fill('0');
  await dialog.getByRole('button', { name: '添加为备样', exact: true }).click();
  await page.getByRole('button', { name: '安排测试', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('本次加入待测队列的数量 *', { exact: true }).fill('1');
  await dialog.getByRole('button', { name: '加入待测队列', exact: true }).click();
  await expect(dialog).toContainText('响应丢失');
  await expect(dialog.getByLabel('本次加入待测队列的数量 *', { exact: true })).toBeDisabled();
  expect((await snapshot(page)).samples).toHaveLength(1);
  await dialog.getByRole('button', { name: '重试安排', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await snapshot(page)).samples).toHaveLength(1);
  expect((await snapshot(page)).items).toHaveLength(1);
});

test('cancelling an uncertain measurement refreshes stored records; failed refresh preserves the fixed retry request', async () => {
  await page.getByRole('button', { name: '载入演示实验', exact: true }).click();
  await application.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => unknown> }
    )._invokeHandlers;
    const original = handlers.get('command')!;
    let lose = true;
    ipcMain.removeHandler('command');
    ipcMain.handle('command', async (...args) => {
      const reply = await original(...args);
      if (args[1]?.type === 'scheduleMeasurements' && lose) {
        lose = false;
        return { ok: false, error: '测试模拟：已经提交，响应丢失' };
      }
      return reply;
    });
  });
  const planner = page.getByRole('region', { name: '测量计划', exact: true });
  await planner
    .locator('tbody tr')
    .first()
    .getByRole('button', { name: '追加制度', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('制度类型 / 命名短码', { exact: true }).fill('rotation');
  await dialog.getByRole('button', { name: '追加测量计划', exact: true }).click();
  await expect(dialog).toContainText('响应丢失');
  expect((await snapshot(page)).items).toHaveLength(5);
  await application.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => unknown> }
    )._invokeHandlers;
    const original = handlers.get('snapshot')!;
    ipcMain.removeHandler('snapshot');
    ipcMain.handle('snapshot', () => ({ ok: false, error: '测试模拟：读取记录失败' }));
    (globalThis as any).restoreSnapshotHandler = () => {
      ipcMain.removeHandler('snapshot');
      ipcMain.handle('snapshot', original);
    };
  });
  await page.keyboard.press('Escape');
  await expect(dialog).toContainText('读取记录失败');
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '返回查看记录', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('制度类型 / 命名短码', { exact: true })).toBeDisabled();
  await application.evaluate(() => (globalThis as any).restoreSnapshotHandler());
  await dialog.getByRole('button', { name: '返回查看记录', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(planner.locator('tbody tr')).toHaveCount(5);
  await expect(page.locator('.save-indicator')).toContainText('已保存到本机');
});

test('metal preparation: concise names, composition and processing, explicit none, cross-group numbering and frozen history', async ({}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.context().setOffline(true);
  await page.getByRole('button', { name: '新建第一个实验', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('实验名称 *').fill('金属材料实验 · 合成演示');
  await dialog.getByLabel('实验编号 *').fill('HEPS-202610');
  await dialog.getByRole('button', { name: '创建实验', exact: true }).click();
  await page.getByRole('button', { name: '新增样品', exact: true }).first().click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('样品统称 *', { exact: true }).fill('Ti2448 拉伸试样');
  await dialog.getByLabel('样品状态', { exact: true }).fill('NOHR_aged');
  await dialog.getByLabel('成分', { exact: true }).fill('Ti-24Nb-4Zr-8Sn（wt.%）');
  await dialog.getByLabel('加工工艺', { exact: true }).fill('热轧 → 冷轧 60%');
  await dialog
    .getByLabel('热处理制度', { exact: true })
    .fill('800 °C × 30 min，水淬 → 400 °C × 2 h 时效');
  await dialog.getByRole('button', { name: '其他工艺设为无', exact: true }).click();
  await expect(dialog.getByLabel('其他工艺', { exact: true })).toHaveValue('无');
  await dialog.getByLabel('准备数量', { exact: true }).fill('4');
  await dialog.getByLabel('计划测试数量', { exact: true }).fill('2');
  await expect(dialog.getByLabel('快速添加名称预览')).toContainText('HEPS-202610_S01');
  await expect(dialog.getByLabel('快速添加名称预览')).not.toContainText('_001');
  await capture(application, info.outputPath('material-add.png'));
  await dialog.getByRole('button', { name: '添加并安排测试', exact: true }).click();
  await page.getByRole('button', { name: '新增样品', exact: true }).first().click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('样品统称 *', { exact: true }).fill('Ti15Nb 对照试样');
  await dialog.getByLabel('成分', { exact: true }).fill('Ti-15Nb（at.%）');
  await dialog.getByLabel('加工工艺', { exact: true }).fill('铸态');
  await dialog.getByRole('button', { name: '热处理制度设为无', exact: true }).click();
  await dialog.getByRole('button', { name: '其他工艺设为无', exact: true }).click();
  await dialog.getByLabel('准备数量', { exact: true }).fill('2');
  await dialog.getByLabel('计划测试数量', { exact: true }).fill('0');
  await dialog.getByRole('button', { name: '添加为备样', exact: true }).click();
  const secondRow = page.getByRole('row', { name: /Ti15Nb 对照试样/ });
  await secondRow.getByRole('button', { name: '安排测试', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('本次加入待测队列的数量 *', { exact: true }).fill('1');
  await expect(dialog.getByLabel('样品编号前缀', { exact: true })).toHaveValue('S');
  await expect(dialog.getByText('S03', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: /加入待测队列/ }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  let data = await snapshot(page);
  expect(data.samples.map((sample) => sample.code)).toEqual(['S01', 'S02', 'S03']);
  expect(data.items.map((item) => item.plannedName)).toEqual([
    'HEPS-202610_S01',
    'HEPS-202610_S02',
    'HEPS-202610_S03',
  ]);
  expect(data.groups[0].state).toBe('NOHR_aged');
  expect(data.groups[1].heatTreatment).toBe('无');
  await expect(page.locator('.material-preparation-summary').first()).toContainText('冷轧 60%');
  await page.getByLabel('搜索样品组', { exact: true }).fill('at.%');
  await expect(page.locator('.plan-table tbody > tr')).toHaveCount(1);
  await page.getByLabel('搜索样品组', { exact: true }).fill('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await capture(application, info.outputPath('material-planning.png'));
  await page.getByRole('button', { name: '进入现场记录', exact: true }).click();
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  await page.getByRole('button', { name: '完成并切换下一项', exact: true }).click();
  const historical = structuredClone((await snapshot(page)).runs[0]);
  await command(page, {
    type: 'updateGroups',
    ids: [data.groups[0].id],
    patch: { heatTreatment: '无', otherTreatment: '激光冲击' },
  });
  await page.reload();
  data = await snapshot(page);
  expect(data.runs[0]).toEqual(historical);
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  const historicalRow = page.locator('.review-table tbody tr').filter({ hasText: 'S01' });
  await expect(historicalRow).toContainText('400 °C × 2 h 时效');
  await expect(historicalRow).not.toContainText('激光冲击');
  expect(errors).toEqual([]);
});

test('existing experiment switches to concise naming through settings while its recorded filename stays unchanged', async () => {
  const created = await command(page, {
    type: 'createExperiment',
    code: 'OLD-NAMES',
    name: '旧规则',
    namingPattern: '{experiment}_{sample}_{run:03}',
  });
  const added = await command(page, {
    type: 'addSamples',
    experimentId: created.experimentId!,
    count: 2,
    patch: { name: '合金', state: '原态', preparedCount: 2 },
  });
  await command(page, { type: 'start', itemId: added.itemId! });
  await command(page, { type: 'finish', itemId: added.itemId! });
  const original = structuredClone((await snapshot(page)).runs[0]);
  await page.reload();
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '简洁编号', exact: true }).click();
  await expect(dialog.getByLabel('规则', { exact: true })).toHaveValue('{experiment}_{sample}');
  await dialog.getByRole('button', { name: '保存实验设置', exact: true }).click();
  const data = await snapshot(page);
  expect(data.runs[0]).toEqual(original);
  expect(data.items.map((item) => item.plannedName)).toEqual([
    'OLD-NAMES_S01_001',
    'OLD-NAMES_S02',
  ]);
});

test('material fields remain editable at 900 by 700 and 150 percent zoom; bulk none only applies the chosen field', async ({}, info) => {
  await page.getByRole('button', { name: '载入演示实验', exact: true }).click();
  const groups = (await snapshot(page)).groups;
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setMinimumSize(640, 480);
    win.setSize(900, 700);
    win.webContents.setZoomFactor(1.5);
  });
  await page.getByRole('button', { name: '新增样品', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('样品统称 *', { exact: true }).fill('窄窗口合金');
  await dialog.getByRole('combobox', { name: '成分', exact: true }).fill('Ti-15Nb（at.%）');
  await dialog.getByRole('button', { name: '热处理制度设为无', exact: true }).click();
  await dialog.getByRole('combobox', { name: '其他工艺', exact: true }).fill('激光冲击');
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await capture(application, info.outputPath('material-small.png'));
  await dialog.getByRole('button', { name: '添加并安排测试', exact: true }).click();
  await page.locator('.plan-table thead').getByRole('checkbox').check();
  await page.getByRole('button', { name: '批量设置参数', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '其他工艺设为无', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: '应用其他工艺', exact: true })).toBeChecked();
  await expect(
    dialog.getByRole('checkbox', { name: '应用热处理制度', exact: true }),
  ).not.toBeChecked();
  await dialog.getByRole('button', { name: '应用修改', exact: true }).click();
  const data = await snapshot(page);
  expect(data.groups.every((group) => group.otherTreatment === '无')).toBe(true);
  for (const group of groups)
    expect(data.groups.find((g) => g.id === group.id)!.heatTreatment).toBeUndefined();
  expect(data.groups.at(-1)!.heatTreatment).toBe('无');
});

test('rejected sample input remains editable and continuous entry restores the name focus', async () => {
  await page.getByRole('button', { name: '载入演示实验', exact: true }).click();
  const source = (await snapshot(page)).experiments[0];
  await command(page, {
    type: 'updateExperiment',
    id: source.id,
    namingPattern: '{experiment}_{material}_{sample}',
  });
  await page.reload();
  const before = await snapshot(page);
  await page.getByRole('button', { name: '新增样品', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const name = dialog.getByLabel('样品统称 *', { exact: true });
  await name.fill('M'.repeat(210));
  await dialog.getByRole('button', { name: '添加并安排测试', exact: true }).click();
  await expect(dialog).toContainText('超过 200');
  await expect(name).toBeEnabled();
  await expect(name).toHaveValue('M'.repeat(210));
  expect((await snapshot(page)).groups).toHaveLength(before.groups.length);
  await name.fill('修正后的样品');
  await dialog.getByRole('button', { name: '保存并继续添加', exact: true }).click();
  await expect(name).toHaveValue('');
  await expect(name).toBeFocused();
  expect((await snapshot(page)).groups).toHaveLength(before.groups.length + 1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('copying a folder name flushes edited naming fields and refuses to copy a stale name after save failure', async () => {
  await page.getByRole('button', { name: '载入演示实验', exact: true }).click();
  const source = (await snapshot(page)).experiments[0];
  await command(page, {
    type: 'updateExperiment',
    id: source.id,
    namingPattern: '{experiment}_{material}_{sample}',
  });
  await page.reload();
  const clipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await application.evaluate(({ clipboard }) => clipboard.writeText('copy-test-marker'));
    const planner = page.getByRole('region', { name: '测量计划', exact: true });
    const before = (await snapshot(page)).items[0].plannedName;
    await page.getByLabel('Ti-A 拉伸试样 样品统称', { exact: true }).fill('刚录入的统称');
    await planner.getByRole('button', { name: '复制测量名称 1', exact: true }).click();
    await expect
      .poll(async () => {
        const data = await snapshot(page);
        return (
          (await application.evaluate(({ clipboard }) => clipboard.readText())) ===
            data.items[0].plannedName && data.items[0].plannedName !== before
        );
      })
      .toBe(true);
    const copied = (await snapshot(page)).items[0].plannedName!;
    await application.evaluate(({ ipcMain }) => {
      const handlers = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => unknown> }
      )._invokeHandlers;
      const original = handlers.get('command')!;
      ipcMain.removeHandler('command');
      ipcMain.handle('command', (...args) =>
        args[1]?.type === 'updateGroups'
          ? { ok: false, error: '复制前保存失败', rejected: true }
          : original(...args),
      );
      (globalThis as any).restoreCopySaveHandler = () => {
        ipcMain.removeHandler('command');
        ipcMain.handle('command', original);
      };
    });
    await page.getByLabel('刚录入的统称 样品统称', { exact: true }).fill('失败后仍保留的统称');
    await planner.getByRole('button', { name: '复制测量名称 1', exact: true }).click();
    await expect(page.locator('.save-indicator')).toContainText('保存失败');
    expect((await application.evaluate(({ clipboard }) => clipboard.readText())) === copied).toBe(
      true,
    );
    await application.evaluate(() => (globalThis as any).restoreCopySaveHandler());
    await planner.getByRole('button', { name: '复制测量名称 1', exact: true }).click();
    await expect
      .poll(async () => {
        const data = await snapshot(page);
        return (
          (await application.evaluate(({ clipboard }) => clipboard.readText())) ===
            data.items[0].plannedName && data.items[0].plannedName !== copied
        );
      })
      .toBe(true);
  } finally {
    await application.evaluate(({ clipboard }, value) => clipboard.writeText(value), clipboard);
  }
});

test('right-click menus delete unstarted plans and keep recorded runs', async () => {
  const created = await command(page, {
    type: 'createExperiment',
    name: '删除试验',
    code: 'DEL-MENU',
  });
  const experimentId = created.experimentId!;
  await command(page, {
    type: 'addSamples',
    experimentId,
    count: 0,
    patch: { name: '空组', state: '未测', preparedCount: 2 },
  });
  await command(page, {
    type: 'addSamples',
    experimentId,
    count: 1,
    patch: { name: '待删', state: '待安排', preparedCount: 2 },
  });
  const recorded = await command(page, {
    type: 'addSamples',
    experimentId,
    count: 1,
    patch: { name: '已测', state: '已完成组', preparedCount: 1 },
  });
  await command(page, { type: 'start', itemId: recorded.itemId! });
  await command(page, { type: 'finish', itemId: recorded.itemId! });
  await command(page, { type: 'createExperiment', name: '空实验', code: 'EMPTY-MENU' });
  await page.reload();
  await expect(page.locator('.loading-screen')).toHaveCount(0);
  const before = await snapshot(page);
  const run = before.runs[0];

  await page.getByLabel('空组 样品统称', { exact: true }).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '操作菜单' });
  await expect(menu.getByRole('menuitem', { name: '复制文字', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '编辑', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '复制样品组', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '安排测试', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '删除样品组', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  const recordedRow = page.locator('tr', {
    has: page.getByLabel('已测 样品统称', { exact: true }),
  });
  await recordedRow.locator('.sample-state-caption').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '删除样品组（已有记录）' })).toBeDisabled();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await page.getByRole('button', { name: /选择样品 S02/ }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '上移', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '下移', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '删除未开始的测量（已有记录）' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /选择样品 S01/ }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '删除未开始的测量', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '实验规划', exact: true }).click();

  await page.getByLabel('空组 样品统称', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除样品组', exact: true }).click();
  await page.getByRole('button', { name: '删除样品组', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('空组 样品统称', { exact: true })).toHaveCount(0);

  await page
    .locator('tr', { has: page.getByLabel('选择测量 1 S01', { exact: true }) })
    .getByText('待测', { exact: true })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除这项测量', exact: true }).click();
  await page.getByRole('button', { name: '删除测量', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByLabel('选择实验', { exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '删除当前实验（已有记录）' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByLabel('选择实验', { exact: true }).selectOption({ label: '空实验 · EMPTY-MENU' });
  await page.getByLabel('选择实验', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除当前实验', exact: true }).click();
  await page.getByRole('button', { name: '删除实验', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const after = await snapshot(page);
  expect(after.experiments.map((entry) => entry.code)).toEqual(['DEL-MENU']);
  expect(after.groups.map((group) => group.name).sort()).toEqual(['已测', '待删']);
  expect(after.samples.map((sample) => sample.code)).toEqual(['S02']);
  expect(after.groups.find((group) => group.name === '待删')?.preparedCount).toBe(2);
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0].filename).toBe(run.filename);
  expect(after.runs[0].originalStartedAt).toBe(run.originalStartedAt);
  expect(after.runs[0].snapshot).toEqual(run.snapshot);
});
