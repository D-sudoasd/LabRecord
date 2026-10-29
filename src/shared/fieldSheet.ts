import { MATERIAL_FIELDS } from './materials.js';
import { measurementFor, plannedGroup, regimeLabel } from './measurement.js';
import {
  MODE_LABEL,
  STATUS_LABEL,
  type Field,
  type Group,
  type PlanItem,
  type Run,
  type Sample,
  type Snapshot,
  type Value,
} from './model.js';
import {
  actualProtocolLabel,
  operationSizeLine,
  planChangeLabel,
  plannedCustomFieldValue,
  startedPlanChanges,
} from './planChanges.js';

export const LEGACY_FIELD_SHEET_HEADERS = ['简写编号', '尺寸', '原位参数', '实际样品信息'] as const;
export const FIELD_SHEET_HEADERS = [...LEGACY_FIELD_SHEET_HEADERS, '备注'] as const;

export interface FieldSheetRow {
  itemId: string;
  sampleId: string;
  status: PlanItem['status'];
  code: string;
  nameReserved: boolean;
  size: string;
  protocol: string;
  identity: string;
  /** The editable, per-measurement note; legacy run notes are shown as a fallback. */
  note: string;
  noteSource: 'field' | 'legacy-run' | 'empty';
  /** Other preserved notes with their original scope explicitly identified. */
  legacyNotes: string;
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

/** A blank key on the specimen stays blank; an absent key follows its group. */
function ownOrGroup(sample: Sample, group: Group, key: keyof Group) {
  if (Object.prototype.hasOwnProperty.call(sample.parameters, key))
    return text(sample.parameters[key]);
  return text(group[key]);
}

function uniqueLines(lines: (string | undefined)[]) {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const value = text(line);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    kept.push(value);
  }
  return kept.join('\n');
}

function customValue(value: Value | undefined, unit: string) {
  if (value == null || (typeof value === 'string' && !value.trim())) return '';
  const suffix = unit.trim();
  return `${value}${suffix ? ` ${suffix}` : ''}`;
}

function specimenIdentity(
  group: Group,
  sample: Sample,
  fields: readonly Field[],
  run?: Run,
  originalGroupName?: string,
) {
  const sampleName = text(sample.parameters.name);
  const groupName = run
    ? run.snapshot.sampleGroupName !== undefined
      ? text(run.snapshot.sampleGroupName)
      : Object.prototype.hasOwnProperty.call(sample.parameters, 'name')
        ? ''
        : text(group.name)
    : text(originalGroupName) || text(group.name);
  const state = ownOrGroup(sample, group, 'state');
  const material = ownOrGroup(sample, group, 'material');
  const parts: string[] = [];
  if (sampleName) parts.push(run ? `开始时样品名：${sampleName}` : sampleName);
  if (groupName && groupName !== sampleName) parts.push(run ? `开始时样品组：${groupName}` : groupName);
  if (state) parts.push(`${run ? '开始时状态' : '状态'}：${state}`);
  if (material && material !== sampleName && material !== groupName) parts.push(material);
  for (const field of MATERIAL_FIELDS) {
    const value = ownOrGroup(sample, group, field.key);
    if (value) parts.push(`${field.label}：${value}`);
  }
  const preparation = ownOrGroup(sample, group, 'preparation');
  if (preparation) parts.push(`制备 / 试剂名称：${preparation}`);

  for (const field of fields) {
    const label = planChangeLabel({ source: 'custom', label: field.label });
    const planned = customValue(
      plannedCustomFieldValue(sample.values, group.values, field.id),
      field.unit,
    );
    const hasActual = run && Object.prototype.hasOwnProperty.call(run.actual, field.id);
    const actual = hasActual ? customValue(run.actual[field.id], field.unit) : '';
    if (hasActual && actual.trim() !== planned.trim())
      parts.push(`实际${label}：${actual || '未填写'} · 开始时：${planned || '未填写'}`);
    else if (planned) parts.push(`${label}：${planned}`);
  }

  if (run) {
    for (const change of startedPlanChanges(run)) {
      if (change.source !== 'builtin') continue;
      if (change.key === 'name')
        parts.push(`实际样品名：${change.actual} · 开始时：${change.planned}`);
      else if (change.key === 'state')
        parts.push(`实际样品状态：${change.actual} · 开始时：${change.planned}`);
      else if (change.key === 'preparation')
        parts.push(`实际制备 / 试剂：${change.actual} · 开始时：${change.planned}`);
    }
  }
  return uniqueLines(parts);
}

