import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
  type Locator,
  type TestInfo,
} from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep, resolve } from 'node:path';
import type { Snapshot, Command } from '../src/shared/model.js';

const require = createRequire(import.meta.url);
let directory: string, application: ElectronApplication, page: Page;
let runtimeLog: string[], pageErrors: string[];

async function launch(directory: string) {
  const env = { ...process.env, LABRECORD_TEST_MODE: '1', LABRECORD_TEST_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: process.env.LABRECORD_EXECUTABLE || require('electron'),
    args: process.env.LABRECORD_EXECUTABLE ? [] : [process.cwd()],
    env,
  });
  app.process().stdout?.on('data', (chunk) => runtimeLog.push(`[stdout] ${chunk.toString()}`));
  app.process().stderr?.on('data', (chunk) => runtimeLog.push(`[stderr] ${chunk.toString()}`));
  const window = await app.firstWindow();
  window.on('console', (message) =>
    runtimeLog.push(`[console ${message.type()}] ${message.text()}`),
  );
  window.on('pageerror', (error) => {
    pageErrors.push(error.message);
    runtimeLog.push(`[pageerror] ${error.stack || error.message}`);
  });
  await expect(window.locator('.loading-screen')).toHaveCount(0);
  await expect(window.locator('.app-header')).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  return { application: app, page: window };
}

async function snapshot(): Promise<Snapshot> {
  return page.evaluate(async () => {
    const result = await window.labrecord.snapshot();
    if (!result.ok) throw new Error(result.error);
    return result.data;
  });
}

async function command(input: Command) {
  return page.evaluate(async (command) => {
    const reply = await window.labrecord.command(command, crypto.randomUUID());
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  }, input);
}

async function createExperiment(name: string, code: string, first = false) {
  await (
    first
      ? page.getByRole('button', { name: '新建第一个实验', exact: true })
      : page.locator('.app-header').getByRole('button', { name: '新建实验', exact: true })
  ).click();
  const modal = page.getByRole('dialog', { name: '新建实验', exact: true });
  await modal.getByLabel('实验名称 *', { exact: true }).fill(name);
  await modal.getByRole('textbox', { name: /^实验编号 \*/ }).fill(code);
  await modal.getByRole('button', { name: '创建实验', exact: true }).click();
  await expect(modal).toHaveCount(0);
  const experiment = (await snapshot()).experiments.find((e) => e.code === code)!;
  await expect(page.getByLabel('选择实验', { exact: true })).toHaveValue(experiment.id);
  return experiment;
}

async function addSamples(name: string, state: string, prepared: string, count: string) {
  await page
    .locator('.planning-card .toolbar-actions')
    .getByRole('button', { name: '新增样品', exact: true })
    .click();
  const modal = page.getByRole('dialog', { name: '添加样品', exact: true });
  await modal.getByLabel('样品统称 *', { exact: true }).fill(name);
  await modal.getByLabel('样品状态', { exact: true }).fill(state);
  await modal.getByLabel('准备数量', { exact: true }).fill(prepared);
  await modal.getByLabel('计划测试数量', { exact: true }).fill(count);
  await modal
    .getByRole('button', { name: count === '0' ? '添加为备样' : '添加并安排测试', exact: true })
    .click();
  await expect(modal).toHaveCount(0);
}

async function openOverview() {
  await page.locator('.app-header').getByRole('button', { name: '实验概览', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '实验概览', exact: true });
  await expect(modal).toBeVisible();
  return modal;
}

async function closeOverview(modal: Locator) {
  await modal.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await expect(modal).toHaveCount(0);
}

function planStat(label: string) {
  return page.locator('.plan-stats .stat').filter({ has: page.getByText(label, { exact: true }) });
}

async function expectCounts(
  modal: Locator,
  prepared: string,
  samples: number,
  operations: number,
  spare: string,
) {
  for (const [label, value] of [
    ['准备数量', prepared],
    ['计划样品', `${samples}个`],
    ['计划操作', `${operations}项`],
    ['备样', spare],
  ]) {
    await expect(
      modal.getByRole('article', { name: label, exact: true }).locator('.stat-value'),
    ).toHaveText(value);
  }
}

async function expectStatuses(modal: Locator, counts: number[]) {
  for (const [index, label] of ['待测', '进行中', '已完成', '已跳过', '已中断'].entries()) {
    await expect(
      modal.locator(`.operation-stat[aria-label="${label}"]`).locator('strong'),
    ).toHaveText(String(counts[index]));
  }
}

