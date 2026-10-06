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
  await modal.getByLabel('样品名称 *', { exact: true }).fill('演示：尺寸核对试样');
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
  await modal.getByLabel('样品名称 *', { exact: true }).fill('Ti2448 拉伸试样');
  await modal.getByLabel('样品状态', { exact: true }).fill('400C-aged');
  await modal.getByLabel('准备数量', { exact: true }).fill('6');
  await modal.getByLabel('计划测试数量', { exact: true }).fill('4');
  await modal.getByLabel('厚度', { exact: true }).fill('0.8');
  await modal.getByLabel('宽度', { exact: true }).fill('3.0');
  await page.screenshot({ path: info.outputPath('quick-add.png') });
  await modal.getByRole('button', { name: '保存并继续添加', exact: true }).click();
  await expect(modal.getByLabel('样品名称 *', { exact: true })).toHaveValue('');
  await expect(modal.getByLabel('宽度', { exact: true })).toHaveValue('3.0');
  await modal.getByLabel('样品名称 *', { exact: true }).fill('参考样品 B');
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
