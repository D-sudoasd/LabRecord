export type Value = string | number | null;
export type Values = Record<string, Value>;
export type Mode = '未定' | 'In situ' | 'Ex situ';
export type Priority = 'P0' | 'P1' | 'P2';
export type Status = 'pending' | 'running' | 'completed' | 'skipped' | 'interrupted';
export interface Field {
  id: string;
  label: string;
  type: 'text' | 'number' | 'select';
  unit: string;
  options: string[];
}
export interface Experiment {
  id: string;
  code: string;
  name: string;
  description: string;
  fields: Field[];
  namingPattern: string;
  createdAt: string;
}
export interface Group {
  id: string;
  experimentId: string;
  state: string;
  name?: string;
  width?: string;
  height?: string;
  dimensionUnit?: string;
  preparedCount: number | null;
  mode: Mode;
  priority: Priority;
  thickness: string;
  thicknessUnit: string;
  preparation: string;
  notes: string;
  values: Values;
  order: number;
  legacyCompleted: boolean | null;
  legacyTime: string;
}
export interface Sample {
  id: string;
  experimentId: string;
  groupId: string;
  code: string;
  values: Values;
  parameters: Partial<Group>;
}
export interface PlanItem {
  id: string;
  experimentId: string;
  sampleId: string;
  operation: string;
  order: number;
  status: Status;
  repeatOf?: string;
}
export interface Run {
  id: string;
  experimentId: string;
  itemId: string;
  sampleId: string;
  number: number;
  startedAt: string | null;
  endedAt: string | null;
  originalStartedAt: string | null;
  originalEndedAt: string | null;
  timezone: string;
  offsetMinutes: number;
  filename: string;
  snapshot: { group: Group; sample: Sample; operation: string; fields: Field[] };
  actual: Values;
  actualSample?: SampleDetails;
  notes: string;
}
export interface SampleDetails {
  name: string;
  width: string;
  height: string;
  dimensionUnit: string;
}
export interface RecordEvent {
  id: string;
  experimentId: string;
  itemId: string | null;
  runId: string | null;
  type: string;
  text: string;
  createdAt: string;
  data: Record<string, unknown>;
}
export interface Attachment {
  id: string;
  experimentId: string;
  runId: string;
  name: string;
  relativePath: string;
  mime: string;
  sha256: string;
  size: number;
}
export interface Snapshot {
  schemaVersion: 1;
  experiments: Experiment[];
  groups: Group[];
  samples: Sample[];
  items: PlanItem[];
  runs: Run[];
  events: RecordEvent[];
  attachments: Attachment[];
}
export type GroupPatch = Partial<
  Pick<
    Group,
    | 'state'
    | 'name'
    | 'width'
    | 'height'
    | 'dimensionUnit'
    | 'preparedCount'
    | 'mode'
    | 'priority'
    | 'thickness'
    | 'thicknessUnit'
    | 'preparation'
    | 'notes'
    | 'values'
  >
>;
export type Command =
  | { type: 'createExperiment'; name: string; code: string; description?: string }
  | {
      type: 'updateExperiment';
      id: string;
      name?: string;
      description?: string;
      fields?: Field[];
      namingPattern?: string;
    }
  | { type: 'createGroup'; experimentId: string; patch: GroupPatch }
  | { type: 'addSamples'; experimentId: string; patch: GroupPatch; count: number; prefix?: string }
  | { type: 'temporary'; experimentId: string; patch: GroupPatch }
  | { type: 'updateGroups'; ids: string[]; patch: GroupPatch }
  | { type: 'copyGroup'; id: string }
  | { type: 'arrange'; groupId: string; count: number; prefix?: string }
  | {
      type: 'updateSamples';
      ids: string[];
      parameters?: GroupPatch;
      values?: Values;
      code?: string;
    }
  | { type: 'reorder'; experimentId: string; ids: string[] }
  | { type: 'start' | 'finish' | 'interrupt' | 'skip' | 'unskip' | 'repeat'; itemId: string }
  | {
      type: 'saveRun';
      runId: string;
      notes?: string;
      actual?: Values;
      actualSample?: Partial<SampleDetails>;
    }
  | {
      type: 'addEvent';
      experimentId: string;
      itemId?: string;
      runId?: string;
      eventType: 'note' | 'issue';
      text: string;
      category?: string;
    }
  | { type: 'resolveIssue'; eventId: string }
  | {
      type: 'times';
      itemId: string;
      startedAt: string | null;
      endedAt: string | null;
      reason?: string;
    }
  | { type: 'demo' };
export interface CommandResult {
  snapshot: Snapshot;
  experimentId?: string;
  itemId?: string;
}
export type ImportKey =
  | 'state'
  | 'name'
  | 'width'
  | 'height'
  | 'dimensionUnit'
  | 'preparedCount'
  | 'mode'
  | 'priority'
  | 'thickness'
  | 'thicknessUnit'
  | 'notes'
  | 'preparation'
  | 'legacyCompleted'
  | 'legacyTime';