async function capture(info: TestInfo, name: string) {
  const png = await application.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'),
  );
  await writeFile(info.outputPath(name), Buffer.from(png, 'base64'));
}

async function noHorizontalOverflow(modal?: Locator) {
  const sizes = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    header: document.querySelector('.app-header')!.scrollWidth,
    headerClient: document.querySelector('.app-header')!.clientWidth,
  }));
  expect(sizes.document).toBeLessThanOrEqual(sizes.viewport + 1);
  expect(sizes.body).toBeLessThanOrEqual(sizes.viewport + 1);
  expect(sizes.header).toBeLessThanOrEqual(sizes.headerClient + 1);
  if (modal) {
    const bounds = await modal.evaluate((element) => ({
      width: element.clientWidth,
      scroll: element.scrollWidth,
    }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
  }
  return sizes;
}

async function colors(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    let parent: Element | null = element;
    let background = 'rgb(255, 255, 255)';
    while (parent) {
      const color = getComputedStyle(parent).backgroundColor;
      if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') {
        background = color;
        break;
      }
      parent = parent.parentElement;
    }
    return {
      color: style.color,
      background,
      outline: style.outlineColor,
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle,
    };
  });
}

function contrast(foreground: string, background: string) {
  const luminance = (color: string) => {
    const components = color
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map((component) => {
        const value = Number(component) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
    return components[0] * 0.2126 + components[1] * 0.7152 + components[2] * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test.beforeEach(async () => {
  runtimeLog = [];
  pageErrors = [];
  directory = await mkdtemp(join(tmpdir(), 'labrecord-overview-'));
  ({ application, page } = await launch(directory));
});

test.afterEach(async ({}, info) => {
  try {
    if (application?.process()?.exitCode === null) {
      await application.evaluate(({ ipcMain }) => {
        const testState = globalThis as any;
        testState.overviewReleaseSave?.();
        if (testState.overviewOriginalCommand) {
          ipcMain.removeHandler('command');
          ipcMain.handle('command', testState.overviewOriginalCommand);
        }
      });
      await application.close();
    }
  } finally {
    const logPath = info.outputPath('electron.log');
    await writeFile(logPath, runtimeLog.join('\n'));
    await info.attach('electron-log', { path: logPath, contentType: 'text/plain' });
    await writeFile(info.outputPath('pageerrors.json'), JSON.stringify(pageErrors, null, 2));
    if (
      !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
      !directory.split(sep).pop()?.startsWith('labrecord-overview-')
    )
      throw new Error('Unexpected test directory');
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  expect(pageErrors).toEqual([]);
});

test('overview: prepared 6 / physical samples 4 / operations 4 / spares 2; real repeat keeps IDs, status counts and immutable run snapshots', async ({}, info) => {
  const experiment = await createExperiment('准备充足实验', 'EXP-001', true);
  await addSamples('试样 A', '标准状态 A', '6', '4');
  await expect(planStat('样品组').locator('strong')).toHaveText('1组');
  await expect(planStat('已知准备数量 · 包含备样').locator('strong')).toHaveText('6个');
  await expect(planStat('已加入计划的不同样品').locator('strong')).toHaveText('4个');
  await expect(planStat('计划操作').locator('strong')).toHaveText('4项');
  await expect(planStat('备样 · 现场按需启用').locator('strong')).toHaveText('2个');
  let modal = await openOverview();
  await expectCounts(modal, '6个', 4, 4, '2个');
  await expectStatuses(modal, [4, 0, 0, 0, 0]);
  await expect(modal.getByLabel('完成进度', { exact: true })).toHaveText('0 / 4 项已完成 · 0%');
  await capture(info, 'overview-initial.png');
  await closeOverview(modal);

  await page.getByRole('button', { name: '进入现场记录', exact: true }).click();
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  await page.getByRole('button', { name: '记录问题', exact: true }).click();
  const issueForm = page.getByRole('dialog', { name: '记录现场问题', exact: true });
  const issueText = issueForm.getByRole('textbox', { name: '发生了什么？', exact: true });
  await issueText.fill('样品定位偏离，需要重新调整。');
  await issueText.press('Control+Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '完成并切换下一项', exact: true }).click();
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  await page.getByRole('button', { name: '完成并切换下一项', exact: true }).click();
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const original = await snapshot();
  const ordered = original.items.slice().sort((a, b) => a.order - b.order);
  const fourth = ordered[3];
  const fourthSample = original.samples.find((s) => s.id === fourth.sampleId)!;
  await page
    .getByRole('button', {
      name: `选择样品 ${fourthSample.code} 操作 ${fourth.order + 1}`,
      exact: true,
    })
    .click();
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  await page.getByRole('button', { name: '中断', exact: true }).click();
  const recorded = await snapshot();
  const sampleIds = recorded.samples.map((s) => s.id).sort();
  const repeated = await command({ type: 'repeat', itemId: ordered[0].id });
  expect(repeated.snapshot.items).toHaveLength(5);
  expect(repeated.snapshot.samples.map((s) => s.id).sort()).toEqual(sampleIds);
  expect(new Set(repeated.snapshot.items.map((i) => i.sampleId)).size).toBe(4);
  expect(repeated.snapshot.items.find((i) => i.id === repeated.itemId)).toMatchObject({
    repeatOf: ordered[0].id,
    sampleId: ordered[0].sampleId,
    status: 'pending',
  });

  // A real plan edit must preserve every already recorded snapshot and original timestamp.
  await command({
    type: 'updateGroups',
    ids: [recorded.groups[0].id],
    patch: { name: '后续计划名称', state: '后续状态', thickness: '9', thicknessUnit: 'μm' },
  });
  let data = await snapshot();
  expect(data.runs).toEqual(recorded.runs);
  await page.reload(); // Direct IPC writes do not replace the React workspace snapshot.
  modal = await openOverview();
  await expectCounts(modal, '6个', 4, 5, '2个');
  await expectStatuses(modal, [1, 0, 2, 1, 1]);
  await expect(modal.getByLabel('完成进度', { exact: true })).toHaveText('2 / 5 项已完成 · 40%');
  await expect(modal.getByRole('progressbar', { name: '已完成操作占比' })).toHaveAttribute(
    'value',
    '2',
  );
  await expect(modal.getByRole('progressbar', { name: '已完成操作占比' })).toHaveAttribute(
    'max',
    '5',
  );
  const issue = modal.getByRole('article', {
    name: '问题：样品定位偏离，需要重新调整。',
    exact: true,
  });
  const physicalSample = recorded.samples.find((s) => s.id === ordered[0].sampleId)!;
  await expect(issue.locator('.issue-sample')).toHaveText(
    `样品：${physicalSample.code} · 标准状态 A`,
  );
  await issue.getByText('查看详情', { exact: true }).click();
  await expect(issue.locator('dd').nth(1)).toHaveText(physicalSample.id);
  await expect(issue.locator('dd').nth(2)).toHaveText('试样 A');
  await issue.getByRole('button', { name: '查看现场', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByLabel('选择实验', { exact: true })).toHaveValue(experiment.id);
  await expect(page.locator('.current-heading h2')).toHaveText(physicalSample.code);
  await expect(page.locator('.queue-choice[aria-pressed="true"]')).toHaveAttribute(
    'aria-label',
    `选择样品 ${physicalSample.code} 操作 1`,
  );
  expect((await snapshot()).runs).toEqual(recorded.runs);
  modal = await openOverview();
  await modal
    .getByRole('article', { name: '问题：样品定位偏离，需要重新调整。', exact: true })
    .getByRole('button', { name: '标记已处理', exact: true })
    .click();
  await expect(modal.getByRole('heading', { name: '未处理问题 (0)', exact: true })).toBeVisible();
  await expect(modal).toContainText('暂无未处理问题');
  data = await snapshot();
  expect(data.events.filter((e) => e.type === 'issue' && !e.data.resolvedAt)).toHaveLength(0);
  expect(data.events.find((e) => e.type === 'issue')!.data.resolvedAt).toEqual(expect.any(String));
  expect(data.runs).toEqual(recorded.runs);
  await closeOverview(modal);

  // Enable a spare through the existing UI; it adds one physical sample and one operation.
  await page.getByRole('button', { name: '启用备样', exact: true }).click();
  await page.getByRole('button', { name: /后续计划名称.*备样 2/ }).click();
  await page
    .getByRole('dialog', { name: '启用备样', exact: true })
    .getByLabel('启用数量 *', { exact: true })
    .fill('1');
  await page.getByRole('button', { name: '加入待测队列', exact: true }).click();
  data = await snapshot();
  expect(data.samples).toHaveLength(5);
  expect(data.items).toHaveLength(6);
  expect(sampleIds.every((id) => data.samples.some((s) => s.id === id))).toBe(true);
  expect(data.runs).toEqual(recorded.runs);
  modal = await openOverview();
  await expectCounts(modal, '6个', 5, 6, '1个');
  await expectStatuses(modal, [2, 0, 2, 1, 1]);
  await closeOverview(modal);
});

test('real 900x700 Electron window at 150% zoom: search/save/overview stay accessible with measured colors and no page/header/modal overflow', async ({}, info) => {
  await page.getByRole('button', { name: '载入演示实验', exact: true }).click();
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(900, 700);
    window.webContents.setZoomFactor(1.5);
  });
  await expect
    .poll(() =>
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
      ),
    )
    .toBe(1.5);
  const nativeWindow = await application.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return {
      requestedSize: [900, 700],
      size: window.getSize(),
      contentSize: window.getContentSize(),
      zoom: window.webContents.getZoomFactor(),
      displayScale: screen.getPrimaryDisplay().scaleFactor,
    };
  });
  // Windows frame/DPI rounding currently adds 2 DIP to the requested outer size.
  for (const [index, requested] of [900, 700].entries()) {
    expect(nativeWindow.size[index]).toBeGreaterThanOrEqual(requested);
    expect(nativeWindow.size[index]).toBeLessThanOrEqual(requested + 2);
  }
  await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(600);
  const dimensions = await noHorizontalOverflow();
  await writeFile(
    info.outputPath('narrow-window.json'),
    JSON.stringify({ nativeWindow, ...dimensions }, null, 2),
  );
  for (const control of [
    page.getByLabel('选择实验', { exact: true }),
    page.locator('.save-indicator'),
    page.locator('.overview-open'),
    page.locator('.cloud-open'),
  ]) {
    await expect(control).toBeInViewport({ ratio: 1 });
  }
  await expect(page.locator('.save-indicator')).toHaveText('已保存到本机');
  const search = page.getByLabel('搜索样品组', { exact: true });
  await search.fill('Ti-A');
  await search.evaluate((input) => input.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await writeFile(
    info.outputPath('search-bounds.json'),
    JSON.stringify(
      await search.evaluate((input) => {
        const properties = (element: Element) => ({
          tag: element.tagName,
          className: element.className,
          bounds: element.getBoundingClientRect().toJSON(),
          overflow: getComputedStyle(element).overflow,
          height: getComputedStyle(element).height,
        });
        const ancestors = [];
        let element: Element | null = input;
        while (element) {
          ancestors.push(properties(element));
          element = element.parentElement;
        }
        return { viewport: { width: innerWidth, height: innerHeight }, ancestors };
      }),
      null,
      2,
    ),
  );
  await capture(info, 'planning-search-narrow.png');
  await expect(search).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.save-indicator')).toBeInViewport({ ratio: 1 });
  await page.getByRole('button', { name: '清除搜索样品组', exact: true }).click();
  await expect(search).toHaveValue('');
  const backgroundBefore = await page.evaluate(() => ({
    rootOverflow: getComputedStyle(document.documentElement).overflowY,
    bodyOverflow: getComputedStyle(document.body).overflowY,
    scrollTop: document.scrollingElement!.scrollTop,
  }));
  let modal = await openOverview();
  await noHorizontalOverflow(modal);
  await expect(page.locator('html')).toHaveClass(/has-experiment-overview/);
  const lockedScroll = await modal.evaluate((dialog) => ({
    rootOverflow: getComputedStyle(document.documentElement).overflowY,
    bodyOverflow: getComputedStyle(document.body).overflowY,
    pageScrollTop: document.scrollingElement!.scrollTop,
    dialogClientHeight: dialog.clientHeight,
    dialogScrollHeight: dialog.scrollHeight,
    scrollableRegions: [dialog, ...dialog.querySelectorAll('*')]
      .filter(
        (element) =>
          ['auto', 'scroll'].includes(getComputedStyle(element).overflowY) &&
          element.scrollHeight > element.clientHeight + 1,
      )
      .map((element) => ({
        className: element.className,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      })),
  }));
  expect(lockedScroll.rootOverflow).toBe('hidden');
  expect(lockedScroll.bodyOverflow).toBe('hidden');
  expect(lockedScroll.pageScrollTop).toBe(backgroundBefore.scrollTop);
  expect(lockedScroll.dialogScrollHeight).toBeLessThanOrEqual(lockedScroll.dialogClientHeight + 1);
  expect(lockedScroll.scrollableRegions.map((region) => region.className)).toEqual(['modal-body']);
  await page.mouse.move(4, await page.evaluate(() => innerHeight / 2));
  await page.mouse.wheel(0, 500); // A real wheel over the backdrop cannot scroll the page.
  await page.waitForTimeout(150); // Let Chromium deliver the wheel event.
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(
    backgroundBefore.scrollTop,
  );
  const modalBody = modal.locator('.modal-body');
  const bodyBounds = await modalBody.boundingBox();
  expect(bodyBounds).not.toBeNull();
  await page.mouse.move(
    bodyBounds!.x + bodyBounds!.width / 2,
    bodyBounds!.y + bodyBounds!.height / 2,
  );
  await page.mouse.wheel(0, 500);
  await expect.poll(() => modalBody.evaluate((body) => body.scrollTop)).toBeGreaterThan(0);
  const scrolled = {
    modalScrollTop: await modalBody.evaluate((body) => body.scrollTop),
    pageScrollTop: await page.evaluate(() => document.scrollingElement!.scrollTop),
  };
  expect(scrolled.pageScrollTop).toBe(backgroundBefore.scrollTop);
  await noHorizontalOverflow(modal);
  await capture(info, 'overview-scrolled-narrow.png');
  await modalBody.evaluate((body) => (body.scrollTop = 0));
  await expect.poll(() => modalBody.evaluate((body) => body.scrollTop)).toBe(0);
  const measured = {
    statLabel: await colors(modal.locator('.stat-label').first()),
    statValue: await colors(modal.locator('.stat-value').first()),
    saveIndicator: await colors(page.locator('.save-indicator')),
  };
  for (const pair of Object.values(measured))
    expect(contrast(pair.color, pair.background)).toBeGreaterThanOrEqual(4.5);
  await page.keyboard.press('Tab');
  const close = modal.getByRole('button', { name: '关闭对话框', exact: true });
  await close.focus();
  const focus = await colors(close);
  expect(parseFloat(focus.outlineWidth)).toBeGreaterThanOrEqual(2);
  expect(focus.outlineStyle).toBe('solid');
  // Tab may reveal the footer before focusing the header close button; capture the opening view.
  await modalBody.evaluate((body) => (body.scrollTop = 0));
  await expect.poll(() => modalBody.evaluate((body) => body.scrollTop)).toBe(0);
  await writeFile(
    info.outputPath('overview-opening-bounds.json'),
    JSON.stringify(
      await modal.evaluate((dialog) =>
        Object.fromEntries(
          ['.modal-body', '.overview-heading', '.overview-stats', '.operation-breakdown'].map(
            (selector) => [
              selector,
              dialog.querySelector(selector)!.getBoundingClientRect().toJSON(),
            ],
          ),
        ),
      ),
      null,
      2,
    ),
  );
  await capture(info, 'overview-narrow.png');
  await expect(modal.locator('.overview-stats')).toBeInViewport({ ratio: 1 });
  await expect(modal.locator('.operation-breakdown')).toBeInViewport({ ratio: 1 });
  await closeOverview(modal);
  await expect(page.locator('html')).not.toHaveClass(/has-experiment-overview/);
  const backgroundAfter = await page.evaluate(() => ({
    rootOverflow: getComputedStyle(document.documentElement).overflowY,
    bodyOverflow: getComputedStyle(document.body).overflowY,
    scrollTop: document.scrollingElement!.scrollTop,
  }));
  expect(backgroundAfter).toEqual(backgroundBefore);
  await writeFile(
    info.outputPath('modal-scroll.json'),
    JSON.stringify({ backgroundBefore, lockedScroll, scrolled, backgroundAfter }, null, 2),
  );

  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '专注当前样品', exact: true })).toBeVisible();
  await noHorizontalOverflow();
  const start = page.getByRole('button', { name: '开始操作', exact: true });
  await start.scrollIntoViewIfNeeded();
  await expect(start).toBeInViewport({ ratio: 1 });
  expect(
    await start.evaluate((button) => parseFloat(getComputedStyle(button).minHeight)),
  ).toBeGreaterThanOrEqual(54);
  const startColors = await colors(start);
  expect(contrast(startColors.color, startColors.background)).toBeGreaterThanOrEqual(4.5);
  modal = await openOverview();
  await closeOverview(modal);
  await page.getByRole('button', { name: '回看导出', exact: true }).click();
  modal = await openOverview();
  await noHorizontalOverflow(modal);
  await closeOverview(modal);
  await writeFile(
    info.outputPath('computed-colors.json'),
    JSON.stringify(
      {
        ...measured,
        startButton: startColors,
        focus,
        contrast: Object.fromEntries(
          Object.entries({ ...measured, startButton: startColors }).map(([name, pair]) => [
            name,
            contrast(pair.color, pair.background),
          ]),
        ),
      },
      null,
      2,
    ),
  );
  expect((await snapshot()).runs).toHaveLength(0); // Opening the overview never starts an operation.
});

