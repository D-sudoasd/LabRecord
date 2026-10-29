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
/** Two digits after the prefix: G + this pattern is G01. */
export const CODE_PATTERN_PAD = '{prefix}{n:02}';
/** Hyphen and an unpadded number: G + this pattern is G-1. */
export const CODE_PATTERN_HYPHEN = '{prefix}-{n}';
const CODE_NUMBER = /\{n(?::0([2-9]))?\}/;
export function codePatternError(pattern: string) {
  if (pattern.length > 80) return '编号样式请控制在 80 个字符内。';
  if ((pattern.match(/\{prefix\}/g) || []).length !== 1) return '编号样式需要恰好一个 {prefix}。';
  const numbers = pattern.match(/\{n(?::0[2-9])?\}/g) || [];
  if (numbers.length !== 1) return '编号样式需要恰好一个 {n} 或 {n:02}。';
  const rest = pattern.replaceAll('{prefix}', '').replace(CODE_NUMBER, '');
  if (/[{}]/.test(rest)) return '编号样式只支持 {prefix}、{n} 和 {n:02} 到 {n:09}。';
  if (/[\u0000-\u001f]/.test(pattern)) return '编号样式不能包含控制字符。';
  return '';
}
export function formatSampleCode(prefix: string, number: number, pattern: string) {
  const stem = prefix.trim() || (pattern === CODE_PATTERN_HYPHEN ? 'G' : 'S');
  const width = pattern.match(CODE_NUMBER)?.[1];
  const digits = width ? String(number).padStart(Number(width), '0') : String(number);
  const token = '\u0001';
  return pattern.replace(CODE_NUMBER, token).replaceAll('{prefix}', stem).replaceAll(token, digits);
}
export function planSpecimens(
  existing: Iterable<string>,
  count: number,
  prefix: string,
  _group: { state: string },
  pattern?: string,
) {
  const taken = new Set(Array.from(existing, (code) => code.toLowerCase()));
  const stem = prefix.trim() || (pattern === CODE_PATTERN_HYPHEN ? 'G' : 'S');
  if (pattern) {
    const error = codePatternError(pattern);
    if (error) throw new Error(error);
  }
  const width = pattern?.match(CODE_NUMBER)?.[1];
  const rows: { code: string; ordinal: string }[] = [];
  let number = 1;
  while (rows.length < count) {
    if (number > 100000) throw new Error('无法分配不重复的样品编号。');
    const ordinal = pattern
      ? width
        ? String(number).padStart(Number(width), '0')
        : String(number)
      : String(number).padStart(2, '0');
    const code = pattern ? formatSampleCode(stem, number, pattern) : stem + ordinal;
    number += 1;
    if (!code.trim() || code.length > 300 || /[\u0000-\u001f]/.test(code))
      throw new Error('这种编号样式生成的编号无效。');
    if (taken.has(code.toLowerCase())) continue;
    taken.add(code.toLowerCase());
    rows.push({ code, ordinal });
  }
  return rows;
}
/** Hand-written codes are reserved first. The rest keep the active pattern and skip taken numbers. */
export function assignSpecimenCodes(
  existing: Iterable<string>,
  count: number,
  prefix: string,
  group: { state: string },
  pattern: string | undefined,
  specimens?: readonly { code?: string }[],
) {
  const taken = new Set(Array.from(existing, (code) => code.toLowerCase()));
  const chosen: (string | undefined)[] = [];
  for (let index = 0; index < count; index += 1) {
    const raw = specimens?.[index]?.code?.trim() ?? '';
    if (!raw) {
      chosen.push(undefined);
      continue;
    }
    if (raw.length > 300 || /[\u0000-\u001f]/.test(raw))
      throw new Error('样品编号需为 1–300 个字符，且不能包含控制字符。');
    if (taken.has(raw.toLowerCase())) throw new Error(`样品编号“${raw}”在本实验中已存在。`);
    taken.add(raw.toLowerCase());
    chosen.push(raw);
  }
  const generated = planSpecimens(
    taken,
    chosen.filter((code) => !code).length,
    prefix,
    group,
    pattern,
  );
  let cursor = 0;
  return chosen.map((code) => (code ? { code, ordinal: code } : generated[cursor++]));
}
/** Prefix shared by every code when read back through the active pattern. Empty when they differ. */
export function prefixFromCodes(codes: readonly string[], pattern: string) {
  if (!codes.length || codePatternError(pattern)) return '';
  let body = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{prefix\\}', '([\\s\\S]*?)');
  const width = pattern.match(CODE_NUMBER)?.[1];
  body = width
    ? body.replace(/\\\{n:0[2-9]\\\}/, `\\d{${width},}`)
    : body.replace('\\{n\\}', '\\d+');
  const expression = new RegExp(`^${body}$`);
  const prefixes = codes.map((code) => expression.exec(code)?.[1]);
  if (prefixes.some((prefix) => prefix === undefined || prefix !== prefixes[0])) return '';
  return prefixes[0] || '';
}
export function sharedSamplePrefix(codes: readonly string[]) {
  const stems = codes.map((code) => code.replace(/\d+$/, ''));
  if (!stems.length || stems.some((stem) => !stem || stem !== stems[0])) return '';
  return stems[0];
}