export interface TablePreview {
  name: string;
  headers: string[];
  rows: string[][];
  mapping: Partial<Record<ImportKey, number>>;
  warnings: string[];
  customFields?: { column: number; definition: Field }[];
}
export interface ImportRequest {
  experimentId: string;
  table: TablePreview;
  mapping: Partial<Record<ImportKey, number>>;
  keepOtherColumns: boolean;
}
export interface DesktopInfo {
  dataPath: string;
  version: string;
  backupPath: string;
  automaticBackupError: string | null;
}
export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
export interface DesktopApi {
  snapshot(): Promise<Reply<Snapshot>>;
  command(command: Command, requestId: string): Promise<Reply<CommandResult>>;
  previewFile(): Promise<Reply<TablePreview | null>>;
  previewText(text: string): Promise<Reply<TablePreview>>;
  importTable(request: ImportRequest): Promise<Reply<Snapshot>>;
  exportFile(experimentId: string, format: 'xlsx' | 'csv' | 'json'): Promise<Reply<string | null>>;
  addAttachment(runId: string): Promise<Reply<Snapshot | null>>;
  chooseReference(): Promise<Reply<string[]>>;
  backup(): Promise<Reply<string | null>>;
  restore(): Promise<Reply<Snapshot | null>>;
  info(): Promise<Reply<DesktopInfo>>;
  revealData(): Promise<Reply<null>>;
  printReport(): Promise<Reply<null>>;
  exportReport(experimentId: string): Promise<Reply<ReportExportResult | null>>;
  reportJobs(): Promise<Reply<ReportJob[]>>;
  retryReportArchives(): Promise<Reply<null>>;
  cloudReports(): Promise<Reply<CloudReport[]>>;
  downloadCloudReport(id: string): Promise<Reply<string | null>>;
  openCloudReports(): Promise<Reply<null>>;
  setReportArchiveEnabled(enabled: boolean): Promise<Reply<CloudStatus>>;
  cloudStatus(): Promise<Reply<CloudStatus>>;
  cloudConnect(input: {
    repository: string;
    token?: string;
    create?: boolean;
  }): Promise<Reply<CloudStatus>>;
  cloudSync(mode?: 'auto' | 'upload' | 'download'): Promise<Reply<CloudResult>>;
  openHelp(): Promise<Reply<null>>;
  onClosing(handler: () => Promise<void>): () => void;
}
export interface CloudStatus {
  repository: string;
  account: string;
  connected: boolean;
  githubCliAvailable: boolean;
  lastSyncedAt: string | null;
  reportArchiveEnabled: boolean;
}
export interface ReportExportResult {
  localPath: string;
  archiveId: string | null;
  archiveState: 'local' | 'pending' | 'failed';
  archiveError: string | null;
}
export interface CloudReport {
  id: string;
  experimentId: string;
  experimentName: string;
  code: string;
  generatedAt: string;
  manifestSha256: string;
  multipartFiles?: string[];
}
export interface ReportJob extends Omit<CloudReport, 'manifestSha256'> {
  repository: string;
  prefix: string;
  localPath: string;
  state: 'pending' | 'uploading' | 'uploaded' | 'failed';
  error: string | null;
}
export interface CloudSummary {
  experiments: number;
  operations: number;
  recorded: number;
  images: number;
}
export interface CloudResult {
  action: 'uploaded' | 'downloaded' | 'unchanged' | 'conflict';
  local: CloudSummary;
  remote: CloudSummary | null;
  snapshot?: Snapshot;
  message: string;
}
export function sampleName(group: Group) {
  return group.name?.trim() || group.state;
}
export function dimensions(
  group: Pick<Group, 'thickness' | 'thicknessUnit' | 'width' | 'height' | 'dimensionUnit'>,
) {
  const value = (number: string | undefined, unit: string | undefined) =>
    number ? `${number} ${unit || '（单位未定）'}` : '未填写';
  return `厚 ${value(group.thickness, group.thicknessUnit)} · 宽 ${value(group.width, group.dimensionUnit)}${group.height ? ` · 高 ${value(group.height, group.dimensionUnit)}` : ''}`;
}
export function groupCounts(snapshot: Snapshot, group: Group) {
  const samples = snapshot.samples.filter((s) => s.groupId === group.id);
  const ids = new Set(samples.map((s) => s.id));
  const items = snapshot.items.filter((i) => ids.has(i.sampleId));
  return {
    planned: samples.length,
    spare: group.preparedCount === null ? null : Math.max(0, group.preparedCount - samples.length),
    shortage: group.preparedCount === null ? 0 : Math.max(0, samples.length - group.preparedCount),
    completed: items.filter((i) => i.status === 'completed').length,
    total: items.length,
  };
}
export const STATUS_LABEL: Record<Status, string> = {
  pending: '待测',
  running: '进行中',
  completed: '已完成',
  skipped: '已跳过',
  interrupted: '已中断',
};
export const DEFAULT_PATTERN = '{experiment}_{sample}_{run:03}';
export function filenameFor(pattern: string, experiment: string, sample: string, number: number) {
  const safe = (value: string) =>
    value
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/[. ]+$/g, '');
  if (!pattern.trim() || /\{(?!experiment\}|sample\}|run(?::0[1-9])?\})/.test(pattern))
    throw new Error('命名规则仅支持 {experiment}、{sample} 和 {run:03}。');
  const value = pattern
    .replace(/\{experiment\}/g, safe(experiment))
    .replace(/\{sample\}/g, safe(sample))
    .replace(/\{run(?::0([1-9]))?\}/g, (_, width) =>
      String(number).padStart(Number(width || 1), '0'),
    );
  if (
    /[<>:"/\\|?*\x00-\x1f{}]/.test(value) ||
    !value ||
    /[. ]$/.test(value) ||
    value.length > 200 ||
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)
  )
    throw new Error('预期文件名包含 Windows 不支持的字符、保留名称或长度超过 200 字符。');
  return value;
}