test('two unknown preparation groups show unknown totals; mixed known subtotal and unknown group counts remain explicit in planning and overview', async () => {
  await createExperiment('准备未知实验', 'EXP-002', true);
  await addSamples('未知样品 1', '未知状态 1', '', '0');
  await addSamples('未知样品 2', '未知状态 2', '', '0');
  await expect(planStat('已知准备数量 · 包含备样').locator('strong')).toHaveText('未知');
  await expect(planStat('备样 · 现场按需启用').locator('strong')).toHaveText('未知');
  let modal = await openOverview();
  await expectCounts(modal, '未知', 0, 0, '未知');
  await expect(modal.getByRole('article', { name: '准备数量', exact: true })).toContainText(
    '2 组准备数量未知',
  );
  await expect(modal.getByRole('article', { name: '备样', exact: true })).toContainText(
    '2 组备样数量未知',
  );
  await expect(modal.getByLabel('完成进度', { exact: true })).toHaveText(
    '0 / 0 项已完成 · 暂无计划操作',
  );
  await closeOverview(modal);
  await addSamples('已知样品', '已知状态', '5', '1');
  const data = await snapshot();
  expect(data.groups.filter((g) => g.preparedCount === null)).toHaveLength(2);
  expect(data.groups.filter((g) => g.preparedCount !== null).map((g) => g.preparedCount)).toEqual([
    5,
  ]);
  await expect(planStat('样品组').locator('strong')).toHaveText('3组');
  await expect(planStat('已知准备数量 · 包含备样').locator('strong')).toHaveText('5个');
  await expect(planStat('已知准备数量 · 包含备样').locator('.stat-unknown')).toHaveText(
    '2 组准备数量未知',
  );
  await expect(planStat('备样 · 现场按需启用').locator('strong')).toHaveText('4个');
  await expect(planStat('备样 · 现场按需启用').locator('.stat-unknown')).toHaveText(
    '2 组备样数量未知',
  );
  modal = await openOverview();
  await expectCounts(modal, '5个', 1, 1, '4个');
  for (const label of ['准备数量', '备样'])
    await expect(modal.getByRole('article', { name: label, exact: true })).toContainText(
      '已知小计',
    );
  await expect(modal.getByRole('article', { name: '准备数量', exact: true })).toContainText(
    '2 组准备数量未知',
  );
  await expect(modal.getByRole('article', { name: '备样', exact: true })).toContainText(
    '2 组备样数量未知',
  );
  await closeOverview(modal);
});