export function suggestedSpecimenName(group: { name?: string; state: string }, ordinal: string) {
  return `${(group.name?.trim() || group.state).trim()}-${ordinal}`;
}
export type SpecimenInput = {
  code?: string;
  name?: string;
  protocol?: string;
  state?: string;
  notes?: string;
  fieldNote?: string;
  thickness?: string;
  thicknessUnit?: string;
  width?: string;
  height?: string;
  dimensionUnit?: string;
};
const SIZE_KEYS = ['thickness', 'thicknessUnit', 'width', 'height', 'dimensionUnit'] as const;
export function effectiveNotes(group: { notes?: string }, parameters?: { notes?: string }) {
  const own = parameters?.notes;
  if (typeof own === 'string' && own.trim()) return own;
  return group.notes ?? '';
}
export function specimenParameters(
  group: { protocol?: string; state?: string; notes?: string },
  specimen: SpecimenInput,
): Partial<Group> {
  const parameters: Partial<Group> = {};
  const name = specimen.name?.trim() ?? '';
  if (name) parameters.name = name;
  const protocol = specimen.protocol ?? '';
  if (protocol.trim() && protocol.trim() !== (group.protocol ?? '').trim())
    parameters.protocol = protocol;
  if ('state' in specimen) {
    const state = specimen.state?.trim() || group.state?.trim() || '';
    if (state) parameters.state = state;
  }
  if ('notes' in specimen && (specimen.notes ?? '').trim()) parameters.notes = specimen.notes;
  const sentSize = SIZE_KEYS.some((key) => key in specimen);
  if (sentSize) {
    for (const key of SIZE_KEYS) parameters[key] = specimen[key] ?? '';
  }
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
  /** Absent means prefix plus two digits, the same as {prefix}{n:02}. */
  sampleCodePattern?: string;
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
  /** Per-measurement note. Absent preserves the pre-v2 Run.notes fallback. */
  fieldNote?: string;
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
    /** Original sample-group label, separate from the per-specimen name merged into group. */
    sampleGroupName?: string | null;
    sample: Sample;
    operation: string;
    fields: Field[];
    measurement?: MeasurementPlan;
  };
  actual: Values;
  actualSample?: SampleDetails;
  /** Source of the relevant actual fields; missing keys mean no provenance was recorded. */
  actualSources?: ActualSources;
  notes: string;
}
export const ACTUAL_SAMPLE_KEYS = [
  'name',
  'state',
  'specimenName',
  'width',
  'height',
  'dimensionUnit',
] as const;
export const ACTUAL_VALUE_KEYS = ['thickness', 'thicknessUnit'] as const;
export type ActualSourceField =
  | `actualSample.${(typeof ACTUAL_SAMPLE_KEYS)[number]}`
  | `actual.${(typeof ACTUAL_VALUE_KEYS)[number]}`;
