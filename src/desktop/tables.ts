import ExcelJS from 'exceljs';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import type {
  TablePreview,
  ImportKey,
  ImportRequest,
  Snapshot,
  Group,
  Field,
  RecordEvent,
} from '../shared/model.js';
import { STATUS_LABEL } from '../shared/model.js';
import { fieldSchema, validatePatch } from './validation.js';

export const IMPORT_FIELDS: { key: ImportKey; label: string; aliases: string[] }[] = [
  { key: 'state', label: '样品状态', aliases: ['样品状态', '状态'] },
  { key: 'name', label: '样品名称', aliases: ['样品名称', '样品名', '名称', '样品'] },
  { key: 'width', label: '宽度', aliases: ['宽度', '宽度/mm', '宽度（mm）'] },
  { key: 'height', label: '高度', aliases: ['高度', '长度', '高度/mm'] },
  { key: 'dimensionUnit', label: '宽高单位', aliases: ['宽高单位', '尺寸单位', '宽度单位'] },
  { key: 'preparedCount', label: '准备数量', aliases: ['准备数量', '数量', '备样数量'] },
  {
    key: 'mode',
    label: 'In situ/Ex situ',
    aliases: ['In situ/Ex situ', '原位/非原位', '实验方式'],
  },
  { key: 'priority', label: '优先级', aliases: ['优先级'] },
  { key: 'thickness', label: '厚度', aliases: ['厚度', '厚度/mm', '厚度 (mm)', '厚度（mm）'] },
  { key: 'thicknessUnit', label: '厚度单位', aliases: ['厚度单位'] },
  { key: 'notes', label: '备注', aliases: ['备注', '备注信息'] },
  {
    key: 'preparation',
    label: '制备 / 试剂名称',
    aliases: ['制备 / 试剂名称', '试剂名称', '试剂准备', '制备名称', '制备或试剂名称'],
  },
  { key: 'legacyCompleted', label: '原表完成标记', aliases: ['已完成', '原表完成标记'] },
  { key: 'legacyTime', label: '原表实验时间', aliases: ['实验时间', '原表实验时间'] },
];
export function parseDelimited(text: string, delimiter?: string): string[][] {
  text = text.replace(/^\uFEFF/, '');
  delimiter ||= text.split(/\r?\n/, 1)[0].includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [],
    value = '',
    quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index++;
      } else if (quoted || !value) quoted = !quoted;
      else value += char;
    } else if (!quoted && char === delimiter) {
      row.push(value);
      value = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else value += char;
  }
  if (quoted) throw new Error('表格文本中有未闭合的双引号。');
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}
export function previewRows(rows: string[][], name = '粘贴的表格'): TablePreview {
  const clean = rows.filter((r) => r.some((v) => v.trim()));
  if (clean.length < 2) throw new Error('请提供表头和至少一行样品记录。');
  if (clean.length > 10001) throw new Error('一次最多导入 10,000 行，请分批导入。');
  const usedHeaders = new Set<string>();
  const headers = clean[0].map((h, i) => {
    let name = h.trim() || `第 ${i + 1} 列`;
    if (usedHeaders.has(name)) name += ` [列 ${i + 1}]`;
    usedHeaders.add(name);
    return name;
  });
  if (headers.length > 100) throw new Error('一次最多读取 100 列。');
  const normalize = (v: string) => v.toLowerCase().replace(/\s/g, '');
  const mapping: Partial<Record<ImportKey, number>> = {};
  for (const field of IMPORT_FIELDS) {
    const column = headers.findIndex((h) =>
      field.aliases.some((alias) => normalize(alias) === normalize(h)),
    );
    if (column >= 0) mapping[field.key] = column;
  }
  const warnings = [
    '“数量”只表示准备数量；导入后请另行安排待测样品。',
    '原表完成标记和实验时间作为历史信息保留，不会生成操作或自动计时。',
  ];
  return { name, headers, rows: clean.slice(1), mapping, warnings };
}
export async function previewFile(path: string): Promise<TablePreview> {
  const buffer = await readFile(path);
  if (buffer.length > 20 * 1024 * 1024) throw new Error('文件超过 20 MB，请拆分后导入。');
  if (extname(path).toLowerCase() !== '.xlsx')
    return previewRows(parseDelimited(buffer.toString('utf8')), basename(path));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error('工作簿没有可读取的工作表。');
  if (worksheet.rowCount > 10001 || worksheet.columnCount > 100)
    throw new Error('工作表超过 10,000 行或 100 列，请拆分后导入。');
  const rows: string[][] = [];
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const values: string[] = [];
    for (let index = 1; index <= worksheet.columnCount; index++) {
      const cell = row.getCell(index);
      let value = cell.text;
      if (
        typeof cell.value === 'number' &&
        /^0+$/.test(cell.numFmt || '') &&
        Number.isInteger(cell.value)
      )
        value = String(cell.value).padStart(cell.numFmt.length, '0');
      if (cell.value instanceof Date) value = cell.value.toISOString();
      values.push(value);
    }
    rows.push(values);
  });
  const result = previewRows(rows, `${basename(path)} · ${worksheet.name}`);
  const definitions = workbook.getWorksheet('参数定义');
  if (definitions?.getCell('A1').text === 'LabRecordFields-v1') {
    result.customFields = [];
    if (definitions.rowCount > 52) throw new Error('参数定义超过 50 个。');
    for (let row = 3; row <= definitions.rowCount; row++) {
      const field = fieldSchema.parse(JSON.parse(definitions.getCell(row, 2).text)) as Field;
      const column = result.headers.indexOf(
        `${field.label}${field.unit ? ' / ' + field.unit : ''}`,
      );
      if (column >= 0) result.customFields.push({ column, definition: field });
    }
    result.warnings.push('检测到 LabRecord 参数定义，保留自定义字段类型、单位和空值。');
  }
  return result;
}
export function importTable(store: Store, request: ImportRequest): Snapshot {
  if (
    !request ||
    typeof request !== 'object' ||
    !request.table ||
    !Array.isArray(request.table.headers) ||
    !Array.isArray(request.table.rows)
  )
    throw new Error('导入内容无效。');
  const { table, mapping, experimentId } = request;
  if (
    table.rows.length > 10000 ||
    table.headers.length > 100 ||
    table.headers.some((h) => typeof h !== 'string' || h.length > 100) ||
    table.rows.some(
      (r) => !Array.isArray(r) || r.some((v) => typeof v !== 'string' || v.length > 50000),
    )
  )
    throw new Error('导入内容超过限制或格式不正确。');
  const validKeys = new Set(IMPORT_FIELDS.map((f) => f.key));
  for (const [key, column] of Object.entries(mapping))
    if (
      !validKeys.has(key as ImportKey) ||
      !Number.isInteger(column) ||
      column! < 0 ||
      column! >= table.headers.length
    )
      throw new Error('字段映射无效。');
  if (mapping.state === undefined && mapping.name === undefined)
    throw new Error('请选择“样品名称”或“样品状态”对应的列。');
  const mapped = Object.values(mapping);
  if (new Set(mapped).size !== mapped.length) throw new Error('一列不能同时映射到两个字段。');
  store.transaction(() => {
    const experiment = store.get('experiments', experimentId);
    const reserved = table.customFields
      ? new Set(['实验编号', '计划测试样品数', '备样数量', 'group_id'])
      : new Set<string>();
    const extras = request.keepOtherColumns
      ? table.headers.flatMap((label, column) => {
          if (mapped.includes(column) || reserved.has(label)) return [];
          const definition = table.customFields?.find((f) => f.column === column)?.definition;
          const field = definition
            ? (fieldSchema.parse(definition) as Field)
            : experiment.fields.find((f) => f.label === label && f.type === 'text' && !f.unit) ||
              ({ id: randomUUID(), label, type: 'text', unit: '', options: [] } as Field);
          const existing = experiment.fields.find((f) => f.id === field.id);
          if (existing && JSON.stringify(existing) !== JSON.stringify(field))
            throw new Error(`参数定义冲突：${field.label}。请导入新实验或先核对字段设置。`);
          return [{ column, field }];
        })
      : [];
    const fields = [
      ...new Map(
        [...experiment.fields, ...extras.map((e) => e.field)].map((f) => [f.id, f]),
      ).values(),
    ];
    if (fields.length > 50) throw new Error('自定义字段最多 50 个。');
    store.put('experiments', { ...experiment, fields });
    let imported = 0;
    for (const [index, row] of table.rows.entries()) {
      const raw = (key: ImportKey) =>
        mapping[key] === undefined ? '' : (row[mapping[key]!] || '').trim();
      if (!raw('state') && !raw('name')) {
        if (row.some((v) => v.trim()))
          throw new Error(`第 ${index + 2} 行缺少样品状态；请补齐后导入。`);
        continue;
      }
      const quantity = raw('preparedCount');
      if (quantity && (!/^\d+$/.test(quantity) || Number(quantity) > 10000))
        throw new Error(`第 ${index + 2} 行准备数量应为 0–10,000 的整数，未知时留空。`);
      const priority = raw('priority') || 'P0';
      if (!['P0', 'P1', 'P2'].includes(priority))
        throw new Error(`第 ${index + 2} 行优先级应为 P0、P1 或 P2。`);
      const modeRaw = raw('mode');
      const mode =
        !modeRaw || modeRaw === '未定'
          ? '未定'
          : /^(in\s*situ|原位)$/i.test(modeRaw)
            ? 'In situ'
            : /^(ex\s*situ|非原位)$/i.test(modeRaw)
              ? 'Ex situ'
              : null;
      if (!mode) throw new Error(`第 ${index + 2} 行实验方式无法识别：${modeRaw}。`);
      const completed = raw('legacyCompleted');
      if (
        completed &&
        !['1', '0', 'true', 'false', '是', '否', '已完成', '未完成'].includes(
          completed.toLowerCase(),
        )
      )
        throw new Error(`第 ${index + 2} 行的原表完成标记无法识别。`);
      const thicknessHeader =
        mapping.thickness === undefined ? '' : table.headers[mapping.thickness];
      const thicknessUnit =
        raw('thicknessUnit') || (/(?:\(|（|\/)mm(?:\)|）|$)/i.test(thicknessHeader) ? 'mm' : '');
      const values = Object.fromEntries(
        extras.map((e) => {
          const text = row[e.column] || '';
          const value =
            e.field.type === 'number'
              ? text.trim()
                ? Number(text)
                : null
              : e.field.type === 'select'
                ? text || null
                : text;
          return [e.field.id, value];
        }),
      );
      const patch: Partial<Group> = {
        state: raw('state') || '未指定',
        name: raw('name'),
        width: raw('width'),
        height: raw('height'),
        dimensionUnit:
          raw('dimensionUnit') ||
          (mapping.width !== undefined &&
          /(?:\(|（|\/)mm(?:\)|）|$)/i.test(table.headers[mapping.width])
            ? 'mm'
            : ''),
        preparedCount: quantity ? Number(quantity) : null,
        mode,
        priority: priority as Group['priority'],
        thickness: raw('thickness'),
        thicknessUnit,
        notes: raw('notes'),
        preparation: raw('preparation'),
        legacyCompleted: completed
          ? ['1', 'true', '是', '已完成'].includes(completed.toLowerCase())
          : null,
        legacyTime: raw('legacyTime'),
        values,
      };
      const { legacyCompleted: _legacyFlag, legacyTime: _legacyTime, ...parameters } = patch;
      validatePatch(parameters);
      store.createGroup(experimentId, patch);
      imported++;
    }
    store.event(experimentId, 'import', `导入 ${imported} 个样品组`, null, null, {
      source: table.name,
      headers: table.headers,
      mapping,
    });
  });
  return store.snapshot();
}
function localIso(time: string | null, offset: number) {
  if (!time) return '';
  const local = new Date(Date.parse(time) + offset * 60000).toISOString().slice(0, 19);
  const abs = Math.abs(offset);
  return `${local}${offset < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
export function experimentSnapshot(snapshot: Snapshot, experimentId: string): Snapshot {
  const filter = <T extends { experimentId: string }>(rows: T[]) =>
    rows.filter((r) => r.experimentId === experimentId);
  return {
    schemaVersion: 1,
    experiments: snapshot.experiments.filter((e) => e.id === experimentId),
    groups: filter(snapshot.groups),
    samples: filter(snapshot.samples),
    items: filter(snapshot.items),
    runs: filter(snapshot.runs),
    events: filter(snapshot.events),
    attachments: filter(snapshot.attachments),
  };
}
export function operationRows(
  snapshot: Snapshot,
  experimentId: string,
): (string | number | null)[][] {
  const experiment = snapshot.experiments.find((e) => e.id === experimentId)!;
  const sameField = (a: Field, b: Field) =>
    a.id === b.id && a.label === b.label && a.unit === b.unit;
  const fields = [...experiment.fields];
  for (const run of snapshot.runs.filter((r) => r.experimentId === experimentId))
    for (const field of run.snapshot.fields)
      if (!fields.some((f) => sameField(f, field))) fields.push(field);
  const header = [
    '实验编号',
    '样品状态',
    '计划样品名称',
    '实际样品名称',
    '计划宽度',
    '计划高度',
    '计划宽高单位',
    '实际宽度',
    '实际高度',
    '实际宽高单位',
    '样品编号',
    '操作',
    '状态',
    '优先级',
    '计划方式',
    '实际方式',
    '计划厚度',
    '计划厚度单位',
    '实际厚度',
    '实际厚度单位',
    '计划制备或试剂名称',
    '实际制备或试剂名称',
    '计划备注',
    '现场备注',
    '开始时间',
    '结束时间',
    '开始时间UTC',
    '结束时间UTC',
    '原始开始时间UTC',
    '原始结束时间UTC',
    '时区',
    '预期文件名',
    '实际文件名',
    '扫描编号',
    '文件引用',
    '问题记录',
    '附件',
    'sample_id',
    'plan_item_id',
    'run_id',
    '原操作ID',
    ...fields.flatMap((f) => [
      `计划 ${f.label}${f.unit ? ' / ' + f.unit : ''}`,
      `实际 ${f.label}${f.unit ? ' / ' + f.unit : ''}`,
    ]),
  ];
  const rows = snapshot.items
    .filter((i) => i.experimentId === experimentId)
    .sort((a, b) => a.order - b.order)
    .map((item) => {
      const run = snapshot.runs.find((r) => r.itemId === item.id);
      const sample = run?.snapshot.sample || snapshot.samples.find((s) => s.id === item.sampleId)!;
      const group = run?.snapshot.group || {
        ...snapshot.groups.find((g) => g.id === sample.groupId)!,
        ...sample.parameters,
      };
      const problems = snapshot.events
        .filter((e) => e.itemId === item.id && e.type === 'issue')
        .map(
          (e) =>
            `${e.createdAt} [${e.data.category}] ${e.text}${e.data.resolvedAt ? '（已处理）' : '（待处理）'}`,
        )
        .join('\n');
      const definition = run?.snapshot.fields || experiment.fields;
      return [
        experiment.code,
        group.state,
        group.name ?? null,
        run?.actualSample?.name ?? null,
        group.width ?? null,
        group.height ?? null,
        group.dimensionUnit ?? null,
        run?.actualSample?.width ?? null,
        run?.actualSample?.height ?? null,
        run?.actualSample?.dimensionUnit ?? null,
        sample.code,
        item.operation,
        STATUS_LABEL[item.status],
        group.priority,
        group.mode,
        run?.actual.mode ?? null,
        group.thickness,
        group.thicknessUnit,
        run?.actual.thickness ?? null,
        run?.actual.thicknessUnit ?? null,
        group.preparation,
        run?.actual.preparation ?? null,
        group.notes,
        run?.notes || '',
        localIso(run?.startedAt || null, run?.offsetMinutes || 0),
        localIso(run?.endedAt || null, run?.offsetMinutes || 0),
        run?.startedAt || '',
        run?.endedAt || '',
        run?.originalStartedAt || '',
        run?.originalEndedAt || '',
        run?.timezone || '',
        run?.filename || '',
        run?.actual.filename || '',
        run?.actual.scanId || '',
        run?.actual.files || '',
        problems,
        snapshot.attachments
          .filter((a) => a.runId === run?.id)
          .map((a) => a.name)
          .join('\n'),
        sample.id,
        item.id,
        run?.id || '',
        item.repeatOf || '',
        ...fields.flatMap((f) =>
          definition.some((d) => sameField(d, f))
            ? [sample.values[f.id] ?? group.values[f.id] ?? null, run?.actual[f.id] ?? null]
            : [null, null],
        ),
      ];
    });
  return [header, ...rows];
}
export function encodeCsv(rows: (string | number | null)[][]) {
  const escaped = (value: string | number | null) =>
    '"' + String(value ?? '').replaceAll('"', '""') + '"';
  return '\uFEFF' + rows.map((row) => row.map(escaped).join(',')).join('\r\n');
}
function addSheet(workbook: ExcelJS.Workbook, name: string, rows: (string | number | null)[][]) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.addRows(rows);
  sheet.getRow(1).height = 28;
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF176B62' } };
  });
  sheet.columns.forEach((column, index) => {
    column.width = /备注|问题|文件引用/.test(String(rows[0][index]))
      ? 36
      : /时间|编号|样品状态/.test(String(rows[0][index]))
        ? 24
        : 18;
  });
  sheet.eachRow((row, index) => {
    if (index > 1)
      row.eachCell((cell) => {
        cell.alignment = { vertical: 'top', wrapText: true };
        if (index % 2 === 0)
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F7F6' } };
      });
  });
  if (rows.length > 1)
    sheet.autoFilter = { from: 'A1', to: { row: rows.length, column: rows[0].length } };
}
function planningRows(snapshot: Snapshot, experimentId: string): (string | number | null)[][] {
  const experiment = snapshot.experiments.find((e) => e.id === experimentId)!;
  return [
    [
      '实验编号',
      '样品状态',
      '样品名称',
      '宽度',
      '高度',
      '宽高单位',
      '准备数量',
      '计划测试样品数',
      '备样数量',
      'In situ/Ex situ',
      '优先级',
      '厚度',
      '厚度单位',
      '制备或试剂名称',
      '备注',
      '原表完成标记',
      '原表实验时间',
      'group_id',
      ...experiment.fields.map((f) => `${f.label}${f.unit ? ' / ' + f.unit : ''}`),
    ],
    ...snapshot.groups
      .filter((g) => g.experimentId === experimentId)
      .map((g) => {
        const planned = snapshot.samples.filter((s) => s.groupId === g.id).length;
        return [
          experiment.code,
          g.state,
          g.name ?? null,
          g.width ?? null,
          g.height ?? null,
          g.dimensionUnit ?? null,
          g.preparedCount,
          planned,
          g.preparedCount === null ? null : Math.max(0, g.preparedCount - planned),
          g.mode,
          g.priority,
          g.thickness,
          g.thicknessUnit,
          g.preparation,
          g.notes,
          g.legacyCompleted === null ? '' : g.legacyCompleted ? '1' : '0',
          g.legacyTime,
          g.id,
          ...experiment.fields.map((f) => g.values[f.id] ?? null),
        ];
      }),
  ];
}
function historyRows(snapshot: Snapshot, experimentId: string): (string | number | null)[][] {
  return [
    ['时间UTC', '类型', '内容', 'plan_item_id', 'run_id', '详细信息'],
    ...snapshot.events
      .filter((e) => e.experimentId === experimentId)
      .map((e) => [e.createdAt, e.type, e.text, e.itemId, e.runId, JSON.stringify(e.data)]),
  ];
}
function attachmentRows(snapshot: Snapshot, experimentId: string): (string | number | null)[][] {
  return [
    ['run_id', '附件ID', '附件名称', '附件相对路径', '附件类型', '附件字节数', '附件SHA256'],
    ...snapshot.attachments
      .filter((a) => a.experimentId === experimentId)
      .map((a) => [a.runId, a.id, a.name, a.relativePath, a.mime, a.size, a.sha256]),
  ];
}
export function csvRows(snapshot: Snapshot, experimentId: string): (string | number | null)[][] {
  const tables = [
    { type: '样品组', rows: planningRows(snapshot, experimentId) },
    { type: '操作', rows: operationRows(snapshot, experimentId) },
    { type: '事件', rows: historyRows(snapshot, experimentId) },
    { type: '附件', rows: attachmentRows(snapshot, experimentId) },
  ];
  const columns = [...new Set(tables.flatMap((t) => t.rows[0].map(String)))];
  return [
    ['记录类型', ...columns],
    ...tables.flatMap((table) =>
      table.rows.slice(1).map((row) => {
        const values = new Map(table.rows[0].map((name, i) => [String(name), row[i]]));
        return [table.type, ...columns.map((name) => values.get(name) ?? null)];
      }),
    ),
  ];
}
export async function exportFile(
  snapshot: Snapshot,
  experimentId: string,
  format: 'xlsx' | 'csv' | 'json',
  path: string,
) {
  const experiment = snapshot.experiments.find((e) => e.id === experimentId);
  if (!experiment) throw new Error('实验不存在。');
  if (format === 'json') {
    await writeFile(
      path,
      JSON.stringify(
        {
          format: 'LabRecord',
          exportedAt: new Date().toISOString(),
          ...experimentSnapshot(snapshot, experimentId),
        },
        null,
        2,
      ),
      'utf8',
    );
    return;
  }
  const operations = operationRows(snapshot, experimentId);
  if (format === 'csv') {
    await writeFile(path, encodeCsv(csvRows(snapshot, experimentId)), 'utf8');
    return;
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'LabRecord';
  addSheet(workbook, '实验规划', planningRows(snapshot, experimentId));
  addSheet(workbook, '操作记录', operations);
  addSheet(workbook, '时间线与修改历史', historyRows(snapshot, experimentId));
  addSheet(workbook, '附件清单', attachmentRows(snapshot, experimentId));
  const definitions = workbook.addWorksheet('参数定义');
  definitions.addRows([
    ['LabRecordFields-v1'],
    ['字段ID', '定义JSON'],
    ...experiment.fields.map((f) => [f.id, JSON.stringify(f)]),
  ]);
  definitions.columns = [{ width: 38 }, { width: 100 }];
  await workbook.xlsx.writeFile(path);
}
