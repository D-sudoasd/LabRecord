import type { DesktopApi } from '../shared/model.js';
const { contextBridge, ipcRenderer } = require('electron');
const call = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
const api: DesktopApi = {
  copyName: (name) => call('copy-name', name),
  snapshot: () => call('snapshot'),
  command: (command, requestId) => call('command', command, requestId),
  previewFile: () => call('preview-file'),
  previewText: (text) => call('preview-text', text),
  importTable: (request) => call('import-table', request),
  exportFile: (experimentId, format) => call('export-file', experimentId, format),
  addAttachment: (runId) => call('attachment', runId),
  chooseReference: () => call('reference'),
  backup: () => call('backup'),
  restore: () => call('restore'),
  info: () => call('info'),
  revealData: () => call('reveal-data'),
  printReport: () => call('print-report'),
  exportReport: (experimentId) => call('export-report', experimentId),
  reportJobs: () => call('report-jobs'),
  retryReportArchives: () => call('retry-report-archives'),
  cloudReports: () => call('cloud-reports'),
  downloadCloudReport: (id) => call('download-cloud-report', id),
  openCloudReports: () => call('open-cloud-reports'),
  setReportArchiveEnabled: (enabled) => call('report-archive-preference', enabled),
  cloudStatus: () => call('cloud-status'),
  cloudConnect: (input) => call('cloud-connect', input),
  cloudSync: (mode = 'auto') => call('cloud-sync', mode),
  openHelp: () => call('open-help'),
  onClosing: (handler) => {
    const listener = async () => {
      try {
        await handler();
        ipcRenderer.send('close-ready', true);
      } catch {
        ipcRenderer.send('close-ready', false);
      }
    };
    ipcRenderer.on('prepare-close', listener);
    return () => ipcRenderer.removeListener('prepare-close', listener);
  },
};
contextBridge.exposeInMainWorld('labrecord', Object.freeze(api));