export type ActualSource = 'legacy' | 'planned' | 'edited';
export type ActualSources = Partial<Record<ActualSourceField, ActualSource>>;
export interface SampleDetails {
  name?: string;
  state?: string;
  /** Actual per-specimen original label; absent in records made by older versions. */
  specimenName?: string;
  width?: string;
  height?: string;
  dimensionUnit?: string;
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
  schemaVersion: 1 | 2 | 3;
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
      sampleCodePattern?: string;
      fields?: Field[];
    }
  | {
      type: 'updateExperiment';
      id: string;
      name?: string;
      description?: string;
      fields?: Field[];
      namingPattern?: string;
      sampleCodePattern?: string;
    }
  | { type: 'createGroup'; experimentId: string; patch: GroupPatch }
  | {
      type: 'addSamples';
      experimentId: string;
      patch: GroupPatch;
      count: number;
      prefix?: string;
      specimens?: SpecimenInput[];
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
      specimens?: SpecimenInput[];
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
      type: 'updateFieldRow';
      itemId: string;
      sample?: Partial<
        Pick<
          Group,
          'name' | 'state' | 'thickness' | 'thicknessUnit' | 'width' | 'height' | 'dimensionUnit'
        >
      >;
      protocol?: string;
      fieldNote?: string;
    }
  | {
      type: 'scheduleMeasurements';
      itemIds: string[];
      measurement?: MeasurementPlan;
      repetitions?: number;
    }
  | { type: 'start' | 'finish' | 'unskip' | 'repeat'; itemId: string }
  | { type: 'interrupt' | 'skip'; itemId: string; reason?: string }
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
  | { type: 'editIssue'; eventId: string; text: string }
  | { type: 'editNote'; eventId: string; text: string }
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
  copyText(text: string): Promise<Reply<null>>;
  snapshot(): Promise<Reply<Snapshot>>;
  command(command: Command, requestId: string): Promise<Reply<CommandResult>>;
  previewFile(): Promise<Reply<TablePreview | null>>;
  previewText(text: string): Promise<Reply<TablePreview>>;
  importTable(request: ImportRequest): Promise<Reply<Snapshot>>;
  exportFile(experimentId: string, format: 'xlsx' | 'csv' | 'json'): Promise<Reply<string | null>>;
  exportFieldSheet(experimentId: string, format: 'xlsx' | 'pdf'): Promise<Reply<string | null>>;
  addAttachment(runId: string): Promise<Reply<Snapshot | null>>;
  removeAttachment(attachmentId: string): Promise<Reply<Snapshot>>;
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
/** Only dimensions the user filled in. Blank sides are omitted and no unit is invented. */
export function filledSize(
  group: Pick<Group, 'thickness' | 'thicknessUnit' | 'width' | 'height' | 'dimensionUnit'>,
) {
  const part = (label: string, number: string | undefined, unit: string | undefined) => {
    const value = number?.trim();
    if (!value) return '';
    const shown = [value, unit?.trim()].filter(Boolean).join(' ');
    return `${label} ${shown}`;
  };
  return [
    part('厚', group.thickness, group.thicknessUnit),
    part('宽', group.width, group.dimensionUnit),
    part('高', group.height, group.dimensionUnit),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Fields this sample set for itself that differ from the group. Inherited blanks are omitted. */
export function sampleOverrideLabel(
  group: Pick<
    Group,
    | 'thickness'
    | 'thicknessUnit'
    | 'width'
    | 'height'
    | 'dimensionUnit'
    | 'composition'
    | 'processing'
    | 'heatTreatment'
    | 'otherTreatment'
  >,
  parameters: GroupPatch,
) {
  const differs = (own: string | undefined, shared: string | undefined) => {
    const value = own?.trim();
    return !!value && value !== (shared || '').trim();
  };
  const side = (
    label: string,
    numberKey: 'thickness' | 'width' | 'height',
    unitKey: 'thicknessUnit' | 'dimensionUnit',
    sharedUnit: string | undefined,
  ) => {
    const number = parameters[numberKey];
    const unit = parameters[unitKey];
    if (!differs(number, group[numberKey]) && !differs(unit, sharedUnit)) return '';
    const shown = [number?.trim() || group[numberKey]?.trim(), (unit || sharedUnit)?.trim()]
      .filter(Boolean)
      .join(' ');
    return shown ? `${label} ${shown}` : '';
  };
  const materials = (
    [
      ['composition', '成分'],
      ['processing', '加工工艺'],
      ['heatTreatment', '热处理制度'],
      ['otherTreatment', '其他工艺'],
    ] as const
  ).flatMap(([key, label]) =>
    differs(parameters[key], group[key]) ? [`${label}：${parameters[key]!.trim()}`] : [],
  );
  return [
    side('厚', 'thickness', 'thicknessUnit', group.thicknessUnit),
    side('宽', 'width', 'dimensionUnit', group.dimensionUnit),
    side('高', 'height', 'dimensionUnit', group.dimensionUnit),
    ...materials,
  ]
    .filter(Boolean)
    .join(' · ');
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
/** One measurement folder uses its short specimen code, without an experiment prefix. */
export const FIELD_PATTERN = '{sample}';
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
    throw new Error('数据文件夹名称包含 Windows 不支持的字符、保留名称或长度超过 200 字符。');
  return value;
}
