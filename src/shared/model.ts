export type Value = string | number | null;
export type Values = Record<string, Value>;
export type Mode = '未定' | 'In situ' | 'Ex situ';
export const MODE_LABEL: Record<Mode, string> = {
  未定: '未定',
  'In situ': '原位',
  'Ex situ': '非原位',
};
export const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: '未定', label: '未定' },
  { value: 'In situ', label: '原位' },
  { value: 'Ex situ', label: '非原位' },
];
export const PROTOCOL_PLACEHOLDER =
  '例如：10 °C/min 升至 375 °C，保温 30 min；或写明气氛、载荷与采集间隔';
export function effectiveProtocol(
  group: { protocol?: string },
  parameters?: { protocol?: string },
) {
  const own = parameters?.protocol;
  if (typeof own === 'string' && own.trim()) return own;
  return group.protocol ?? '';
}
export function planSpecimens(
  existing: Iterable<string>,
  count: number,
  prefix: string,
  _group: { state: string },
) {
  const taken = new Set(Array.from(existing, (code) => code.toLowerCase()));
  const stem = prefix.trim() || 'S';
  const rows: { code: string; ordinal: string }[] = [];
  let number = 1;
  while (rows.length < count) {
    const ordinal = String(number++).padStart(2, '0');
    const code = stem + ordinal;
    if (taken.has(code.toLowerCase())) continue;
    taken.add(code.toLowerCase());
    rows.push({ code, ordinal });
  }
  return rows;
}
export function suggestedSpecimenName(group: { name?: string; state: string }, ordinal: string) {
  return `${(group.name?.trim() || group.state).trim()}-${ordinal}`;
}
export function specimenParameters(
  group: { protocol?: string },
  specimen: { name?: string; protocol?: string },
): Partial<Group> {
  const parameters: Partial<Group> = {};
  const name = specimen.name?.trim() ?? '';
  if (name) parameters.name = name;
  const protocol = specimen.protocol ?? '';
  if (protocol.trim() && protocol.trim() !== (group.protocol ?? '').trim())
    parameters.protocol = protocol;
  return parameters;
}
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
  material?: string;
  composition?: string;
  processing?: string;
  heatTreatment?: string;
  otherTreatment?: string;
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
  protocol: string;
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
  measurement?: MeasurementPlan;
  nameNumber?: number;
  plannedName?: string;
}
export interface MeasurementPlan {
  mode?: Mode;
  technique?: string;
  regime?: string;
  batch?: string;
  protocol?: string;
  customName?: string;
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
  snapshot: {
    group: Group;
    sample: Sample;
    operation: string;
    fields: Field[];
    measurement?: MeasurementPlan;
  };
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
    | 'material'
    | 'composition'
    | 'processing'
    | 'heatTreatment'
    | 'otherTreatment'
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
    | 'protocol'
    | 'values'
  >
>;
export type Command =
  | {
      type: 'createExperiment';
      name: string;
      code: string;
      description?: string;
      namingPattern?: string;
      fields?: Field[];
    }
  | {
      type: 'updateExperiment';
      id: string;
      name?: string;
      description?: string;
      fields?: Field[];
      namingPattern?: string;
    }
  | { type: 'createGroup'; experimentId: string; patch: GroupPatch }
  | {
      type: 'addSamples';
      experimentId: string;
      patch: GroupPatch;
      count: number;
      prefix?: string;
      measurement?: MeasurementPlan;
    }
  | { type: 'temporary'; experimentId: string; patch: GroupPatch }
  | { type: 'updateGroups'; ids: string[]; patch: GroupPatch }
  | { type: 'copyGroup'; id: string }
  | { type: 'deleteGroups'; ids: string[] }
  | { type: 'deleteSamples'; ids: string[] }
  | { type: 'deleteItems'; ids: string[] }
  | { type: 'deleteExperiment'; id: string }
  | {
      type: 'arrange';
      groupId: string;
      count: number;
      prefix?: string;
      specimens?: { name?: string; protocol?: string }[];
      measurement?: MeasurementPlan;
    }
  | {
      type: 'updateSamples';
      ids: string[];
      parameters?: GroupPatch;
      values?: Values;
      code?: string;
    }
  | { type: 'reorder'; experimentId: string; ids: string[] }
  | { type: 'configureMeasurements'; ids: string[]; measurement: MeasurementPlan }
  | {
      type: 'scheduleMeasurements';
      itemIds: string[];
      measurement?: MeasurementPlan;
      repetitions?: number;
    }
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
  | 'material'
  | 'composition'
  | 'processing'
  | 'heatTreatment'
  | 'otherTreatment'
  | 'width'
  | 'height'
  | 'dimensionUnit'
  | 'preparedCount'
  | 'mode'
  | 'priority'
  | 'thickness'
  | 'thicknessUnit'
  | 'notes'
  | 'protocol'
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
export type Reply<T> = { ok: true; data: T } | { ok: false; error: string; rejected?: boolean };
export interface DesktopApi {
  copyName(name: string): Promise<Reply<null>>;
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
export const LEGACY_PATTERN = '{experiment}_{sample}_{run:03}';
export const DEFAULT_PATTERN = '{experiment}_{sample}';
export const DETAILED_PATTERN = '{experiment}_{material}_{state}_{sample}_{mode}_{regime}_{batch}';
export function filenameFor(
  pattern: string,
  experiment: string,
  sample: string,
  number: number,
  context: Partial<
    Record<'material' | 'state' | 'mode' | 'technique' | 'regime' | 'batch', string>
  > = {},
) {
  const contextual = /\{(material|state|mode|technique|regime|batch)\}/.test(pattern);
  const safe = (value: string) =>
    (contextual
      ? value.replace(/[<>:"/\\|?*\x00-\x1f\s]+/g, '_')
      : value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_')
    ).replace(/[. ]+$/g, '');
  if (
    !pattern.trim() ||
    /[\x00-\x1f]/.test(pattern) ||
    /\{(?!experiment\}|sample\}|material\}|state\}|mode\}|technique\}|regime\}|batch\}|run(?::0[1-9])?\})/.test(
      pattern,
    )
  )
    throw new Error(
      '命名规则支持 {experiment}、{material}、{state}、{sample}、{mode}、{technique}、{regime}、{batch} 和 {run:03}。',
    );
  // Remove only separators next to empty template fields, preserving user codes and literals.
  const template = contextual
    ? pattern
        .replace(
          /\{(material|state|mode|technique|regime|batch)\}/g,
          (token, key: keyof typeof context) => (safe(context[key] || '') ? token : '\u0001'),
        )
        .replace(/([_-]*)\u0001(?:[_-]*\u0001)*([_-]*)/g, (_, left: string, right: string) =>
          left && right ? left : '',
        )
    : pattern;
  const value = template
    .replace(/\{experiment\}/g, () => safe(experiment))
    .replace(/\{sample\}/g, () => safe(sample))
    .replace(/\{run(?::0([1-9]))?\}/g, (_, width) =>
      String(number).padStart(Number(width || 1), '0'),
    )
    .replace(/\{(material|state|mode|technique|regime|batch)\}/g, (_, key: keyof typeof context) =>
      safe(context[key] || ''),
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
