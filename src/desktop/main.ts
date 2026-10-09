import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  protocol,
  net,
  shell,
  Menu,
  clipboard,
} from 'electron';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, rename, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Store, CommandRejectedError } from './store.js';
import { previewFile, previewRows, parseDelimited, importTable, exportFile } from './tables.js';
import { addAttachment, createBackup, dailyBackup, unpackBackup } from './backups.js';
import { writeReportBundle } from './reports.js';
import { CloudSync } from './github-sync.js';
import { CloudCredentials } from './cloud-credentials.js';
import { ReportArchive, ReportQueue } from './report-archive.js';
import type { Reply } from '../shared/model.js';

app.setName('LabRecord');
if (process.env.LABRECORD_TEST_DATA && process.env.LABRECORD_TEST_MODE === '1')
  app.setPath('userData', resolve(process.env.LABRECORD_TEST_DATA));
protocol.registerSchemesAsPrivileged([
  { scheme: 'labrecord', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const hasLock = app.requestSingleInstanceLock();
let window: BrowserWindow;
let store: Store;
let restoring = false;
let closeApproved = false;
let serial: Promise<unknown> = Promise.resolve();
const desktopRoot = dirname(fileURLToPath(import.meta.url));
const dataPath = app.getPath('userData');
app.setPath('sessionData', dataPath);
const workspacePath = join(dataPath, 'workspace');
const backupPath = join(dataPath, 'backups');
const credentials = new CloudCredentials(join(dataPath, 'cloud-credentials.json'));
const syncStatePath = join(dataPath, 'cloud-state.json');
const reportQueue = new ReportQueue(join(dataPath, 'report-archive'));
const reportPrefix = () =>
  process.env.LABRECORD_TEST_MODE === '1'
    ? process.env.LABRECORD_TEST_SYNC_PREFIX || 'labrecord'
    : 'labrecord';
function retryReports() {
  void reportQueue
    .run(async () => {
      const config = await credentials.config();
      if (!config || config.reportArchiveEnabled === false) return null;
      try {
        const session = await credentials.client();
        return { ...session, repository: config.repository, prefix: reportPrefix() };
      } catch (error) {
        await reportQueue.failWaiting(config.repository, reportPrefix(), message(error));
        return null;
      }
    })
    .catch((error) => console.error('报告归档：', message(error)));
}
let automaticBackupError: string | null = null;
let lastAutomaticDate = '';
let backupTimer: ReturnType<typeof setTimeout> | undefined;
async function ensureAutomaticBackup() {
  const today = new Date().toLocaleDateString('sv-SE');
  if (lastAutomaticDate === today || !store?.list('experiments').length) return;
  try {
    await dailyBackup(store, backupPath);
    lastAutomaticDate = today;
    automaticBackupError = null;
  } catch (error) {
    automaticBackupError = message(error);
    console.error('自动备份失败:', automaticBackupError);
  }
}
function scheduleAutomaticBackup() {
  if (backupTimer || lastAutomaticDate === new Date().toLocaleDateString('sv-SE')) return;
  backupTimer = setTimeout(() => {
    backupTimer = undefined;
    serial = serial.then(ensureAutomaticBackup);
  }, 3000);
}
async function discardStaging(path: string) {
  const absolute = resolve(path);
  if (
    !absolute.startsWith(resolve(dataPath) + sep) ||
    !absolute.slice(resolve(dataPath).length + 1).match(/^restore-[a-f0-9-]+$/)
  )
    throw new Error('恢复临时目录无效。');
  await rm(absolute, { recursive: true, force: true });
}
function message(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed: samples/.test(text))
    return '样品编号与当前实验中的另一个样品重复。';
  if (/SQLITE|database|disk|ENOSPC|EACCES|EPERM/i.test(text))
    return '数据未能保存。请检查磁盘空间或目录权限，保留当前输入后重试。详细信息：' + text;
  return text;
}
function checkDestination(path: string) {
  if (
    resolve(path).toLowerCase() === resolve(workspacePath).toLowerCase() ||
    resolve(path)
      .toLowerCase()
      .startsWith(resolve(workspacePath).toLowerCase() + sep)
  )
    throw new Error('请将导出文件或备份保存在实验数据目录之外，避免覆盖数据库和附件。');
}
async function installWorkspace(staging: string, reason = 'before-restore') {
  restoring = true;
  try {
    await mkdir(backupPath, { recursive: true });
    await createBackup(
      store,
      join(backupPath, `${reason}-${Date.now()}-${randomUUID()}.labrecord`),
    );
    store.close();
    const previous = join(dataPath, 'previous-' + randomUUID());
    let moved = false;
    try {
      await rename(workspacePath, previous);
      moved = true;
      await rename(staging, workspacePath);
      store = new Store(workspacePath);
    } catch (error) {
      if (moved) {
        await rename(workspacePath, staging).catch(() => {});
        await rename(previous, workspacePath);
      }
      store = new Store(workspacePath);
      throw error;
    }
    return store.snapshot();
  } finally {
    restoring = false;
  }
}
function register(channel: string, action: (...args: any[]) => unknown, serialize = true) {
  ipcMain.handle(channel, async (event, ...args): Promise<Reply<unknown>> => {
    if (event.sender !== window.webContents || event.senderFrame?.url.split('/')[2] !== 'app')
      return { ok: false, error: '请求来源无效。' };
    const execute = async () => {
      try {
        if (restoring && channel !== 'info') throw new Error('正在恢复数据，请稍后重试。');
        const data = await action(...args);
        if (['command', 'import-table', 'attachment'].includes(channel)) scheduleAutomaticBackup();
        return { ok: true as const, data };
      } catch (error) {
        return {
          ok: false as const,
          error: message(error),
          ...(error instanceof CommandRejectedError ? { rejected: true } : {}),
        };
      }
    };
    if (!serialize) return execute();
    const result = serial.then(execute, execute);
    serial = result.then(() => undefined);
    return result;
  });
}
if (!hasLock) app.quit();
else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(null);
      store = new Store(workspacePath);
      protocol.handle('labrecord', async (request) => {
        const url = new URL(request.url);
        if (url.hostname === 'attachment') {
          const id = url.pathname.slice(1);
          const attachment = store.list('attachments').find((a) => a.id === id);
          if (!attachment) return new Response('Not found', { status: 404 });
          return new Response(await readFile(join(store.root, attachment.relativePath)), {
            headers: {
              'Content-Type': attachment.mime,
              'Content-Security-Policy': "default-src 'none'",
            },
          });
        }
        if (url.hostname !== 'app') return new Response('Forbidden', { status: 403 });
        const root = resolve(desktopRoot, '../ui');
        let path: string;
        try {
          path = resolve(
            root,
            '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname),
          );
        } catch {
          return new Response('Bad request', { status: 400 });
        }
        if (!path.startsWith(root + sep)) return new Response('Forbidden', { status: 403 });
        return net.fetch(pathToFileURL(path).toString());
      });
      window = new BrowserWindow({
        width: 1440,
        height: 940,
        minWidth: 900,
        minHeight: 650,
        show: false,
        title: 'LabRecord',
        icon: join(desktopRoot, '../ui/icon.png'),
        backgroundColor: '#f5f7f6',
        autoHideMenuBar: true,
        webPreferences: {
          preload: join(desktopRoot, 'preload.cjs'),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('labrecord://app/')) event.preventDefault();
      });
      window.webContents.session.setPermissionRequestHandler(
        (_webContents, _permission, callback) => callback(false),
      );
      register('snapshot', () => store.snapshot());
      register('copy-name', (name) => {
        if (
          typeof name !== 'string' ||
          !name ||
          name.length > 200 ||
          /[<>:"/\\|?*\x00-\x1f{}]/.test(name)
        )
          throw new Error('待复制名称无效。');
        clipboard.writeText(name);
        return null;
      });
      register('command', (command, requestId) => store.command(command, requestId));
      register('preview-text', (text) => {
        if (typeof text !== 'string' || text.length > 5_000_000)
          throw new Error('粘贴内容过大或格式无效。');
        return previewRows(parseDelimited(text));
      });
      register('preview-file', async () => {
        const result = await dialog.showOpenDialog(window, {
          title: '导入实验规划',
          properties: ['openFile'],
          filters: [{ name: '实验规划表格', extensions: ['xlsx', 'csv', 'tsv', 'txt'] }],
        });
        return result.canceled ? null : previewFile(result.filePaths[0]);
      });
      register('import-table', (request) => importTable(store, request));
      register('export-file', async (experimentId, format) => {
        if (!['xlsx', 'csv', 'json'].includes(format)) throw new Error('导出格式无效。');
        const experiment = store.get('experiments', experimentId);
        const result = await dialog.showSaveDialog(window, {
          title: '导出实验记录',
          defaultPath: `${experiment.code.replace(/[<>:"/\\|?*]/g, '_')}-实验记录.${format}`,
          filters: [{ name: format.toUpperCase(), extensions: [format] }],
        });
        if (result.canceled || !result.filePath) return null;
        checkDestination(result.filePath);
        await exportFile(store.snapshot(), experimentId, format, result.filePath);
        return result.filePath;
      });
      register('reference', async () => {
        const result = await dialog.showOpenDialog(window, {
          title: '关联实验数据文件（记录路径）',
          properties: ['openFile', 'multiSelections'],
        });
        return result.canceled ? [] : result.filePaths;
      });
      register('attachment', async (runId) => {
        store.get('runs', runId);
        const result = await dialog.showOpenDialog(window, {
          title: '添加现场图片',
          filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
          properties: ['openFile', 'multiSelections'],
        });
        if (result.canceled) return null;
        for (const path of result.filePaths) await addAttachment(store, runId, path);
        return store.snapshot();
      });
      register('backup', async () => {
        const result = await dialog.showSaveDialog(window, {
          title: '备份全部实验与附件',
          defaultPath: `LabRecord-${new Date().toLocaleDateString('sv-SE')}.labrecord`,
          filters: [{ name: 'LabRecord 完整备份', extensions: ['labrecord'] }],
        });
        if (result.canceled || !result.filePath) return null;
        checkDestination(result.filePath);
        await createBackup(store, result.filePath);
        return result.filePath;
      });
      register('restore', async () => {
        const result = await dialog.showOpenDialog(window, {
          title: '恢复 LabRecord 完整备份',
          filters: [{ name: 'LabRecord 完整备份', extensions: ['labrecord'] }],
          properties: ['openFile'],
        });
        if (result.canceled) return null;
        const staging = join(dataPath, 'restore-' + randomUUID());
        try {
          await unpackBackup(result.filePaths[0], staging);
          const confirmation = await dialog.showMessageBox(window, {
            type: 'question',
            title: '恢复备份',
            message: '备份校验通过，是否切换到此备份？',
            detail: '当前全部数据会先保存为完整备份。恢复后可在备份目录中找回原有数据。',
            buttons: ['恢复', '取消'],
            defaultId: 1,
            cancelId: 1,
          });
          if (confirmation.response !== 0) return null;
          return await installWorkspace(staging);
        } finally {
          restoring = false;
          await discardStaging(staging);
        }
      });
      register('export-report', async (experimentId) => {
        if (typeof experimentId !== 'string') throw new Error('实验编号无效。');
        store.get('experiments', experimentId);
        const choice = await dialog.showOpenDialog(window, {
          title: '选择实验报告保存目录',
          properties: ['openDirectory', 'createDirectory'],
        });
        if (choice.canceled || !choice.filePaths.length) return null;
        checkDestination(choice.filePaths[0]);
        const localPath = await writeReportBundle(
          store.snapshot(),
          experimentId,
          store.root,
          choice.filePaths[0],
          async (path) => {
            const report = new BrowserWindow({
              show: false,
              webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
            });
            report.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            try {
              await report.loadFile(path);
              await report.webContents.executeJavaScript(
                'Promise.all(Array.from(document.images, image => image.decode().catch(() => {}))).then(() => document.fonts.ready).then(() => true)',
              );
              return await report.webContents.printToPDF({
                printBackground: true,
                pageSize: 'A4',
                preferCSSPageSize: true,
              });
            } finally {
              report.destroy();
            }
          },
        );
        try {
          const config = await credentials.config();
          if (!config || config.reportArchiveEnabled === false)
            return { localPath, archiveId: null, archiveState: 'local', archiveError: null };
          const experiment = store.get('experiments', experimentId);
          const job = await reportQueue.enqueue(
            localPath,
            config.repository,
            reportPrefix(),
            experiment.name,
            experiment.code,
          );
          retryReports();
          return { localPath, archiveId: job.id, archiveState: 'pending', archiveError: null };
        } catch (error) {
          return {
            localPath,
            archiveId: null,
            archiveState: 'failed',
            archiveError: message(error),
          };
        }
      });
      register('report-jobs', () => reportQueue.list(), false);
      register(
        'retry-report-archives',
        () => {
          retryReports();
          return null;
        },
        false,
      );
      register('report-archive-preference', async (enabled) => {
        const result = await credentials.setReportArchiveEnabled(enabled);
        if (enabled) retryReports();
        return result;
      });
      register(
        'cloud-reports',
        async () => {
          const { config, client } = await credentials.client();
          return new ReportArchive(client, config.repository, reportPrefix()).list();
        },
        false,
      );
      register(
        'open-cloud-reports',
        async () => {
          const { config, client } = await credentials.client();
          await client.verifyPrivate(config.repository);
          await shell.openExternal(
            `https://github.com/${config.repository}/tree/HEAD/${reportPrefix()}/reports`,
          );
          return null;
        },
        false,
      );
      register(
        'download-cloud-report',
        async (reportId) => {
          if (typeof reportId !== 'string' || !/^[a-f0-9-]{36}$/.test(reportId))
            throw new Error('报告编号无效。');
          const { config, client } = await credentials.client();
          const choice = await dialog.showOpenDialog(window, {
            title: '选择云端报告下载目录',
            properties: ['openDirectory', 'createDirectory'],
          });
          if (choice.canceled || !choice.filePaths.length) return null;
          checkDestination(choice.filePaths[0]);
          const path = await new ReportArchive(client, config.repository, reportPrefix()).download(
            reportId,
            choice.filePaths[0],
          );
          shell.showItemInFolder(path);
          return path;
        },
        false,
      );
      register('cloud-status', async () => {
        let last: { repository: string; lastSyncedAt: string } | null = null;
        try {
          last = JSON.parse(await readFile(syncStatePath, 'utf8'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw new Error('同步状态读取失败。');
        }
        const config = await credentials.config();
        return credentials.status(
          last?.repository === config?.repository ? last?.lastSyncedAt || null : null,
        );
      });
      register('cloud-connect', async (input) => {
        const result = await credentials.connect(input);
        retryReports();
        return result;
      });
      register('cloud-sync', async (mode = 'auto') => {
        if (!['auto', 'upload', 'download'].includes(mode)) throw new Error('同步操作无效。');
        const { config, client } = await credentials.client();
        const sync = new CloudSync({
          repository: config.repository,
          client,
          statePath: syncStatePath,
          temporaryRoot: dataPath,
          getStore: () => store,
          install: (staging) => installWorkspace(staging, 'before-cloud'),
          prefix:
            process.env.LABRECORD_TEST_MODE === '1'
              ? process.env.LABRECORD_TEST_SYNC_PREFIX
              : undefined,
        });
        const result = await sync.sync(mode);
        retryReports();
        return result;
      });
      register(
        'info',
        () => ({
          dataPath: workspacePath,
          backupPath,
          version: app.getVersion(),
          automaticBackupError,
        }),
        false,
      );
      register(
        'reveal-data',
        () => {
          shell.showItemInFolder(join(store.root, 'records.sqlite'));
          return null;
        },
        false,
      );
      register(
        'print-report',
        () =>
          new Promise((resolvePrint, rejectPrint) =>
            window.webContents.print({ printBackground: true }, (success) =>
              success ? resolvePrint(null) : rejectPrint(new Error('打印未完成。')),
            ),
          ),
      );
      register(
        'open-help',
        async () => {
          const file = app.isPackaged
            ? join(dirname(process.execPath), '使用说明.html')
            : join(app.getAppPath(), 'docs', '使用说明.html');
          const error = await shell.openPath(file);
          if (error) throw new Error('无法打开使用说明：' + error);
          return null;
        },
        false,
      );
      ipcMain.on('close-ready', (event, success) => {
        if (event.sender !== window.webContents || event.senderFrame?.url.split('/')[2] !== 'app')
          return;
        if (success === true)
          void serial.then(ensureAutomaticBackup).then(() => {
            closeApproved = true;
            window.close();
          });
        else
          dialog.showErrorBox('仍有未保存内容', '请在界面中重试保存后再关闭，当前输入会继续保留。');
      });
      await window.loadURL('labrecord://app/index.html');
      window.on('close', (event) => {
        if (!closeApproved) {
          event.preventDefault();
          window.webContents.send('prepare-close');
        }
      });
      if (process.env.LABRECORD_TEST_MODE !== '1') window.show();
      serial = serial.then(ensureAutomaticBackup);
      retryReports();
      setInterval(
        () => {
          serial = serial.then(ensureAutomaticBackup);
        },
        60 * 60 * 1000,
      ).unref();
    })
    .catch((error) => {
      dialog.showErrorBox('LabRecord 无法启动', message(error));
      app.exit(1);
    });
  app.on('before-quit', (event) => {
    if (restoring) {
      event.preventDefault();
      return;
    }
    if (window && !window.isDestroyed() && !closeApproved) {
      event.preventDefault();
      window.close();
    }
  });
  app.on('will-quit', () => {
    if (store) store.close();
  });
  app.on('window-all-closed', () => app.quit());
}