test('real IPC experiment-level null-item/null-run and run-only issues remain visible after completion, have details and resolve without false sample navigation', async () => {
  const experiment = await createExperiment('问题处理实验', 'EXP-ISSUE', true);
  await addSamples('问题样品', '问题状态', '1', '1');
  await page.getByRole('button', { name: '进入现场记录', exact: true }).click();
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  const before = await snapshot();
  const run = before.runs[0],
    item = before.items[0],
    sample = before.samples[0];
  await command({
    type: 'addEvent',
    experimentId: experiment.id,
    eventType: 'issue',
    text: '实验级问题：仪器校准需要确认',
    category: '仪器问题',
  });
  await command({
    type: 'addEvent',
    experimentId: experiment.id,
    runId: run.id,
    eventType: 'issue',
    text: '实际记录问题：定位偏离',
    category: '样品问题',
  });
  let data = await snapshot();
  expect(data.events.find((e) => e.text === '实验级问题：仪器校准需要确认')).toMatchObject({
    itemId: null,
    runId: null,
    data: { resolvedAt: null },
  });
  expect(data.events.find((e) => e.text === '实际记录问题：定位偏离')).toMatchObject({
    itemId: null,
    runId: run.id,
    data: { resolvedAt: null },
  });
  await page.reload();
  await page.getByRole('button', { name: '完成并切换下一项', exact: true }).click();
  const completed = await snapshot();
  let modal = await openOverview();
  await expect(modal.getByLabel('完成进度', { exact: true })).toHaveText('1 / 1 项已完成 · 100%');
  await expect(modal.getByRole('heading', { name: '未处理问题 (2)', exact: true })).toBeVisible();
  const experimentIssue = modal.getByRole('article', {
    name: '问题：实验级问题：仪器校准需要确认',
    exact: true,
  });
  await expect(experimentIssue.getByRole('button', { name: '查看现场', exact: true })).toHaveCount(
    0,
  );
  await expect(experimentIssue.locator('.issue-sample')).toHaveText('实验问题 · 未关联样品');
  await experimentIssue.getByText('查看详情', { exact: true }).click();
  await expect(experimentIssue.locator('dd').nth(1)).toHaveText('未关联样品');
  await expect(experimentIssue.locator('dd').nth(3)).toHaveText('未关联操作');
  await expect(experimentIssue.locator('dd').nth(4)).toHaveText('未关联实际记录');
  const runIssue = modal.getByRole('article', {
    name: '问题：实际记录问题：定位偏离',
    exact: true,
  });
  await runIssue.getByText('查看详情', { exact: true }).click();
  await expect(runIssue.locator('dd').nth(1)).toHaveText(sample.id);
  await expect(runIssue.locator('dd').nth(3)).toHaveText(item.id);
  await expect(runIssue.locator('dd').nth(4)).toHaveText(run.id);
  await runIssue.getByRole('button', { name: '查看现场', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.locator('.current-heading h2')).toHaveText(sample.code);
  await expect(page.locator('.queue-choice[aria-pressed="true"]')).toHaveAttribute(
    'aria-label',
    `选择样品 ${sample.code} 操作 1`,
  );
  expect((await snapshot()).runs).toEqual(completed.runs);
  modal = await openOverview();
  await modal
    .getByRole('article', { name: '问题：实验级问题：仪器校准需要确认', exact: true })
    .getByRole('button', { name: '标记已处理', exact: true })
    .click();
  await expect(modal.getByRole('heading', { name: '未处理问题 (1)', exact: true })).toBeVisible();
  await modal
    .getByRole('article', { name: '问题：实际记录问题：定位偏离', exact: true })
    .getByRole('button', { name: '标记已处理', exact: true })
    .click();
  await expect(modal.getByRole('heading', { name: '未处理问题 (0)', exact: true })).toBeVisible();
  data = await snapshot();
  expect(data.events.filter((e) => e.type === 'issue')).toHaveLength(2);
  expect(data.events.filter((e) => e.type === 'issue' && !e.data.resolvedAt)).toHaveLength(0);
  expect(data.runs).toEqual(completed.runs);
  expect(data.items).toEqual(completed.items);
  await closeOverview(modal);
});

test('viewing B while A runs: actual draft flush failure blocks return; delayed success selects A and the exact running item without starting B', async ({}, info) => {
  const experimentA = await createExperiment('实验 A', 'EXP-A', true);
  await addSamples('样品 A', '状态 A', '2', '2');
  const initial = await snapshot();
  const itemA = initial.items.slice().sort((a, b) => a.order - b.order)[1];
  const sampleA = initial.samples.find((s) => s.id === itemA.sampleId)!;
  await page.getByRole('button', { name: '进入现场记录', exact: true }).click();
  await page.getByRole('button', { name: `选择样品 ${sampleA.code} 操作 2`, exact: true }).click();
  await page.getByRole('button', { name: '开始操作', exact: true }).click();
  await page.getByLabel('现场备注', { exact: true }).fill('跨实验前必须保存的记录');
  const experimentB = await createExperiment('实验 B', 'EXP-B');
  let data = await snapshot();
  const runA = data.runs.find((r) => r.itemId === itemA.id)!;
  expect(runA.notes).toBe('跨实验前必须保存的记录');
  await page.getByRole('button', { name: '实验规划', exact: true }).click();
  await addSamples('样品 B', '状态 B', '1', '1');
  data = await snapshot();
  const itemB = data.items.find((i) => i.experimentId === experimentB.id)!;
  const groupB = data.groups.find((g) => g.experimentId === experimentB.id)!;
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(900, 700);
    window.webContents.setZoomFactor(1.5);
  });
  await expect
    .poll(() =>
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
      ),
    )
    .toBe(1.5);
  const modal = await openOverview();
  await noHorizontalOverflow(modal);
  await expect(modal.locator('.overview-heading h3')).toHaveText('实验 B');
  await expectCounts(modal, '1个', 1, 1, '0个');
  await expectStatuses(modal, [1, 0, 0, 0, 0]);
  const running = modal.getByRole('region', { name: '全库进行中的操作', exact: true });
  await expect(running).toContainText('实验“实验 A”中有进行中的操作。');
  await expect(running).toContainText(sampleA.code);
  await expect(running).toContainText(sampleA.id);
  await expect(running.getByRole('button', { name: '切换并返回', exact: true })).toBeInViewport({
    ratio: 1,
  });
  expect(await modal.locator('.modal-body').evaluate((body) => body.scrollTop)).toBe(0);
  await capture(info, 'overview-running-narrow.png');
  const originalRuns = data.runs;

  await application.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => unknown> }
    )._invokeHandlers;
    const original = handlers.get('command');
    if (!original) throw new Error('Original IPC handler unavailable');
    ipcMain.removeHandler('command');
    ipcMain.handle('command', (...args) =>
      args[1]?.type === 'updateGroups'
        ? { ok: false, error: '概览测试：草稿写入失败' }
        : original(...args),
    );
    (globalThis as any).overviewOriginalCommand = original;
  });
  // Model a draft arriving after the dialog opens via the real AutoInput event path.
  // The input handler registers a Workspace draft; no React internals or fake snapshot are used.
  const draft = page.getByLabel('样品 B 样品统称', { exact: true });
  await draft.evaluate((input: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'B 保存后的名称',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('.save-indicator')).toContainText('保存失败');
  await running.getByRole('button', { name: '切换并返回', exact: true }).click();
  await expect(modal).toBeVisible();
  await expect(page.getByLabel('选择实验', { exact: true })).toHaveValue(experimentB.id);
  await expect(page.locator('.plan-page')).toHaveCount(1);
  await expect(page.locator('.live-page')).toHaveCount(0);
  await expect(draft).toHaveValue('B 保存后的名称');
  data = await snapshot();
  expect(data.groups.find((g) => g.id === groupB.id)!.name).toBe('样品 B');
  expect(data.runs).toEqual(originalRuns);
  expect(data.items.find((i) => i.id === itemB.id)!.status).toBe('pending');

  await application.evaluate(({ ipcMain }) => {
    const original = (globalThis as any).overviewOriginalCommand;
    ipcMain.removeHandler('command');
    ipcMain.handle('command', async (...args) => {
      if (args[1]?.type === 'updateGroups') {
        (globalThis as any).overviewSaveHeld = true;
        await new Promise<void>((release) => {
          (globalThis as any).overviewReleaseSave = release;
        });
      }
      return original(...args);
    });
  });
  await running.getByRole('button', { name: '切换并返回', exact: true }).click();
  await expect
    .poll(() => application.evaluate(() => Boolean((globalThis as any).overviewSaveHeld)))
    .toBe(true);
  await expect(modal).toBeVisible();
  await expect(page.getByLabel('选择实验', { exact: true })).toHaveValue(experimentB.id);
  // The existing save indicator retains the last failure until the retry succeeds.
  await expect(page.locator('.save-indicator')).toContainText('保存失败');
  expect((await snapshot()).groups.find((g) => g.id === groupB.id)!.name).toBe('样品 B');
  await application.evaluate(() => (globalThis as any).overviewReleaseSave());
  await expect(modal).toHaveCount(0);
  await expect(page.getByLabel('选择实验', { exact: true })).toHaveValue(experimentA.id);
  await expect(page.getByRole('heading', { name: '专注当前样品', exact: true })).toBeVisible();
  await expect(page.locator('.current-heading h2')).toHaveText(sampleA.code);
  await expect(page.locator('.queue-choice[aria-pressed="true"]')).toHaveAttribute(
    'aria-label',
    `选择样品 ${sampleA.code} 操作 2`,
  );
  await expect(page.getByLabel('现场备注', { exact: true })).toHaveValue(runA.notes);
  data = await snapshot();
  expect(data.groups.find((g) => g.id === groupB.id)!.name).toBe('B 保存后的名称');
  expect(data.items.filter((i) => i.status === 'running').map((i) => i.id)).toEqual([itemA.id]);
  expect(data.items.find((i) => i.id === itemB.id)!.status).toBe('pending');
  expect(data.runs).toEqual(originalRuns);
  expect(data.events.filter((e) => e.type === 'start')).toHaveLength(1);
});