export function fieldSheetNote(
  item: PlanItem,
  group: Group,
  sample: Sample,
  run?: Run,
  currentGroup?: Group,
) {
  const hasFieldNote = Object.prototype.hasOwnProperty.call(item, 'fieldNote');
  const oldRunNote = typeof run?.notes === 'string' ? run.notes : '';
  const noteSource: FieldSheetRow['noteSource'] = hasFieldNote
    ? 'field'
    : oldRunNote.trim()
      ? 'legacy-run'
      : 'empty';
  const note = hasFieldNote ? (item.fieldNote ?? '') : oldRunNote;
  const sampleNote = typeof sample.parameters.notes === 'string' ? sample.parameters.notes : '';
  const groupNote = typeof group.notes === 'string' ? group.notes : '';
  const currentGroupNote = typeof currentGroup?.notes === 'string' ? currentGroup.notes : '';
  const legacy = [
    hasFieldNote && oldRunNote.trim() ? `原现场备注：${oldRunNote}` : '',
    sampleNote.trim() ? `样品备注：${sampleNote}` : '',
    groupNote.trim() && groupNote !== sampleNote ? `样品组备注：${groupNote}` : '',
    run &&
    currentGroupNote.trim() &&
    currentGroupNote !== sampleNote &&
    currentGroupNote !== groupNote
      ? `当前样品组备注：${currentGroupNote}`
      : '',
  ].filter(Boolean);
  return { note, noteSource, legacyNotes: legacy.join('\n') };
}

/** The printed cell preserves both the current note and explicitly labelled older notes. */
export function fieldSheetNoteText(
  row: Pick<FieldSheetRow, 'note' | 'noteSource' | 'legacyNotes'>,
) {
  const main =
    row.noteSource === 'legacy-run' && row.note.trim() ? `原现场备注：${row.note}` : row.note;
  return [main, row.legacyNotes].filter((value) => value.length > 0).join('\n');
}

function protocolLines(
  snapshot: Snapshot,
  item: PlanItem,
  run: Run | undefined,
  nameReserved: boolean,
) {
  const measurement = measurementFor(snapshot, item);
  const mode = measurement.mode ? MODE_LABEL[measurement.mode] : '';
  const lines = [
    mode,
    text(measurement.technique),
    text(measurement.regime) ? regimeLabel(measurement.regime) : '',
    text(measurement.batch) ? `批次：${text(measurement.batch)}` : '',
    text(measurement.protocol) ? `制度：${text(measurement.protocol)}` : '',
    item.repeatOf ? '重测' : '',
  ];
  const changedMode = run
    ? startedPlanChanges(run).find((change) => change.source === 'builtin' && change.key === 'mode')
    : undefined;
  if (changedMode) lines.push(`实际实验方式 ${changedMode.actual} · 开始时 ${changedMode.planned}`);
  const changedProtocol = actualProtocolLabel(run);
  if (changedProtocol) lines.push(changedProtocol);
  if (!nameReserved) lines.push('文件夹名未预留');
  if (item.status !== 'pending') lines.push(`状态：${STATUS_LABEL[item.status]}`);
  return uniqueLines(lines);
}

/** One row per planned measurement. Unactivated spares have no PlanItem and no row. */
export function fieldSheetRows(snapshot: Snapshot, experimentId: string): FieldSheetRow[] {
  const fields =
    snapshot.experiments.find((experiment) => experiment.id === experimentId)?.fields ?? [];
  const groups = new Map(
    snapshot.groups
      .filter((group) => group.experimentId === experimentId)
      .map((group) => [group.id, group]),
  );
  const samples = new Map(
    snapshot.samples
      .filter((sample) => sample.experimentId === experimentId)
      .map((sample) => [sample.id, sample]),
  );
  const runs = new Map(
    snapshot.runs
      .filter((run) => run.experimentId === experimentId)
      .map((run) => [run.itemId, run]),
  );

  return snapshot.items
    .filter((item) => item.experimentId === experimentId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .flatMap((item) => {
      const run = runs.get(item.id);
      const sample = run?.snapshot.sample ?? samples.get(item.sampleId);
      if (!sample || sample.experimentId !== experimentId) return [];
      const storedGroup = run?.snapshot.group ?? groups.get(sample.groupId);
      if (!storedGroup || storedGroup.experimentId !== experimentId) return [];
      const group = run ? storedGroup : plannedGroup(storedGroup, sample, item);
      const code = run ? run.filename : (item.plannedName ?? '');
      const nameReserved = Boolean(code);
      const size = operationSizeLine(group, run);
      return [
        {
          itemId: item.id,
          sampleId: sample.id,
          status: item.status,
          code,
          nameReserved,
          size: run && size && !size.startsWith('实际 ') && !size.startsWith('开始时 ')
            ? `开始时 ${size}`
            : size,
          protocol: protocolLines(snapshot, item, run, nameReserved),
          identity: specimenIdentity(
            group,
            sample,
            run?.snapshot.fields ?? fields,
            run,
            run ? undefined : storedGroup.name,
          ),
          ...fieldSheetNote(item, storedGroup, sample, run, groups.get(sample.groupId)),
        },
      ];
    });
}

export function fieldSheetTable(snapshot: Snapshot, experimentId: string): string[][] {
  return [
    [...FIELD_SHEET_HEADERS],
    ...fieldSheetRows(snapshot, experimentId).map((row) => [
      row.code,
      row.size,
      row.protocol,
      row.identity,
      fieldSheetNoteText(row),
    ]),
  ];
}

// Logical preview rows stay one-per-measurement. These narrow widths bound their rendered height
// on A4 landscape when a single protocol or identity paragraph is exceptionally long.
// Use the narrower of the HTML/PDF and Excel column widths with generous wrap margin.
const PRINT_COLUMN_WIDTHS = [8, 9, 12, 13, 12] as const;
const PRINT_MAX_LINES = 12;

function printCharacterUnits(character: string) {
  const point = character.codePointAt(0) ?? 0;
  if (point > 0x7f) return 1;
  if (character === 'W' || character === 'M') return 1.5;
  if (character === 'w' || character === 'm') return 0.8;
  if (/[A-Z]/.test(character)) return 0.9;
  return 0.55;
}

export interface FieldSheetPrintRow {
  cells: [string, string, string, string, string];
  continuation: boolean;
  continued: boolean;
}

function printTextSegments(value: string, widthUnits: number) {
  const chunks: string[] = [];
  let chunk = '';
  let lines = 1;
  let lineUnits = 0;
  const lineBreaks = new Set(['\n', ' ', '；', ';', '，', ',', '、', '。', '|', '·']);
  const measure = (value: string) => {
    let measuredLines = 1;
    let measuredUnits = 0;
    for (const character of Array.from(value)) {
      if (character === '\n') {
        measuredLines += 1;
        measuredUnits = 0;
        continue;
      }
      const units = printCharacterUnits(character);
      if (measuredUnits + units > widthUnits) {
        measuredLines += 1;
        measuredUnits = 0;
      }
      measuredUnits += units;
    }
    return [measuredLines, measuredUnits] as const;
  };
  const flushAtBoundary = () => {
    const characters = Array.from(chunk);
    const lowerBound = Math.max(1, characters.length - 96);
    let boundary = -1;
    for (let index = characters.length - 1; index >= lowerBound; index -= 1) {
      if (lineBreaks.has(characters[index])) {
        boundary = index + 1;
        break;
      }
    }
    if (boundary <= 0) {
      flush();
      return;
    }
    chunks.push(characters.slice(0, boundary).join(''));
    chunk = characters.slice(boundary).join('');
    [lines, lineUnits] = measure(chunk);
  };
  const flush = () => {
    chunks.push(chunk);
    chunk = '';
    lines = 1;
    lineUnits = 0;
  };

  // Array.from iterates complete Unicode code points, never half of a surrogate pair.
  for (const character of Array.from(value)) {
    if (character === '\n') {
      chunk += character;
      lines += 1;
      lineUnits = 0;
      if (lines > PRINT_MAX_LINES) flushAtBoundary();
      continue;
    }
    const units = printCharacterUnits(character);
    if (lineUnits + units > widthUnits) {
      lines += 1;
      lineUnits = 0;
      if (lines > PRINT_MAX_LINES) flushAtBoundary();
    }
    chunk += character;
    lineUnits += units;
  }
  if (chunk || !chunks.length) chunks.push(chunk);
  return chunks;
}

/** Physical print rows may continue a long measurement, always repeating its exact folder name. */
export function fieldSheetPrintRows(rows: readonly FieldSheetRow[]) {
  return rows.flatMap((row) => {
    const columns = [row.size, row.protocol, row.identity, fieldSheetNoteText(row)].map(
      (value, index) => printTextSegments(value, PRINT_COLUMN_WIDTHS[index + 1]),
    );
    const count = Math.max(...columns.map((segments) => segments.length));
    return Array.from({ length: count }, (_, index) => ({
      cells: [
        row.code,
        columns[0][index] ?? '',
        columns[1][index] ?? '',
        columns[2][index] ?? '',
        columns[3][index] ?? '',
      ] as [string, string, string, string, string],
      continuation: index > 0,
      continued: count > 1,
    }));
  });
}

export function fieldSheetPrintTable(snapshot: Snapshot, experimentId: string): string[][] {
  return [
    [...FIELD_SHEET_HEADERS],
    ...fieldSheetPrintRows(fieldSheetRows(snapshot, experimentId)).map((row) => row.cells),
  ];
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Printable copy of the same rows. It does not start a run or fill an empty value. */
export function fieldSheetHtml(snapshot: Snapshot, experimentId: string) {
  const experiment = snapshot.experiments.find((entry) => entry.id === experimentId);
  const rows = fieldSheetPrintRows(fieldSheetRows(snapshot, experimentId));
  const body = rows.length
    ? rows
        .map(
          (row) => `<tr>
<td><div class="field-sheet-cell field-sheet-code">${escapeHtml(row.cells[0])}${row.continuation ? '<small class="field-sheet-continuation">（续）</small>' : ''}</div></td>
<td><div class="field-sheet-cell">${escapeHtml(row.cells[1])}</div></td>
<td><div class="field-sheet-cell">${escapeHtml(row.cells[2])}</div></td>
<td><div class="field-sheet-cell">${escapeHtml(row.cells[3])}</div></td>
<td><div class="field-sheet-cell field-sheet-note">${escapeHtml(row.cells[4])}</div></td>
</tr>`,
        )
        .join('')
    : `<tr><td colspan="5">先安排待测样品，再打印。</td></tr>`;
  const title = experiment ? `${experiment.code} ${experiment.name}` : '现场规划表';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} 现场规划表</title>
<style>
@page { size: A4 landscape; margin: 12mm; }
body { margin: 0; color: #1c2b26; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
h1 { font-size: 18px; font-weight: 650; margin: 0 0 4px; }
p { margin: 0 0 12px; color: #526e60; font-size: 12px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
table { font-size: 13px; }
col.code { width: 12%; }
col.size { width: 16%; }
col.protocol { width: 24%; }
col.identity { width: 25%; }
col.note { width: 23%; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th, td { border: 1px solid #9eb0a8; padding: 6px 8px; vertical-align: top; }
th { background: #176b62; color: white; font-weight: 650; text-align: left; }
.field-sheet-cell { white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal; min-height: 1.5em; padding-bottom: 2mm; }
.field-sheet-note { min-height: 3em; }
.field-sheet-code { font-size: 14px; font-weight: 650; }
.field-sheet-continuation { margin-left: 5px; color: #526e60; font-size: 8pt; font-weight: 400; white-space: nowrap; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>一行一项测量。文件夹名可在两台仪器电脑上使用同一编号；重测使用独立编号并保留对应的样品信息。</p>
<table>
<colgroup><col class="code"><col class="size"><col class="protocol"><col class="identity"><col class="note"></colgroup>
<thead><tr><th>简写编号</th><th>尺寸</th><th>原位参数</th><th>实际样品信息</th><th>备注</th></tr></thead>
<tbody>${body}</tbody>
</table>
</body>
</html>`;
}
